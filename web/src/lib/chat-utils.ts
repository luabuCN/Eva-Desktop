import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

export interface TurnUsagePartData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number;
  providerId?: string;
  modelId?: string;
}

/** 内置浏览器面板的预览目标（服务端工具通过 data-oh:preview.open 推送）。 */
export interface PreviewOpenData {
  url: string;
  kind: "file" | "server";
  label?: string;
}

/** 知识库跳转链接目标：wiki://<encodedScopeId>/<encodedPath>。 */
export interface WikiLinkTarget {
  scopeId: string;
  path: string;
}

/** 解析知识库跳转链接。标准形式 /wiki/<scope>/<path>（以 / 开头才能通过
 * rehype-harden 的 URL 检查）；兼容旧的 wiki/ 与 wiki:// 前缀。 */
export function parseWikiHref(href: string): WikiLinkTarget | null {
  let rest: string | null = null;
  if (href.startsWith("/wiki/")) rest = href.slice("/wiki/".length);
  else if (href.startsWith("wiki://")) rest = href.slice("wiki://".length);
  else if (href.startsWith("wiki/")) rest = href.slice("wiki/".length);
  if (rest === null) return null;
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  try {
    const scopeId = decodeURIComponent(rest.slice(0, slash));
    const path = rest
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    if (!scopeId || !path) return null;
    return { scopeId, path };
  } catch {
    return null;
  }
}

/** 委派子智能体的直播事件（data-oh:subagent.*，由 DelegationHub 推送）。 */
export interface SubagentEventData {
  kind: "start" | "progress" | "done" | "error";
  delegationId: string;
  agentName: string;
  task?: string;
  steps?: number;
  currentTool?: string;
  status?: "completed" | "aborted" | "stopped";
  durationMs?: number;
  error?: string;
}

/** 回合结束时推送的修改/产物汇总（data-oh:changes），渲染成可点击预览的
 * "文件已更改"卡片。 */
export interface TurnChangesData {
  files: Array<{
    /** 工作区相对路径（正斜杠），卡片展示用。 */
    path: string;
    /** 绝对路径，点击条目时交给预览面板。 */
    absolutePath: string;
    changeKind: "create" | "edit" | "delete" | "artifact";
    additions: number;
    deletions: number;
  }>;
}

export type ChatUIMessage = UIMessage<
  unknown,
  {
    "oh:todo.updated": { todos: TodoItem[] };
    "oh:turn.done": { durationMs: number };
    "oh:usage": TurnUsagePartData;
    "oh:subagent.start": SubagentEventData;
    "oh:subagent.progress": SubagentEventData;
    "oh:subagent.done": SubagentEventData;
    "oh:subagent.error": SubagentEventData;
    "oh:compaction.done": { messagesRemoved: number };
    "oh:retry": { attempt: number; reason: string };
    "oh:preview.open": PreviewOpenData;
    "oh:changes": TurnChangesData;
  }
>;

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export interface ToolCallRef {
  id: string;
  name: string;
  part: ToolPart;
}

export function toolNameOf(part: ToolPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
}

export function collectToolCalls(messages: ChatUIMessage[]): ToolCallRef[] {
  const calls: ToolCallRef[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part)) {
        calls.push({ id: part.toolCallId, name: toolNameOf(part), part });
      }
    }
  }
  return calls;
}

export function latestTodos(messages: ChatUIMessage[]): TodoItem[] {
  let todos: TodoItem[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-oh:todo.updated") {
        todos = part.data.todos;
      }
    }
  }
  return todos;
}

export interface UsageStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  turns: number;
  totalTurnMs: number;
  subagents: number;
  compactions: number;
  messagesRemoved: number;
}

export function collectUsage(messages: ChatUIMessage[]): UsageStats {
  const stats: UsageStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    turns: 0,
    totalTurnMs: 0,
    subagents: 0,
    compactions: 0,
    messagesRemoved: 0,
  };

  for (const message of messages) {
    if (message.role === "user") stats.userMessages += 1;
    if (message.role === "assistant") stats.assistantMessages += 1;

    for (const part of message.parts) {
      if (isToolUIPart(part)) stats.toolCalls += 1;
      if (part.type === "data-oh:turn.done") {
        stats.turns += 1;
        stats.totalTurnMs += part.data.durationMs;
      }
      if (part.type === "data-oh:subagent.done") stats.subagents += 1;
      if (part.type === "data-oh:compaction.done") {
        stats.compactions += 1;
        stats.messagesRemoved += part.data.messagesRemoved;
      }
    }
  }

  return stats;
}

