import { generateText } from "ai";
import { prisma } from "../db.js";
import type { ChatUIMessage } from "../chat-types.js";
import { createModel } from "../runtime/model.js";
import { wikiService, slugify } from "./wiki-service.js";
import { isWikiPageType, type WikiIngestResult } from "./wiki-types.js";

/** 单条消息文本提取上限：防止单个超长回答挤爆总结上下文。 */
const MESSAGE_CHAR_CAP = 2_400;
/** 对话输入总预算（字符）。 */
const CONVERSATION_BUDGET = 20_000;
/** 文档输入预算（字符）：文档信息密度高，略宽于对话。 */
const DOCUMENT_BUDGET = 24_000;
/** 提示词中携带的已有页面数上限（供 LLM 合并，而非重复建页）。 */
const RELATED_PAGE_CAP = 8;
const RELATED_PAGE_CHAR_CAP = 1_800;

function messageText(message: ChatUIMessage, cap = MESSAGE_CHAR_CAP): string {
  const text = message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text.length > cap ? `${text.slice(0, cap)}…（截断）` : text;
}

/** 从 ui 快照读取 [fromSeq, toSeq) 的消息并压缩成「用户问 / 助手答」对话稿。 */
export async function loadConversationTranscript(
  conversationId: string,
  fromSeq: number,
  toSeq: number,
): Promise<{ title: string; transcript: string; turns: number } | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { title: true },
  });
  if (!conversation) return null;
  const rows = await prisma.storedMessage.findMany({
    where: { conversationId, kind: "ui", sequence: { gte: fromSeq, lt: toSeq } },
    orderBy: { sequence: "asc" },
  });

  const lines: string[] = [];
  let turns = 0;
  let budget = CONVERSATION_BUDGET;
  for (const row of rows) {
    let message: ChatUIMessage;
    try {
      message = JSON.parse(row.payload) as ChatUIMessage;
    } catch {
      continue;
    }
    const text = messageText(message);
    if (!text) continue;
    if (message.role === "user") {
      lines.push(`【用户】\n${text}`);
      turns += 1;
    } else if (message.role === "assistant") {
      lines.push(`【助手】\n${text}`);
    }
    budget -= text.length;
    if (budget <= 0) {
      lines.push("…（更早内容已省略）");
      break;
    }
  }
  if (lines.length === 0) return null;
  return { title: conversation.title, transcript: lines.join("\n\n"), turns };
}

/** 标题出现在对话文本中的已有内容页 → 全文给 LLM 用于合并更新。 */
async function relatedExistingPages(scopeId: string, transcript: string) {
  const pages = await prisma.wikiPage.findMany({
    where: { scopeId, type: { in: ["entity", "concept", "source"] } },
    orderBy: [{ updatedAt: "desc" }],
  });
  const haystack = transcript.toLowerCase();
  const related = pages.filter((page) => haystack.includes(page.title.toLowerCase()));
  const limited = related.slice(0, RELATED_PAGE_CAP);
  if (limited.length === 0) return "";
  return limited
    .map(
      (page) =>
        `### 已有页面 ${page.path}（类型 ${page.type}）\n${page.content.slice(0, RELATED_PAGE_CHAR_CAP)}`,
    )
    .join("\n\n");
}

function indexListing(scopeId: string): Promise<string> {
  return prisma.wikiPage
    .findMany({
      where: { scopeId, type: { in: ["entity", "concept", "source", "query"] } },
      orderBy: [{ type: "asc" }, { title: "asc" }],
      select: { path: true, title: true, type: true },
    })
    .then((rows) =>
      rows.length === 0
        ? "（知识库当前为空）"
        : rows.map((row) => `- ${row.path} · ${row.title} · ${row.type}`).join("\n"),
    );
}

const CONVERSATION_SYSTEM_PROMPT = `你是知识库维护者（llm-wiki 模式）：把对话沉淀为可长期演进的 wiki 页面，而不是一次性摘要。

规则：
1. 提取对话中值得长期记住的实体（人/组织/产品/项目/文件等）与概念（方法/理论/决策/结论），生成或更新对应页面。
2. 已有同名页面时，把新信息合并进去（保留旧内容仍然成立的部分，补充增量），不要丢弃已有知识。
3. 页面之间用 [[标题]] 双链互相引用；每个实体/概念页 150-400 字，信息密度优先。
4. 每次都要生成一个 queries/ 下的查询页：记录本次对话的问题与答案要点（path 形如 queries/<日期或主题>.md）。
5. 只有对话确实产生新知识才建页；闲聊或纯操作类对话只生成查询页。
6. 输出只能是 JSON，不要包裹 markdown 代码块之外的文字。

JSON 结构：
{
  "summary": "本次对话一句话概述（30字内）",
  "overview": "整个知识库当前的全局概述（120字内，重写而非追加）",
  "pages": [
    {
      "path": "entities/xxx.md 或 concepts/xxx.md 或 queries/xxx.md",
      "title": "页面标题",
      "type": "entity | concept | source | query",
      "content": "markdown 正文（不含 frontmatter，含 [[双链]]）",
      "tags": ["标签"],
      "summary": "一句话页面摘要",
      "sources": ["引用的查询页路径，可选"]
    }
  ]
}`;

