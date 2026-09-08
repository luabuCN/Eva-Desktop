import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "../db.js";

/**
 * MCP 服务器连接管理（参考 PI-Desktop 的 UserMcpRuntime）：
 * 记录归 Prisma 所有，这里只负责进程与连接。服务器在首次需要时连接，
 * 工具列表连接后缓存；配置变更 / 停用 / 删除时关闭连接——过期的工具列表
 * 比缺失的工具列表更糟。
 */

export type McpTransport = "stdio" | "http";

export interface McpServerRecord {
  id: string;
  label: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type McpServerState = "idle" | "connecting" | "ready" | "failed";

export interface McpServerStatus {
  serverId: string;
  state: McpServerState;
  toolCount: number;
  message?: string;
  toolNames?: string[];
  updatedAt: number;
}

/** 一个已连接服务器贡献的工具（名字是模型实际调用的全名）。 */
export interface McpToolInfo {
  fullName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** 同时存活的连接上限（同 PI-Desktop：超过说明是配置问题而非限额问题）。 */
const MAX_ACTIVE_SERVERS = 16;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Entry {
  record: McpServerRecord;
  client: Client | null;
  tools: McpToolInfo[];
  status: McpServerStatus;
  /** 进行中的连接请求；避免 run 装配与测试按钮同时触发两次握手。 */
  connecting: Promise<McpToolInfo[]> | null;
}

/** 模型可调用的函数名约束：字母开头，[A-Za-z0-9_-]，总长 ≤ 64。 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
}

function buildToolName(serverId: string, toolName: string, used: Set<string>): string {
  const base = `mcp__${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`.slice(0, 64);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `-${suffix++}`;
    candidate = base.slice(0, 64 - tail.length) + tail;
  }
  used.add(candidate);
  return candidate;
}

function parseJsonMap(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseArgs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function toRecord(row: {
  id: string;
  label: string;
  description: string | null;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  enabled: boolean;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): McpServerRecord {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command,
    args: parseArgs(row.args),
    env: parseJsonMap(row.env),
    url: row.url,
    headers: parseJsonMap(row.headers),
    enabled: row.enabled,
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 连接参数指纹：变化即需要重新握手。 */
function fingerprint(record: McpServerRecord): string {
  return JSON.stringify([
    record.transport,
    record.command,
    record.args,
    record.env,
    record.url,
    record.headers,
  ]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function idleStatus(serverId: string): McpServerStatus {
  return { serverId, state: "idle", toolCount: 0, updatedAt: Date.now() };
}

class McpManager {
  private entries = new Map<string, Entry>();
  private toolIndex = new Map<string, { serverId: string; toolName: string }>();
  private projectRoots = new Map<string, string>();

  /** 重新读取数据库记录：变更或消失的连接立即关闭，新记录以 idle 入表。 */
  async refresh(): Promise<void> {
    const [rows, projects] = await Promise.all([
      prisma.mcpServer.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.project.findMany({ select: { id: true, rootPath: true } }),
    ]);
    this.projectRoots = new Map(projects.map((project) => [project.id, project.rootPath]));

    // 项目删除后残留的项目级服务器（SQLite 外键未开启时级联不生效）一并清掉。
    const liveIds = new Set(projects.map((project) => project.id));
    const orphans = rows.filter((row) => row.projectId && !liveIds.has(row.projectId));
    for (const orphan of orphans) {
      await prisma.mcpServer.delete({ where: { id: orphan.id } }).catch(() => undefined);
    }
    const live = rows.filter((row) => !orphans.some((orphan) => orphan.id === row.id));

    const records = new Map(live.map((row) => [row.id, toRecord(row)]));
    for (const [id, entry] of [...this.entries]) {
      const next = records.get(id);
      if (!next || fingerprint(next) !== fingerprint(entry.record) || next.enabled !== entry.record.enabled) {
        this.closeEntry(entry);
        this.entries.delete(id);
        continue;
      }
      entry.record = next;
    }
    for (const [id, record] of records) {
      if (!this.entries.has(id)) {
        this.entries.set(id, {
          record,
          client: null,
          tools: [],
          status: idleStatus(id),
          connecting: null,
        });
      }
    }
    this.rebuildToolIndex();
  }

  listRecords(): McpServerRecord[] {
    return [...this.entries.values()].map((entry) => entry.record);
  }

  statuses(): McpServerStatus[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.status }));
  }

