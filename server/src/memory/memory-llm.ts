import { generateText } from "ai";
import { prisma } from "../db.js";
import { createModel } from "../runtime/model.js";
import { loadConversationTranscript } from "../wiki/wiki-llm.js";

const EXISTING_NOTE_CAP = 10;
const EXISTING_NOTE_CHAR_CAP = 600;

const MEMORY_SYSTEM_PROMPT = `你是记忆管理员：把一段对话回合沉淀为一条可长期演进的「记忆笔记」，供用户的后续对话参考。

规则：
1. 只记录值得跨会话记住的内容：用户的偏好与约定、项目/环境事实、关键决策与结论、踩过的坑与解决办法。闲聊、一次性操作、已有笔记已覆盖且无增量的内容一律 action=skip。
2. 已有笔记覆盖同一主题时选 action=update 并给 noteId：重写该笔记全文，把新信息合并进去，保留旧内容中仍然成立的部分，不要写成追加式流水账。
3. 新主题用 action=create：title 是 6-16 字的主题名（名词短语，像文件名，不含日期），content 是 3-8 行紧凑 markdown 要点，信息密度优先。
4. 笔记语言跟随对话的主要语言。
5. 输出只能是 JSON，不要输出 JSON 之外的文字。

JSON 结构：
{
  "action": "create | update | skip",
  "noteId": "action=update 时必填：要合并的已有笔记 id",
  "title": "笔记标题",
  "content": "markdown 正文"
}`;

interface MemoryGeneration {
  action: "create" | "update" | "skip";
  noteId?: string;
  title?: string;
  content?: string;
}

// 同一会话同一时刻只允许一个进行中的记忆生成；连续回合快速结束时
// 避免重复调用（后到者直接放弃，下一回合会带上最新对话再总结）。
const inFlightConversations = new Set<string>();

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM 输出中未找到 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** 快速模型一次调用；默认关闭思考，但「始终思考」的模型（如智谱 glm
 * coding 端点）会拒绝 enable_thinking=false，此时降一级用 low 重试。 */
async function callFastModel(system: string, prompt: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: await createModel("fast", undefined, "off"),
      system,
      prompt,
    });
    return text;
  } catch {
    const { text } = await generateText({
      model: await createModel("fast", undefined, "low"),
      system,
      prompt,
    });
    return text;
  }
}

function normalizeGeneration(raw: unknown): MemoryGeneration {
  if (!raw || typeof raw !== "object") throw new Error("LLM 输出不是对象");
  const record = raw as Record<string, unknown>;
  const action = record.action;
  if (action !== "create" && action !== "update" && action !== "skip") {
    throw new Error(`未知 action: ${String(action)}`);
  }
  return {
    action,
    noteId: typeof record.noteId === "string" ? record.noteId : undefined,
    title: typeof record.title === "string" ? record.title.trim() : undefined,
    content: typeof record.content === "string" ? record.content.trim() : undefined,
  };
}

async function applyGeneration(
  input: {
    conversationId: string;
    projectId: string | null;
    triggerMessageId: string | null;
  },
  generation: MemoryGeneration,
  knownNoteIds: Set<string>,
): Promise<void> {
  if (generation.action === "skip") return;
  const title = generation.title;
  const content = generation.content;
  if (!title || !content) return;

  if (generation.action === "update" && generation.noteId && knownNoteIds.has(generation.noteId)) {
    await prisma.memoryNote.update({
      where: { id: generation.noteId },
      data: {
        title,
        content,
        conversationId: input.conversationId,
        triggerMessageId: input.triggerMessageId,
      },
    });
    return;
  }

  // create，或 update 给了未知 noteId（笔记可能刚被删除）→ 兜底新建。
  await prisma.memoryNote.create({
    data: {
      projectId: input.projectId,
      conversationId: input.conversationId,
      title,
      content,
      triggerMessageId: input.triggerMessageId,
    },
  });
}

/** 回合结束后的记忆生成：对话稿 + 已有笔记 → 一次快速模型调用 → 入库。
 * 任何失败只记日志，绝不影响聊天流（调用方 fire-and-forget）。 */
export async function generateMemoryForTurn(input: {
  conversationId: string;
  projectId: string | null;
  fromSeq: number;
  toSeq: number;
  triggerMessageId: string | null;
}): Promise<void> {
  if (inFlightConversations.has(input.conversationId)) return;
  inFlightConversations.add(input.conversationId);
  try {
    const transcript = await loadConversationTranscript(
      input.conversationId,
      input.fromSeq,
      input.toSeq,
    );
    if (!transcript) return;

    const existing = await prisma.memoryNote.findMany({
      where: { projectId: input.projectId },
      orderBy: { updatedAt: "desc" },
      take: EXISTING_NOTE_CAP,
    });
    const existingListing = existing.length
      ? [
          "# 已有记忆笔记（同主题请合并更新，noteId 见各条）",
          ...existing.map(
            (note) =>
              `- noteId: ${note.id}\n  标题: ${note.title}\n  正文:\n${
                note.content.length > EXISTING_NOTE_CHAR_CAP
                  ? `${note.content.slice(0, EXISTING_NOTE_CHAR_CAP)}…`
                  : note.content
              }`,
          ),
        ].join("\n")
      : "（当前没有任何记忆笔记）";

    const userPrompt = [
      `# 对话记录（会话「${transcript.title}」，本回合约 ${transcript.turns} 个问答）`,
      transcript.transcript,
      "",
      existingListing,
    ].join("\n");

    const text = await callFastModel(MEMORY_SYSTEM_PROMPT, userPrompt);
    const generation = normalizeGeneration(extractJson(text));
    await applyGeneration(
      {
        conversationId: input.conversationId,
        projectId: input.projectId,
        triggerMessageId: input.triggerMessageId,
      },
      generation,
      new Set(existing.map((note) => note.id)),
    );
  } finally {
    inFlightConversations.delete(input.conversationId);
  }
}