const DOCUMENT_SYSTEM_PROMPT = `你是知识库维护者（llm-wiki 模式）：把一份文档沉淀为可长期演进的 wiki 页面。

规则：
1. 必须生成一个 sources/ 下的来源摘要页（path 形如 sources/<文档名>.md，type=source）：文档讲了什么、关键结论、值得记住的细节，200-500 字。
2. 抽取文档中的实体（人/组织/产品/项目等）与概念（方法/理论/指标/结论），生成或更新对应页面，并必须用 [[来源页标题]] 双链指回来源页。
3. 已有同名页面时合并新信息（保留旧内容仍然成立的部分），不要丢弃已有知识。
4. 页面之间用 [[标题]] 双链互相引用；每个实体/概念页 150-400 字，信息密度优先。
5. 文档没有实质知识（模板/空壳/纯表格数据）时只生成来源页。
6. 输出只能是 JSON，不要包裹 markdown 代码块之外的文字。

JSON 结构：
{
  "summary": "文档一句话概述（30字内）",
  "overview": "整个知识库当前的全局概述（120字内，重写而非追加）",
  "pages": [
    {
      "path": "sources/xxx.md 或 entities/xxx.md 或 concepts/xxx.md",
      "title": "页面标题",
      "type": "source | entity | concept",
      "content": "markdown 正文（不含 frontmatter，含 [[双链]]）",
      "tags": ["标签"],
      "summary": "一句话页面摘要",
      "sources": []
    }
  ]
}`;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM 输出中未找到 JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** 校验并规整 LLM 输出；页面为空时至少保留查询页（由调用方兜底）。 */
function normalizeResult(raw: unknown): WikiIngestResult {
  if (!raw || typeof raw !== "object") throw new Error("LLM 输出不是对象");
  const record = raw as Record<string, unknown>;
  const pages: WikiIngestResult["pages"] = [];
  const rawPages = Array.isArray(record.pages) ? record.pages : [];
  for (const entry of rawPages) {
    if (!entry || typeof entry !== "object") continue;
    const page = entry as Record<string, unknown>;
    if (typeof page.path !== "string" || typeof page.content !== "string") continue;
    const path = page.path.endsWith(".md") ? page.path : `${page.path}.md`;
    pages.push({
      path,
      title: typeof page.title === "string" && page.title.trim() ? page.title.trim() : page.path,
      type: isWikiPageType(page.type) ? page.type : "concept",
      content: page.content,
      tags: Array.isArray(page.tags) ? page.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      summary: typeof page.summary === "string" ? page.summary : undefined,
      sources: Array.isArray(page.sources)
        ? page.sources.filter((source): source is string => typeof source === "string")
        : undefined,
    });
  }
  return {
    summary: typeof record.summary === "string" ? record.summary : "对话总结",
    overview: typeof record.overview === "string" ? record.overview : undefined,
    pages,
  };
}

/** 一次 LLM 调用：对话稿 + 现有目录/相关页 → 页面集 JSON。 */
export async function summarizeConversationToWiki(input: {
  scopeId: string;
  transcript: string;
  conversationTitle: string;
  conversationId: string;
}): Promise<WikiIngestResult> {
  const [index, related] = await Promise.all([
    indexListing(input.scopeId),
    relatedExistingPages(input.scopeId, input.transcript),
  ]);

  const userPrompt = [
    `# 对话记录（会话「${input.conversationTitle}」，id ${input.conversationId}）`,
    input.transcript,
    "",
    "# 知识库现有页面目录",
    index,
    ...(related ? ["", "# 需要合并更新的已有页面（同名请合并而非新建）", related] : []),
  ].join("\n");

  const { text } = await generateText({
    model: await createModel("fast"),
    system: CONVERSATION_SYSTEM_PROMPT,
    prompt: userPrompt,
  });
  return normalizeResult(extractJson(text));
}