  statusOf(serverId: string): McpServerStatus {
    return this.entries.get(serverId)
      ? { ...this.entries.get(serverId)!.status }
      : idleStatus(serverId);
  }

  /** 某服务器当前缓存的全名工具列表（未连接为空）。 */
  serverToolsOf(serverId: string): McpToolInfo[] {
    return this.entries.get(serverId)?.tools.map((tool) => ({ ...tool })) ?? [];
  }

  /** 强制重连并返回状态（设置页「测试连接」按钮）。 */
  async test(serverId: string): Promise<McpServerStatus> {
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`未找到 MCP 服务器：${serverId}`);
    this.closeEntry(entry);
    await this.connect(entry).catch(() => undefined);
    return { ...entry.status };
  }

  /** 对某个项目可见的服务器：全局级 + 该项目的项目级，且已启用。 */
  private visibleFor(projectId?: string | null): Entry[] {
    return [...this.entries.values()].filter(
      (entry) =>
        entry.record.enabled &&
        (entry.record.projectId === null || entry.record.projectId === projectId),
    );
  }

  /**
   * 连接所有可见服务器并导出工具列表（运行装配入口）。慢的或坏的服务器
   * 不能阻塞回合：每个握手各自限时，失败只记状态不抛出。
   */
  async toolsForProject(projectId?: string | null): Promise<Array<{ server: McpServerRecord; tools: McpToolInfo[] }>> {
    const visible = this.visibleFor(projectId).slice(0, MAX_ACTIVE_SERVERS);
    await Promise.all(visible.map((entry) => this.connect(entry).catch(() => [])));
    return visible.map((entry) => ({ server: entry.record, tools: entry.tools }));
  }

  /** 启动后台预热：只连全局级启用服务器，让状态页和工具目录尽快可用。 */
  async warmUp(): Promise<void> {
    await this.refresh();
    const globalEntries = [...this.entries.values()].filter(
      (entry) => entry.record.enabled && entry.record.projectId === null && !entry.client,
    );
    await Promise.allSettled(globalEntries.map((entry) => this.connect(entry)));
  }

