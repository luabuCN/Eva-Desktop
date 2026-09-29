import { prisma } from "../db.js";

const AUTO_MEMORY_KEY = "memory.autoGenerate";

/** 注入系统提示的记忆段上限：条数与单条字符数都收敛，避免挤占上下文。 */
const INJECT_NOTE_CAP = 8;
const INJECT_NOTE_CHAR_CAP = 400;
const INJECT_SECTION_CHAR_CAP = 3_200;

/** 记忆笔记对外形状（路由序列化与前端类型一一对应）。 */
export interface MemoryNoteInfo {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  title: string;
  content: string;
  triggerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toInfo(note: {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  title: string;
  content: string;
  triggerMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MemoryNoteInfo {
  return {
    id: note.id,
    projectId: note.projectId,
    conversationId: note.conversationId,
    title: note.title,
    content: note.content,
    triggerMessageId: note.triggerMessageId,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/** 记忆列表。projectId 为空串/null 表示默认工作区（无项目会话）的记忆。 */
export async function listMemoryNotes(input: {
  projectId?: string | null;
  conversationId?: string | null;
}): Promise<MemoryNoteInfo[]> {
  const notes = await prisma.memoryNote.findMany({
    where: {
      projectId: input.projectId || null,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return notes.map(toInfo);
}

export async function updateMemoryNote(
  id: string,
  input: { title?: string; content?: string },
): Promise<MemoryNoteInfo | null> {
  const title = input.title?.trim();
  const note = await prisma.memoryNote.update({
    where: { id },
    data: {
      ...(title ? { title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
    },
  });
  return toInfo(note);
}

export async function deleteMemoryNote(id: string): Promise<void> {
  await prisma.memoryNote.delete({ where: { id } });
}

async function isGlobalMemoryEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_MEMORY_KEY } });
  return row ? row.value !== "false" : true;
}

/** 记忆自动生成开关：项目级覆盖（Project.memoryAutoGenerate）优先，否则全局。 */
export async function isMemoryEnabledFor(projectId?: string | null): Promise<boolean> {
  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { memoryAutoGenerate: true },
    });
    if (
      project?.memoryAutoGenerate !== null &&
      project?.memoryAutoGenerate !== undefined
    ) {
      return project.memoryAutoGenerate;
    }
  }
  return isGlobalMemoryEnabled();
}

export async function setMemoryEnabled(input: {
  enabled: boolean;
  projectId?: string | null;
}): Promise<void> {
  if (input.projectId) {
    await prisma.project.update({
      where: { id: input.projectId },
      data: { memoryAutoGenerate: input.enabled },
    });
    return;
  }
  await prisma.appSetting.upsert({
    where: { key: AUTO_MEMORY_KEY },
    create: { key: AUTO_MEMORY_KEY, value: String(input.enabled) },
    update: { value: String(input.enabled) },
  });
}

/** 系统提示注入段：最近若干条记忆拼成 markdown 小节；无记忆时返回空串。 */
export async function recentMemorySection(projectId?: string | null): Promise<string> {
  const notes = await prisma.memoryNote.findMany({
    where: { projectId: projectId || null },
    orderBy: { updatedAt: "desc" },
    take: INJECT_NOTE_CAP,
  });
  if (notes.length === 0) return "";

  const blocks: string[] = [];
  for (const note of notes) {
    const date = note.updatedAt.toISOString().slice(0, 10);
    const body =
      note.content.length > INJECT_NOTE_CHAR_CAP
        ? `${note.content.slice(0, INJECT_NOTE_CHAR_CAP)}…`
        : note.content;
    let block = `### ${note.title}（更新于 ${date}）\n${body}`;
    if (blocks.join("\n\n").length + block.length > INJECT_SECTION_CHAR_CAP) break;
    blocks.push(block);
  }
  if (blocks.length === 0) return "";

  return [
    "## 跨会话记忆",
    "以下是此前对话自动沉淀的记忆笔记（最新在前）。把它们当作背景知识参考；内容可能过时，与用户当前说法冲突时以用户为准。",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