export function messageText(message: ChatUIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 定时任务注入的 <cron-context> 块（消息开头，含 cron_name 等元数据）。 */
export interface CronContextInfo {
  cronName?: string;
  startedAt?: string;
}

const CRON_CONTEXT_RE = /^[ \t]*<cron-context>([\s\S]*?)<\/cron-context>[ \t]*\n?/;

function parseCronContext(body: string): CronContextInfo {
  const info: CronContextInfo = {};
  const name = body.match(/^cron_name:[ \t]*(.+)$/m);
  if (name) info.cronName = name[1].trim();
  const started = body.match(/^started_at:[ \t]*(.+)$/m);
  if (started) info.startedAt = started[1].trim();
  return info;
}

/**
 * 拆出文本开头的 <cron-context> 块：展示层用它把原始标记替换为主题色
 * 徽标。块内是给模型的运行元数据，不应原样出现在气泡里。
 */
export function splitCronContext(text: string): {
  context: CronContextInfo | null;
  text: string;
} {
  const match = text.match(CRON_CONTEXT_RE);
  if (!match) return { context: null, text };
  return { context: parseCronContext(match[1]), text: text.slice(match[0].length) };
}

/** 剥离文本里所有 <cron-context> 块（模型偶尔会复述，气泡里同样不展示）。 */
export function stripCronContext(text: string): string {
  return text.replace(/<cron-context>[\s\S]*?<\/cron-context>[ \t]*\n?/g, "").trimStart();
}

/** Whether the most recent assistant message carries any non-empty text part —
 * a turn that ended with tool calls only gets a "no summary" note. */
export function lastAssistantHasText(messages: ChatUIMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.parts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    );
  }
  return true;
}

export interface UsageSummary {
  /** 最近一次回合的用量（上下文占用以它为准）。 */
  latest: TurnUsagePartData | undefined;
  /** 会话累计。 */
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    durationMs: number;
    turns: number;
  };
}

export function collectUsageSummary(messages: ChatUIMessage[]): UsageSummary {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: 0,
    turns: 0,
  };
  let latest: TurnUsagePartData | undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-oh:usage") continue;
      latest = part.data;
      totals.turns += 1;
      totals.inputTokens += part.data.inputTokens;
      totals.outputTokens += part.data.outputTokens;
      totals.totalTokens += part.data.totalTokens;
      totals.cacheReadTokens += part.data.cacheReadTokens;
      totals.cacheWriteTokens += part.data.cacheWriteTokens;
      totals.reasoningTokens += part.data.reasoningTokens;
      totals.durationMs += part.data.durationMs;
    }
  }
  return { latest, totals };
}

export interface ToolTokenSummary {
  toolName: string;
  callCount: number;
  totalTokens: number;
}

/** 估算每个工具调用占用的上下文 token：序列化长度 / 4（与 PI-Desktop 同一启发式）。 */
export function collectToolTokenUsage(
  messages: ChatUIMessage[],
): ToolTokenSummary[] {
  const groups = new Map<string, ToolTokenSummary>();
  const estimate = (value: unknown): number => {
    let text: string;
    if (typeof value === "string") text = value;
    else {
      try {
        text = JSON.stringify(value) ?? "";
      } catch {
        text = String(value);
      }
    }
    return Math.ceil(text.length / 4);
  };
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const name = toolNameOf(part);
      const argumentTokens = estimate("input" in part ? part.input : undefined);
      const resultTokens = estimate("output" in part ? part.output : undefined);
      const existing = groups.get(name);
      if (existing) {
        existing.callCount += 1;
        existing.totalTokens += argumentTokens + resultTokens;
      } else {
        groups.set(name, {
          toolName: name,
          callCount: 1,
          totalTokens: argumentTokens + resultTokens,
        });
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