  async callTool(fullName: string, args: Record<string, unknown>): Promise<unknown> {
    const indexed = this.toolIndex.get(fullName);
    if (!indexed) throw new Error(`未知 MCP 工具：${fullName}`);
    const entry = this.entries.get(indexed.serverId);
    if (!entry) throw new Error(`MCP 服务器已失效：${indexed.serverId}`);
    if (!entry.client) await this.connect(entry);
    const client = entry.client;
    if (!client) throw new Error(entry.status.message || `MCP 服务器未连接：${entry.record.label}`);
    const result = await client.callTool(
      { name: indexed.toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    return normalizeCallResult(result);
  }

  lookupTool(fullName: string): { serverId: string; toolName: string } | undefined {
    return this.toolIndex.get(fullName);
  }

  closeAll(): void {
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.entries.clear();
    this.toolIndex.clear();
  }

  // -------------------------------------------------------------------
  // 连接建立
  // -------------------------------------------------------------------

  private async connect(entry: Entry): Promise<McpToolInfo[]> {
    if (entry.client && entry.status.state === "ready") return entry.tools;
    if (entry.connecting) return entry.connecting;

    entry.status = {
      serverId: entry.record.id,
      state: "connecting",
      toolCount: 0,
      updatedAt: Date.now(),
    };
    entry.connecting = this.handshake(entry).finally(() => {
      entry.connecting = null;
    });
    return entry.connecting;
  }

  private async handshake(entry: Entry): Promise<McpToolInfo[]> {
    const { record } = entry;
    const client = new Client(
      { name: "openharness-desktop", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await withTimeout(this.openTransport(client, record), CONNECT_TIMEOUT_MS);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS);
      const tools = (listed.tools ?? []) as McpTool[];
      const used = new Set<string>();
      entry.tools = tools.map((tool) => ({
        fullName: buildToolName(record.id, tool.name, used),
        toolName: tool.name,
        description:
          tool.description?.trim() ||
          `${record.label} 工具 "${tool.name}"（MCP）`,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object" as const, properties: {} },
      }));
      entry.client = client;
      entry.status = {
        serverId: record.id,
        state: "ready",
        toolCount: entry.tools.length,
        toolNames: entry.tools.map((tool) => tool.toolName).slice(0, 50),
        updatedAt: Date.now(),
      };
      this.rebuildToolIndex();
      return entry.tools;
    } catch (error) {
      await client.close().catch(() => undefined);
      entry.client = null;
      entry.tools = [];
      entry.status = {
        serverId: record.id,
        state: "failed",
        toolCount: 0,
        message: errorMessage(error),
        updatedAt: Date.now(),
      };
      this.rebuildToolIndex();
      return [];
    }
  }

  private async openTransport(client: Client, record: McpServerRecord): Promise<void> {
    if (record.transport === "stdio") {
      const command = record.command?.trim();
      if (!command) throw new Error("stdio 服务器缺少启动命令");
      const cwd = record.projectId ? this.projectRoots.get(record.projectId) : undefined;
      const transport = new StdioClientTransport({
        command,
        args: record.args,
        // SDK 默认只继承白名单环境变量；用户显式配置的 env 覆盖默认值。
        env: { ...getDefaultEnvironment(), ...record.env },
        ...(cwd ? { cwd } : {}),
      });
      await client.connect(transport);
      return;
    }
    const url = record.url?.trim();
    if (!url) throw new Error("http 服务器缺少 URL");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`无效的 MCP URL：${url}`);
    }
    if (parsed.protocol !== "https:" && !isLoopback(parsed)) {
      throw new Error("http 传输仅允许 https 或本机回环地址");
    }
    const headers = record.headers;
    try {
      // 先试 Streamable HTTP，再回退到旧版 SSE 端点。
      const streamable = new StreamableHTTPClientTransport(parsed, {
        requestInit: { headers },
      });
      await client.connect(streamable);
      return;
    } catch {
      await client.close().catch(() => undefined);
    }
    const sse = new SSEClientTransport(parsed, {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input, init) => fetch(input, { ...init, headers }),
      },
    });
    await client.connect(sse);
  }

  private closeEntry(entry: Entry): void {
    entry.connecting = null;
    entry.tools = [];
    if (entry.client) {
      void entry.client.close().catch(() => undefined);
      entry.client = null;
    }
    entry.status = idleStatus(entry.record.id);
  }

  private rebuildToolIndex(): void {
    const index = new Map<string, { serverId: string; toolName: string }>();
    for (const entry of this.entries.values()) {
      for (const tool of entry.tools) {
        index.set(tool.fullName, { serverId: entry.record.id, toolName: tool.toolName });
      }
    }
    this.toolIndex = index;
  }
}

function isLoopback(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

/** CallToolResult → 模型友好的纯数据：文本块合并，非文本块计数说明。 */
function normalizeCallResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const { content, isError, structuredContent } = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  let skipped = 0;
  for (const block of content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else skipped += 1;
  }
  if (skipped > 0) parts.push(`（${skipped} 个非文本内容块已省略）`);
  return {
    ...(parts.length > 0 ? { text: parts.join("\n") } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`连接超时（${ms / 1000}s）`)), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const mcpManager = new McpManager();