/** 一次 LLM 调用：上传文档提取文本 + 现有目录/相关页 → 页面集 JSON。 */
export async function summarizeDocumentToWiki(input: {
  scopeId: string;
  filename: string;
  title: string;
  text: string;
}): Promise<WikiIngestResult> {
  const clipped =
    input.text.length > DOCUMENT_BUDGET
      ? `${input.text.slice(0, DOCUMENT_BUDGET)}\n…（内容过长，已截断）`
      : input.text;
  const [index, related] = await Promise.all([
    indexListing(input.scopeId),
    relatedExistingPages(input.scopeId, clipped),
  ]);

  const userPrompt = [
    `# 上传文档「${input.filename}」（标题：${input.title}）的提取文本`,
    clipped,
    "",
    "# 知识库现有页面目录",
    index,
    ...(related ? ["", "# 需要合并更新的已有页面（同名请合并而非新建）", related] : []),
  ].join("\n");

  const { text } = await generateText({
    model: await createModel("fast"),
    system: DOCUMENT_SYSTEM_PROMPT,
    prompt: userPrompt,
  });
  return normalizeResult(extractJson(text));
}

/** ingest 来源：对话回合或上传文档，决定兜底页类型与 log 文案。 */
export type WikiIngestOrigin =
  | { kind: "conversation"; conversationId: string; conversationTitle: string }
  | { kind: "document"; filename: string; title: string; documentId?: string };

/** ingest 落库：页面合并写入 + 兜底页 + log/overview/index 派生刷新。 */
export async function applyIngestResult(input: {
  scopeId: string;
  projectName: string;
  origin: WikiIngestOrigin;
  result: WikiIngestResult;
}): Promise<number> {
  const { scopeId, result, origin } = input;
  let pages = result.pages.filter((page) => page.content.trim().length > 0);
  if (origin.kind === "conversation") {
    if (!pages.some((page) => page.type === "query")) {
      // 兜底查询页：LLM 没建时也要留下可溯源的对话记录。
      const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
      pages = [
        {
          path: `queries/${stamp}-${origin.conversationId.slice(0, 8)}.md`,
          title: origin.conversationTitle.slice(0, 60) || "对话记录",
          type: "query",
          content: `> 来源会话：${origin.conversationTitle}\n\n${result.summary}`,
          summary: result.summary,
        },
        ...pages,
      ];
    }
  } else {
    // 文档来源：来源页固定为原文档对应的规范路径（saveRawDocument 已建好
    // 页面与 meta.documentId），LLM 产出的摘要合并进去而非另建新页。
    const canonical = `sources/${slugify(origin.title)}.md`;
    pages = pages.map((page) =>
      page.type === "source" ? { ...page, path: canonical, title: origin.title } : page,
    );
    if (!pages.some((page) => page.type === "source")) {
      // 兜底来源页：文档哪怕提取不到结构化知识，也要留下摘要记录。
      pages = [
        {
          path: canonical,
          title: origin.title,
          type: "source",
          content: `> 来源文档：${origin.filename}\n\n${result.summary}`,
          summary: result.summary,
        },
        ...pages,
      ];
    }
  }

  await wikiService.applyIngestPages(
    scopeId,
    pages.map((page) => ({
      path: page.path,
      title: page.title,
      type: page.type,
      content: page.content,
      meta: {
        ...(page.tags?.length ? { tags: page.tags } : {}),
        ...(page.summary ? { summary: page.summary } : {}),
        ...(page.sources?.length ? { sources: page.sources } : {}),
        ...(page.type === "query" && origin.kind === "conversation"
          ? { conversationId: origin.conversationId }
          : {}),
        ...(page.type === "source" && origin.kind === "document"
          ? { filename: origin.filename, ...(origin.documentId ? { documentId: origin.documentId } : {}) }
          : {}),
      },
    })),
  );
  const originLabel =
    origin.kind === "conversation"
      ? `对话总结（来源会话「${origin.conversationTitle}」）`
      : `文档解析（来源文件 ${origin.filename}）`;
  await wikiService.appendLog(scopeId, {
    heading: `${originLabel} · ${result.summary}`,
    body: `更新 ${pages.length} 个页面：${pages.map((page) => `[[${page.title}]]`).join("、")}`,
  });
  if (result.overview) {
    await wikiService.updateOverview(scopeId, result.overview, input.projectName);
  }
  await wikiService.rebuildIndex(scopeId);
  return pages.length;
}
