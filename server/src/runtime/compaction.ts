import { prisma } from "../db.js";
import type { ChatUIMessage } from "../chat-types.js";

/**
 * 会话上下文压缩（turn-boundary compaction）：
 *
 * TokenLimiterProcessor 的硬截断会在长会话里静默丢弃最老的消息，导致
 * 模型"失忆"。这里在每回合开始、进入模型之前做一层软压缩——估算 token
 * 超过阈值时，把较早的消息交给会话模型总结成一份持久摘要（会话级压缩
 * 点，ConversationCompaction 表），模型副本变为「摘要 + 近期消息」。
 *
 * 三条边界约束：
 * - 只改模型副本：UI 历史、runEvent 回放、wiki 总结的 fromSeq/toSeq 都
 *   基于完整消息数组，不受影响；摘要消息永不出现在持久化历史里。
 * - 压缩点按消息 id 锚定（下标兜底）：StoredMessage 每次保存全量重写、
 *   sequence = 数组下标，但应用是追加式的，id 是稳定身份。
 * - 失败兜底：任何异常都退回未压缩副本，由 TokenLimiterProcessor 硬截
 *   断兜底，绝不阻塞运行。
 */

/** 已持久化的压缩点：summary 覆盖 boundaryMessageId 之前的全部消息。 */
export interface CompactionRecord {
  boundaryMessageId: string;
  upToSeq: number;
  summary: string;
}

// —— 配额（相对 config.contextWindow）——
/** 触发阈值：估算 token 超过（窗口 − 系统预留）× 该比例时压缩。 */
const TRIGGER_RATIO = 0.72;
/** 系统提示 + 工具 schema + 技能目录的 token 预留（触发估算只看消息侧）。 */
const SYSTEM_RESERVE_TOKENS = 12_000;
/** 压缩后保留的近期消息 token 预算（窗口 × 比例）。 */
const TAIL_RATIO = 0.25;
/** 摘要正文硬上限（字符）。 */
const SUMMARY_MAX_CHARS = 24_000;
/** 总结输入中单条消息的渲染上限（字符）。 */
const MESSAGE_RENDER_CAP = 2_000;
/** 总结输入总预算（字符）：超限时从最新往回保留。 */
const SUMMARIZER_CHAR_BUDGET = 300_000;
/** 每条消息的结构开销（role / id / part 骨架）估算。 */
const MESSAGE_OVERHEAD_TOKENS = 32;

/** 粗估 token：CJK 字符 ≈1.1 token/字，其余 ≈3.5 字符/token。宁高勿低。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk * 1.1 + other / 3.5);
}

/** 单条 UI 消息的 token 估算：文本部分走估算器，其余部分按 JSON 长度折算。 */
export function estimateMessageTokens(message: ChatUIMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const part of message.parts) {
    if (part.type === "text") {
      total += estimateTokens(part.text ?? "");
    } else {
      total += estimateTokens(JSON.stringify(part) ?? "");
    }
  }
  return total;
}

/** 定位既有压缩边界在当前消息数组中的下标；id 匹配不到时按序号兜底。 */
export function resolveBoundaryIndex(
  messages: ChatUIMessage[],
  record?: CompactionRecord,
): number {
  if (!record) return 0;
  const byId = messages.findIndex((message) => message.id === record.boundaryMessageId);
  if (byId >= 0) return byId;
  return Math.min(Math.max(record.upToSeq, 0), messages.length);
}

export interface CompactionPlan {
  /** 尾部从该下标开始保留。 */
  boundary: number;
  /** 本次要总结的消息区间（上一个压缩点 .. boundary）。 */
  toSummarize: ChatUIMessage[];
}

/**
 * 判断是否需要压缩并给出切割边界。不需要（未过阈值 / 推进不出新的可
 * 总结区间，如窗口过小）时返回 null，调用方维持现状。
 */
export function planCompaction(
  messages: ChatUIMessage[],
  previous: CompactionRecord | undefined,
  contextWindow: number,
): CompactionPlan | null {
  if (messages.length === 0) return null;
  const prevIndex = resolveBoundaryIndex(messages, previous);
  const summaryTokens = previous ? estimateTokens(previous.summary) : 0;
  const liveTokens = messages
    .slice(prevIndex)
    .reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const threshold = Math.max((contextWindow - SYSTEM_RESERVE_TOKENS) * TRIGGER_RATIO, 1);
  if (summaryTokens + liveTokens <= threshold) return null;

  // 从末尾回收尾部预算：最后一条永远保留，之前的消息装不下就进摘要。
  const tailBudget = Math.max(contextWindow * TAIL_RATIO, 2_000);
  let boundary = messages.length;
  let used = 0;
  for (let index = messages.length - 1; index >= prevIndex; index -= 1) {
    const cost = estimateMessageTokens(messages[index]!);
    if (boundary < messages.length && used + cost > tailBudget) break;
    used += cost;
    boundary = index;
  }
  // 推进不出新的可总结区间（窗口过小等）：放弃本次压缩，交给硬截断兜底。
  if (boundary <= prevIndex) return null;
  return { boundary, toSummarize: messages.slice(prevIndex, boundary) };
}

function truncateForRender(text: string): string {
  return text.length > MESSAGE_RENDER_CAP
    ? `${text.slice(0, MESSAGE_RENDER_CAP)}…（截断）`
    : text;
}

