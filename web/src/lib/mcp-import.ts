import type { McpServerInput } from "@/api";

/**
 * 粘贴 MCP JSON 配置 → 服务器草稿（参考 PI-Desktop 的 mcp-import）。
 * 各家 MCP 客户端写出的都是同一份 JSON 的变体，粘贴框直接接受用户已有
 * 的配置而不是让他们重填：完整的 {"mcpServers": {...}} 文档、里面的裸
 * 映射、或单个服务器对象。键名成为标识符，command/args/env 即 stdio，
 * url 即 http。
 */

export type McpImportDraft = McpServerInput & { id: string };

export interface McpImportResult {
  servers: McpImportDraft[];
  /** 能看懂但被拒绝的条目及原因。 */
  skipped: Array<{ id: string; reason: string }>;
}

const MAX_ENTRIES = 32;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** 配置键名 → 服务端可接受的标识符（字母开头，[A-Za-z0-9_-]，≤64）。 */
function importId(key: string, index: number): string {
  const cleaned = key
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `server-${index + 1}`;
}

function toDraft(id: string, key: string, raw: Record<string, unknown>): McpImportDraft | string {
  // 展示名优先用户写的 label，其次原始键名（键名可能被清洗成 server-N，
  // 那种情况下用原名做展示名才不丢信息）。
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : key.trim() || id;
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  // type/transport 只是提示：条目实际携带什么才作数，一半的在野配置根本没写。
  const declared =
    typeof raw.type === "string"
      ? raw.type.toLowerCase()
      : typeof raw.transport === "string"
        ? raw.transport.toLowerCase()
        : "";
  const wantsHttp = url ? true : declared.includes("http") || declared.includes("sse");
  if (wantsHttp) {
    if (!url) return "http 服务器需要 url";
    return {
      id,
      label,
      ...(description ? { description } : {}),
      transport: "http",
      url,
      headers: stringMap(raw.headers) ?? {},
    };
  }
  if (!command) return "stdio 服务器需要 command";
  return {
    id,
    label,
    ...(description ? { description } : {}),
    transport: "stdio",
    command,
    args: stringList(raw.args) ?? [],
    env: stringMap(raw.env) ?? {},
  };
}

/** 裸的单服务器对象（而不是一堆服务器的映射）。 */
function isServerLike(root: Record<string, unknown>): boolean {
  return (
    typeof root.command === "string" ||
    typeof root.url === "string" ||
    typeof root.transport === "string"
  );
}

/**
 * 宽松 JSON 解析：按原样 parse，失败时修复两种常见粘贴形态——
 * 对象/数组里多写的尾逗号（{"a":1,}），以及从大配置里只复制出来的
 * 单个键值对片段（"名称": {...},，没有外层花括号）。全部失败才报错，
 * 返回的 error 是第一个候选的报错信息。
 */
export function parseLooseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const first: { error: string } = { error: "" };
  const attempt = (candidate: string) => {
    try {
      return { ok: true as const, value: JSON.parse(candidate) };
    } catch (error) {
      if (!first.error) first.error = error instanceof Error ? error.message : String(error);
      return null;
    }
  };

  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "内容为空" };

  const direct = attempt(trimmed);
  if (direct) return direct;

  const noTrailingComma = trimmed.replace(/,(\s*[}\]])/g, "$1");
  if (noTrailingComma !== trimmed) {
    const repaired = attempt(noTrailingComma);
    if (repaired) return repaired;
  }

  if (/^["{[]/.test(noTrailingComma)) {
    const wrapped = attempt(`{${noTrailingComma.replace(/,+\s*$/, "")}}`);
    if (wrapped) return wrapped;
  }

  return { ok: false, error: first.error };
}

export function parseMcpImport(text: string): McpImportResult {
  const parsed = parseLooseJson(text);
  if (!parsed.ok) {
    throw new Error(
      `不是有效的 JSON：${parsed.error}。请粘贴完整对象，例如 {"mcpServers": {...}}，或单个服务器片段（会自动补全外层花括号）`,
    );
  }
  const root = asRecord(parsed.value);
  if (!root) throw new Error("需要一个 JSON 对象");

  // {"mcpServers": {...}} / {"servers": {...}} / 裸映射 / 单服务器对象。
  const container =
    asRecord(root.mcpServers) ?? asRecord(root.servers) ?? (isServerLike(root) ? null : root);
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (container) {
    for (const [key, value] of Object.entries(container)) {
      const record = asRecord(value);
      if (record) entries.push([key, record]);
    }
  } else {
    entries.push([typeof root.id === "string" ? root.id : "server", root]);
  }
  if (entries.length === 0) throw new Error("没有找到 MCP 服务器");

  const servers: McpImportDraft[] = [];
  const skipped: McpImportResult["skipped"] = [];
  entries.slice(0, MAX_ENTRIES).forEach(([key, raw], index) => {
    const id = importId(key, index);
    if (raw.disabled === true) {
      skipped.push({ id, reason: "标记为 disabled" });
      return;
    }
    const result = toDraft(id, key, raw);
    if (typeof result === "string") skipped.push({ id, reason: result });
    else servers.push(result);
  });
  for (const [key] of entries.slice(MAX_ENTRIES)) {
    skipped.push({ id: key, reason: `超过单次导入 ${MAX_ENTRIES} 个的上限` });
  }
  return { servers, skipped };
}