/** 单条消息压成总结输入用的文本：文本全文、工具调用留结论、跳过思考。 */
function renderMessage(message: ChatUIMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text) chunks.push(part.text);
    } else if (part.type.startsWith("tool-")) {
      const name = part.type.slice("tool-".length);
      const detail = part as { input?: unknown; output?: unknown };
      const payload = detail.output ?? detail.input ?? "";
      const text =
        typeof payload === "string" ? payload : JSON.stringify(payload) ?? "";
      chunks.push(`[调用工具 ${name}] ${truncateForRender(text)}`);
    } else if (part.type === "reasoning") {
      continue;
    } else {
      chunks.push(`[${part.type}]`);
    }
  }
  return truncateForRender(chunks.join("\n"));
}

/** 组装总结 prompt：此前摘要（融合而非丢弃）+ 待压缩对话稿（预算从新往旧）。 */
export function renderSummarizerInput(
  previous: CompactionRecord | undefined,
  toSummarize: ChatUIMessage[],
): string {
  const blocks = toSummarize.map((message) =>
    [`【${message.role === "user" ? "用户" : "助手"}】`, renderMessage(message)].join("\n"),
  );
  const kept: string[] = [];
  let budget = SUMMARIZER_CHAR_BUDGET;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]!.length > budget) break;
    budget -= blocks[index]!.length;
    kept.unshift(blocks[index]!);
  }
  const transcript = [
    ...(kept.length < blocks.length ? ["…（更早内容已省略）"] : []),
    ...kept,
  ].join("\n\n");
  return [
    previous
      ? `# 此前已压缩的摘要（融合进新摘要，不要丢弃其中已记录的关键信息）\n${previous.summary}`
      : "",
    `# 待压缩的对话记录（${toSummarize.length} 条消息）`,
    transcript,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const COMPACTION_SYSTEM_PROMPT = `You maintain the working memory of an in-progress AI assistant conversation. Older messages are being compacted so the conversation can continue inside the model's context window.

Write a dense summary that lets the assistant continue the work seamlessly. Use the same language as the conversation. Structure it with these sections:

- 任务与目标 (Task & goal): what the user is trying to accomplish and the stated requirements.
- 关键决策与约束 (Decisions & constraints): choices already made, conventions, user preferences, things to avoid.
- 已完成的工作 (Work done): files read/created/edited (exact paths), commands run and their outcomes, findings, answers given.
- 未完成与下一步 (Open items & next steps): pending questions, blocked tasks, agreed next steps.

Rules:
- Merge and preserve the previous summary's information; never drop a decision, file path, or open item it mentions.
- Prefer specifics (paths, names, values, error messages) over prose.
- For tool calls keep only their conclusions (what was found or changed), not raw output dumps.
- Do not invent facts; mark uncertain items as uncertain.
- Keep the summary under ~1200 words.`;

/** 组装模型副本：摘要消息 + 边界之后的消息。摘要只存在于模型副本里。 */
export function applyCompaction(
  messages: ChatUIMessage[],
  record: CompactionRecord,
): ChatUIMessage[] {
  const boundary = resolveBoundaryIndex(messages, record);
  if (boundary <= 0) return messages;
  const summaryMessage: ChatUIMessage = {
    id: "compaction-summary",
    role: "user",
    parts: [
      {
        type: "text",
        text:
          "[Conversation context: earlier messages were compacted into the summary below. " +
          "Treat it as accurate prior context and continue from the recent messages that follow.]\n\n" +
          record.summary,
      },
    ],
  };
  return [summaryMessage, ...messages.slice(boundary)];
}

export async function loadCompactionRecord(
  conversationId: string,
): Promise<CompactionRecord | undefined> {
  const row = await prisma.conversationCompaction.findUnique({
    where: { conversationId },
  });
  if (!row) return undefined;
  return {
    boundaryMessageId: row.boundaryMessageId,
    upToSeq: row.upToSeq,
    summary: row.summary,
  };
}

export async function saveCompactionRecord(
  conversationId: string,
  record: CompactionRecord,
): Promise<void> {
  await prisma.conversationCompaction.upsert({
    where: { conversationId },
    update: { ...record },
    create: { conversationId, ...record },
  });
}

export interface CompactionOutcome {
  /** 进入模型的副本（可能已替换为「摘要 + 近期消息」）。 */
  messages: ChatUIMessage[];
  compacted: boolean;
  summarizedCount: number;
}

/**
 * 每回合的入口：需要时压缩并把结果持久化为新的压缩点，不需要时仅应用
 * 既有压缩点。摘要由调用方注入的 summarize 回调产生（通常用会话模型、
 * 关闭思考以省 token）。失败交给调用方的 try/catch 退回完整历史。
 */
export async function prepareCompactedMessages(input: {
  conversationId: string;
  messages: ChatUIMessage[];
  contextWindow: number;
  summarize: (system: string, prompt: string) => Promise<string>;
}): Promise<CompactionOutcome> {
  const record = await loadCompactionRecord(input.conversationId);
  const plan = planCompaction(input.messages, record, input.contextWindow);
  if (!plan) {
    return {
      messages: record ? applyCompaction(input.messages, record) : input.messages,
      compacted: false,
      summarizedCount: 0,
    };
  }

  const summary = (
    await input.summarize(
      COMPACTION_SYSTEM_PROMPT,
      renderSummarizerInput(record, plan.toSummarize),
    )
  )
    .trim()
    .slice(0, SUMMARY_MAX_CHARS);
  if (!summary) throw new Error("compaction summary was empty");

  const next: CompactionRecord = {
    boundaryMessageId: input.messages[plan.boundary]!.id,
    upToSeq: plan.boundary,
    summary,
  };
  await saveCompactionRecord(input.conversationId, next);
  return {
    messages: applyCompaction(input.messages, next),
    compacted: true,
    summarizedCount: plan.toSummarize.length,
  };
}
