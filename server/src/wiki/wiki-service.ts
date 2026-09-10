import JSZip from "jszip";
import { prisma } from "../db.js";
import {
  buildPageFileContent,
  readRawDocumentFile,
  removeMirroredRawDocument,
  removePageFromDisk,
  saveRawDocumentFile,
  deleteRawDocumentFile,
  scheduleScopeSync,
} from "./wiki-files.js";
import { querySimilar, reembedPath } from "./wiki-embed.js";
import {
  isWikiPageType,
  isWikiRevisionReason,
  WIKI_TYPE_LABELS,
  type WikiDocumentInfo,
  type WikiPageDetail,
  type WikiPageMeta,
  type WikiPageSummary,
  type WikiPageType,
  type WikiRevisionInfo,
  type WikiScopeInfo,
  type WikiSearchHit,
  type WikiTree,
  type WikiTreeDocument,
  type WikiTreeGroup,
} from "./wiki-types.js";

export const DEFAULT_WIKI_SCOPE = "default";

/** 每个页面保留的修订快照数上限（超出裁掉最旧的）。 */
const REVISION_KEEP = 30;
/** 系统派生页（index/log/overview）可随时重建，不入修订历史。 */
const REVISION_EXEMPT_TYPES = new Set(["index", "log", "overview"]);

/** scopeId：默认工作区为 "default"，项目为 "p:<projectId>"。 */
export function projectScopeId(projectId: string): string {
  return `p:${projectId}`;
}

export function parseScopeId(scopeId: string): { kind: "default" } | { kind: "project"; projectId: string } {
  if (scopeId === DEFAULT_WIKI_SCOPE) return { kind: "default" };
  if (scopeId.startsWith("p:") && scopeId.length > 2) {
    return { kind: "project", projectId: scopeId.slice(2) };
  }
  throw new Error("无效的知识库标识");
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** 极简 frontmatter 解析：只取平铺的 title/type/tags/summary
 * （本应用导出与 Obsidian 常规格式，嵌套结构不解析、按正文处理）。 */
function splitFrontmatter(raw: string): {
  frontmatter: { title?: string; type?: string; tags?: string[]; summary?: string };
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: { title?: string; type?: string; tags?: string[]; summary?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (key === "tags") {
      const tags = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (tags.length > 0) frontmatter.tags = tags;
    } else if (key === "title" || key === "type" || key === "summary") {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

/** 解析正文中的 [[wikilink]]（支持 [[Title]] 与 [[path|Title]]）。 */
export function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    if (target && !links.includes(target)) links.push(target);
  }
  return links;
}

function parseMeta(raw: string): WikiPageMeta {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as WikiPageMeta) : {};
  } catch {
    return {};
  }
}

function toSummary(row: {
  path: string;
  title: string;
  type: string;
  content: string;
  meta: string;
  updatedAt: Date;
}): WikiPageSummary {
  const meta = parseMeta(row.meta);
  return {
    path: row.path,
    title: row.title,
    type: isWikiPageType(row.type) ? row.type : "concept",
    updatedAt: row.updatedAt.toISOString(),
    summary: meta.summary,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
  };
}

function toDocumentInfo(row: {
  id: string;
  filename: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
  hasFile: boolean;
  createdAt: Date;
}): WikiDocumentInfo {
  return {
    id: row.id,
    filename: row.filename,
    title: row.title,
    text: row.text,
    chars: row.chars,
    truncated: row.truncated,
    hasFile: row.hasFile,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(row: {
  path: string;
  title: string;
  type: string;
  content: string;
  meta: string;
  updatedAt: Date;
}): WikiPageDetail {
  const summary = toSummary(row);
  const meta = parseMeta(row.meta);
  return {
    ...summary,
    content: row.content,
    meta,
    links: extractWikiLinks(row.content),
    backlinks: [],
  };
}

/** [[双链]] 目标 → 页面路径解析（标题或路径基名匹配，与图谱一致）。 */
function resolveLinkTarget(
  raw: string,
  byTitle: Map<string, string>,
  byBaseName: Map<string, string>,
  nodeIds: Set<string>,
): string | undefined {
  const key = raw.trim().toLowerCase().replace(/\.md$/i, "");
  if (nodeIds.has(raw)) return raw;
  return byTitle.get(key) ?? byBaseName.get(key.includes("/") ? key.split("/").pop()! : key);
}

/** 内容被覆盖/删除前保存修订快照；系统派生页跳过，内容未变的重复写入跳过。 */
async function snapshotRevision(
  scopeId: string,
  row: { path: string; title: string; type: string; content: string; meta: string },
  reason: "manual" | "ingest" | "delete" | "restore",
): Promise<void> {
  if (REVISION_EXEMPT_TYPES.has(row.type)) return;
  const latest = await prisma.wikiPageRevision.findFirst({
    where: { scopeId, path: row.path },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  if (latest?.content === row.content) return;
  await prisma.wikiPageRevision.create({
    data: {
      scopeId,
      path: row.path,
      title: row.title,
      type: row.type,
      content: row.content,
      meta: row.meta,
      reason,
    },
  });
  // 只保留最近 REVISION_KEEP 份，裁掉更早的。
  const keep = await prisma.wikiPageRevision.findMany({
    where: { scopeId, path: row.path },
    orderBy: { createdAt: "desc" },
    take: REVISION_KEEP,
    select: { createdAt: true },
  });
  const oldestKept = keep.at(-1)?.createdAt;
  if (oldestKept) {
    await prisma.wikiPageRevision.deleteMany({
      where: { scopeId, path: row.path, createdAt: { lt: oldestKept } },
    });
  }
}

/** 来源页关联的原文档（无关联或文档已删返回 null）。 */
async function documentForMeta(meta: WikiPageMeta): Promise<WikiDocumentInfo | null> {
  if (typeof meta.documentId !== "string" || !meta.documentId) return null;
  const row = await prisma.wikiDocument.findUnique({ where: { id: meta.documentId } });
  return row ? toDocumentInfo(row) : null;
}

/** 归一化页面路径：去首尾空白与斜杠、反斜杠转正斜杠、强制 .md 后缀。 */
function normalizePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) throw new Error("页面路径不能为空");
  if (trimmed.includes("..")) throw new Error("页面路径不允许包含 ..");
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

/** 从路径推断页面类型（目录名即类型，llm_wiki 同款布局）。 */
export function typeFromPath(path: string): WikiPageType {
  const head = path.split("/")[0]?.toLowerCase();
  if (head === "entities") return "entity";
  if (head === "concepts") return "concept";
  if (head === "sources") return "source";
  if (head === "queries") return "query";
  if (head === "synthesis") return "concept";
  if (head === "comparisons") return "concept";
  if (path === "index.md") return "index";
  if (path === "log.md") return "log";
  if (path === "overview.md") return "overview";
  return "concept";
}

const TYPE_DIRS: Partial<Record<WikiPageType, string>> = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  query: "queries",
};

/** 标题 → 合法文件名（去文件系统非法字符，空白折叠）。 */
export function slugify(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|#[\]]/g, " ")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return cleaned || "untitled";
}

/** 页面路径合成：类型目录 + slug（index/log/overview 固定在根）。 */
export function pagePathFor(type: WikiPageType, title: string): string {
  if (type === "index" || type === "log" || type === "overview") return `${type}.md`;
  const dir = TYPE_DIRS[type] ?? "concepts";
  return `${dir}/${slugify(title)}.md`;
}

class WikiService {
  /** 全部知识库 scope：默认 + 每个未归档项目。 */
  async listScopes(): Promise<WikiScopeInfo[]> {
    const projects = await prisma.project.findMany({
      where: { archivedAt: null },
      orderBy: [{ pinned: "desc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    });
    const scopeIds = [DEFAULT_WIKI_SCOPE, ...projects.map((project) => projectScopeId(project.id))];
    const stats = await prisma.wikiPage.groupBy({
      by: ["scopeId"],
      where: { scopeId: { in: scopeIds } },
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    const statOf = (scopeId: string) => stats.find((entry) => entry.scopeId === scopeId);
    return [
      {
        id: DEFAULT_WIKI_SCOPE,
        label: "默认知识库",
        kind: "default",
        pageCount: statOf(DEFAULT_WIKI_SCOPE)?._count._all ?? 0,
        lastUpdatedAt: statOf(DEFAULT_WIKI_SCOPE)?._max.updatedAt?.toISOString() ?? null,
      },
      ...projects.map((project) => {
        const scopeId = projectScopeId(project.id);
        const stat = statOf(scopeId);
        return {
          id: scopeId,
          label: project.name,
          kind: "project" as const,
          projectId: project.id,
          pageCount: stat?._count._all ?? 0,
          lastUpdatedAt: stat?._max.updatedAt?.toISOString() ?? null,
        };
      }),
    ];
  }

  /** scope 存在性校验：default 恒存在；项目 scope 要求项目未归档。 */
  async ensureScope(scopeId: string): Promise<void> {
    const parsed = parseScopeId(scopeId);
    if (parsed.kind === "default") return;
    const project = await prisma.project.findFirst({
      where: { id: parsed.projectId, archivedAt: null },
      select: { id: true },
    });
    if (!project) throw new Error("知识库不存在（项目可能已被删除或归档）");
  }

  tree(scopeId: string): Promise<WikiTree> {
    return this.treeFiltered(scopeId, undefined);
  }

  /** 目录树：按类型分组（概览/目录/历史固定在顶部组，其余按类型组），
   * 另附原文档列表（「原始资料」分组，指向对应 sources/ 来源页）。 */
  async treeFiltered(scopeId: string, type?: WikiPageType): Promise<WikiTree> {
    await this.ensureScope(scopeId);
    const [rows, documents] = await Promise.all([
      prisma.wikiPage.findMany({
        where: { scopeId, ...(type ? { type } : {}) },
        orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
      }),
      prisma.wikiDocument.findMany({
        where: { scopeId },
        orderBy: [{ createdAt: "desc" }],
      }),
    ]);
    const groups: WikiTreeGroup[] = [];
    for (const pageType of ["overview", "index", "log", "entity", "concept", "source", "query"] as const) {
      const pages = rows
        .filter((row) => (isWikiPageType(row.type) ? row.type : "concept") === pageType)
        .map(toSummary);
      if (pages.length === 0 && pageType !== "overview") continue;
      groups.push({ type: pageType, label: WIKI_TYPE_LABELS[pageType], pages });
    }
    const treeDocuments: WikiTreeDocument[] = documents.map((row) => ({
      id: row.id,
      filename: row.filename,
      title: row.title,
      path: `sources/${slugify(row.title)}.md`,
      createdAt: row.createdAt.toISOString(),
    }));
    return { scopeId, groups, totals: { pages: rows.length }, documents: treeDocuments };
  }

  async page(scopeId: string, path: string): Promise<WikiPageDetail> {
    await this.ensureScope(scopeId);
    const row = await prisma.wikiPage.findUnique({
      where: { scopeId_path: { scopeId, path: normalizePath(path) } },
    });
    if (!row) throw new Error("页面不存在");
    const detail = toDetail(row);
    // 来源页关联原文档时附带全文，前端正文渲染原文而非 LLM 摘要。
    if (detail.type === "source") {
      const document = await documentForMeta(detail.meta);
      if (document) detail.document = document;
    }
    // 反向链接：scope 内正文 [[双链]] 解析到本页的页面。系统派生页
    // （index 引用所有页面、log 记录所有操作）会制造海量无意义反链，排除。
    const siblings = await prisma.wikiPage.findMany({
      where: { scopeId, type: { in: ["entity", "concept", "source", "query"] } },
      select: { path: true, title: true, content: true },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    const byTitle = new Map<string, string>();
    const byBaseName = new Map<string, string>();
    const nodeIds = new Set<string>();
    for (const sibling of siblings) {
      nodeIds.add(sibling.path);
      byTitle.set(sibling.title.toLowerCase(), sibling.path);
      byBaseName.set(sibling.path.split("/").pop()!.replace(/\.md$/i, "").toLowerCase(), sibling.path);
    }
    for (const sibling of siblings) {
      if (sibling.path === detail.path) continue;
      const linked = extractWikiLinks(sibling.content).some(
        (link) => resolveLinkTarget(link, byTitle, byBaseName, nodeIds) === detail.path,
      );
      if (linked) detail.backlinks.push({ path: sibling.path, title: sibling.title });
    }
    return detail;
  }

  /** 保存页面（upsert）；覆盖前存修订快照，写后刷新 index/log 等派生页面。 */
  async savePage(
    scopeId: string,
    input: { path: string; title: string; type?: WikiPageType; content: string; meta?: WikiPageMeta },
  ): Promise<WikiPageDetail> {
    await this.ensureScope(scopeId);
    const path = normalizePath(input.path);
    const type = input.type ?? typeFromPath(path);
    const existing = await prisma.wikiPage.findUnique({
      where: { scopeId_path: { scopeId, path } },
    });
    if (existing) await snapshotRevision(scopeId, existing, "manual");
    const row = await prisma.wikiPage.upsert({
      where: { scopeId_path: { scopeId, path } },
      create: {
        scopeId,
        path,
        title: input.title.trim() || path,
        type,
        content: input.content,
        meta: JSON.stringify(input.meta ?? {}),
      },
      update: {
        title: input.title.trim() || path,
        ...(input.type ? { type } : {}),
        content: input.content,
        ...(input.meta !== undefined ? { meta: JSON.stringify(input.meta) } : {}),
      },
    });
    await this.rebuildIndex(scopeId);
    scheduleScopeSync(scopeId);
    // 手动编辑后语义分块可能过期，后台重建（未配置 embedding 时为 no-op）。
    void reembedPath(scopeId, path).catch(() => undefined);
    return toDetail(row);
  }

  async deletePage(scopeId: string, path: string): Promise<void> {
    await this.ensureScope(scopeId);
    const normalized = normalizePath(path);
    if (["index.md", "log.md", "overview.md"].includes(normalized)) {
      throw new Error("概览/目录/历史页面不支持删除");
    }
    const row = await prisma.wikiPage.findUnique({
      where: { scopeId_path: { scopeId, path: normalized } },
    });
    // 删除前存修订快照：误删可从版本历史恢复（修订不随页面删除）。
    if (row) await snapshotRevision(scopeId, row, "delete");
    await prisma.wikiPage.deleteMany({ where: { scopeId, path: normalized } });
    // 来源页删除时连同原文档一起删（「原始资料」分组同步消失），
    // 落盘的原始二进制文件与镜像目录里的原件也一并清理。
    if (row?.type === "source") {
      const documentId = parseMeta(row.meta).documentId;
      if (typeof documentId === "string" && documentId) {
        const document = await prisma.wikiDocument.findUnique({
          where: { id: documentId },
          select: { filename: true },
        });
        await prisma.wikiDocument.deleteMany({ where: { id: documentId } });
        if (document) {
          await deleteRawDocumentFile(scopeId, documentId, document.filename);
          await removeMirroredRawDocument(scopeId, document.filename);
        }
      }
    }
    await removePageFromDisk(scopeId, normalized);
    await prisma.wikiChunk.deleteMany({ where: { scopeId, path: normalized } });
    await this.rebuildIndex(scopeId);
    scheduleScopeSync(scopeId);
  }

  /** 保存原文档（raw 层）：同名覆盖更新，并立即建立对应来源页。
   * 提取文本入库之外，原始二进制文件一并落盘（hasFile），供原样预览/下载。
   * 来源页正文即原文档内容（前端优先渲染 meta.documentId 指向的原文），
   * 占位 content 只在原文档被单独删除后兜底。 */
  async saveRawDocument(
    scopeId: string,
    input: { filename: string; title: string; text: string; truncated: boolean; bytes?: Buffer },
  ): Promise<WikiDocumentInfo> {
    await this.ensureScope(scopeId);
    const row = await prisma.wikiDocument.upsert({
      where: { scopeId_filename: { scopeId, filename: input.filename } },
      create: {
        scopeId,
        filename: input.filename,
        title: input.title,
        text: input.text,
        chars: input.text.length,
        truncated: input.truncated,
        hasFile: Boolean(input.bytes),
      },
      update: {
        title: input.title,
        text: input.text,
        chars: input.text.length,
        truncated: input.truncated,
        hasFile: Boolean(input.bytes),
        updatedAt: new Date(),
      },
    });
    // 原件按 documentId 落盘（upsert 后才有稳定 id）；失败不阻断总结入库。
    if (input.bytes) {
      await saveRawDocumentFile(scopeId, row.id, input.filename, input.bytes).catch((error) => {
        console.error("wiki raw document file save failed", error);
        return prisma.wikiDocument.update({
          where: { id: row.id },
          data: { hasFile: false },
        });
      });
    }
    const path = `sources/${slugify(input.title)}.md`;
    await prisma.wikiPage.upsert({
      where: { scopeId_path: { scopeId, path } },
      create: {
        scopeId,
        path,
        title: input.title,
        type: "source",
        content: `> 来源文档：${input.filename}\n\n原文档已存入「原始资料」，总结生成中。`,
        meta: JSON.stringify({ filename: input.filename, documentId: row.id }),
      },
      // 二次上传：重置 meta（旧摘要对应旧文本），总结任务完成后回填新摘要。
      update: {
        title: input.title,
        meta: JSON.stringify({ filename: input.filename, documentId: row.id }),
        updatedAt: new Date(),
      },
    });
    await this.rebuildIndex(scopeId);
    scheduleScopeSync(scopeId);
    return toDocumentInfo(row);
  }

  /** 关键词搜索（CJK 友好）：按空白拆词后 OR 命中，标题命中权重高于正文，
   * 按命中词数加权排序；片段取首个命中词附近的内容。
   * 页面与原文档全文都参与——上传文档里摘要没覆盖到的内容也能被搜到。 */
  async search(scopeId: string, query: string, limit = 20): Promise<WikiSearchHit[]> {
    await this.ensureScope(scopeId);
    const terms = [
      ...new Set(
        query
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter((term) => term.length > 0),
      ),
    ];
    if (terms.length === 0) return [];
    const [rows, documents] = await Promise.all([
      prisma.wikiPage.findMany({
        where: {
          scopeId,
          OR: terms.flatMap((term) => [
            { title: { contains: term } },
            { content: { contains: term } },
            { meta: { contains: term } },
          ]),
        },
        orderBy: [{ updatedAt: "desc" }],
        take: 200,
      }),
      prisma.wikiDocument.findMany({
        where: {
          scopeId,
          OR: terms.flatMap((term) => [
            { title: { contains: term } },
            { text: { contains: term } },
          ]),
        },
        take: 100,
      }),
    ]);
    const scored: Array<{ hit: WikiSearchHit; score: number }> = [];
    for (const row of rows) {
      const summary = toSummary(row);
      const lowerTitle = row.title.toLowerCase();
      const lowerContent = row.content.toLowerCase();
      const lowerMeta = row.meta.toLowerCase();
      let score = 0;
      let firstIndex = -1;
      for (const term of terms) {
        const inTitle = lowerTitle.includes(term);
        const inContent = lowerContent.includes(term);
        if (!inTitle && !inContent && !lowerMeta.includes(term)) continue;
        score += 1 + (inTitle ? 3 : 0) + (inContent ? 1 : 0);
        const contentIndex = lowerContent.indexOf(term);
        if (contentIndex >= 0 && (firstIndex < 0 || contentIndex < firstIndex)) {
          firstIndex = contentIndex;
        }
      }
      if (score === 0) continue;
      const start = Math.max(0, firstIndex - 40);
      const snippet =
        firstIndex >= 0
          ? `${start > 0 ? "…" : ""}${row.content.slice(start, start + 140).replace(/\s+/g, " ")}…`
          : summary.summary ?? "";
      scored.push({
        hit: { path: summary.path, title: summary.title, type: summary.type, snippet },
        score,
      });
    }
    // 原文档全文命中 → 归到对应 sources/ 来源页（来源页已命中的不重复计）。
    const hitPaths = new Set(scored.map((entry) => entry.hit.path));
    for (const document of documents) {
      const docPath = `sources/${slugify(document.title)}.md`;
      if (hitPaths.has(docPath)) continue;
      const lowerTitle = document.title.toLowerCase();
      const lowerText = document.text.toLowerCase();
      let score = 0;
      let firstIndex = -1;
      for (const term of terms) {
        const inTitle = lowerTitle.includes(term);
        const textIndex = lowerText.indexOf(term);
        if (!inTitle && textIndex < 0) continue;
        score += 1 + (inTitle ? 3 : 0) + (textIndex >= 0 ? 1 : 0);
        if (textIndex >= 0 && (firstIndex < 0 || textIndex < firstIndex)) {
          firstIndex = textIndex;
        }
      }
      if (score === 0) continue;
      const start = Math.max(0, firstIndex - 40);
      const snippet =
        firstIndex >= 0
          ? `${start > 0 ? "…" : ""}${document.text.slice(start, start + 140).replace(/\s+/g, " ")}…`
          : "";
      scored.push({
        hit: { path: docPath, title: document.title, type: "source", snippet },
        score,
      });
    }
    // 语义补充召回：配置了 embedding 时，关键词没命中的页面按余弦相似度补位
    // （分数固定低于任何关键词命中）；未配置或调用失败时静默回落纯关键词。
    try {
      const similar = await querySimilar(scopeId, query, 8);
      if (similar.length > 0) {
        const hitPaths = new Set(scored.map((entry) => entry.hit.path));
        const missing = similar.filter((hit) => !hitPaths.has(hit.path));
        if (missing.length > 0) {
          const rowsForPaths = await prisma.wikiPage.findMany({
            where: { scopeId, path: { in: missing.map((hit) => hit.path) } },
            select: { path: true, title: true, type: true },
          });
          const byPath = new Map(rowsForPaths.map((row) => [row.path, row]));
          for (const hit of missing) {
            const row = byPath.get(hit.path);
            if (!row) continue;
            scored.push({
              hit: {
                path: hit.path,
                title: row.title,
                type: isWikiPageType(row.type) ? row.type : "concept",
                snippet: hit.snippet,
              },
              score: 0.5,
            });
          }
        }
      }
    } catch {
      // 语义检索不可用不影响关键词结果
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => entry.hit);
  }

  /** 导入 Obsidian vault（zip 里的 .md 文件）：frontmatter 取 title/type/tags/summary，
   * 正文原样入库（[[双链]] 天然兼容）。覆盖已有页面前存修订快照。 */
  async importPages(
    scopeId: string,
    entries: Array<{ path: string; title?: string; type?: string; tags?: string[]; summary?: string; content: string }>,
  ): Promise<number> {
    await this.ensureScope(scopeId);
    let imported = 0;
    for (const entry of entries) {
      const path = normalizePath(entry.path);
      const type = isWikiPageType(entry.type) ? entry.type : typeFromPath(path);
      const title = entry.title?.trim() || path;
      const existing = await prisma.wikiPage.findUnique({
        where: { scopeId_path: { scopeId, path } },
      });
      if (existing) await snapshotRevision(scopeId, existing, "manual");
      await prisma.wikiPage.upsert({
        where: { scopeId_path: { scopeId, path } },
        create: {
          scopeId,
          path,
          title,
          type,
          content: entry.content,
          meta: JSON.stringify({
            ...(entry.tags?.length ? { tags: entry.tags } : {}),
            ...(entry.summary ? { summary: entry.summary } : {}),
            imported: true,
          }),
        },
        update: {
          title,
          type,
          content: entry.content,
          updatedAt: new Date(),
        },
      });
      imported += 1;
      void reembedPath(scopeId, path).catch(() => undefined);
    }
    await this.rebuildIndex(scopeId);
    scheduleScopeSync(scopeId);
    return imported;
  }

  /** 解析 Obsidian vault zip（与 exportZip 对偶）：取全部 .md 条目，
   * frontmatter 取 title/type/tags/summary，正文原样导入。 */
  async importVaultZip(
    scopeId: string,
    buffer: Buffer,
  ): Promise<{ imported: number; skipped: string[] }> {
    await this.ensureScope(scopeId);
    const zip = await JSZip.loadAsync(buffer);
    const entries: Array<{
      path: string;
      title?: string;
      type?: string;
      tags?: string[];
      summary?: string;
      content: string;
    }> = [];
    const skipped: string[] = [];
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const clean = name.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!/\.(md|markdown)$/i.test(clean)) {
        skipped.push(clean);
        continue;
      }
      if (clean.split("/").some((segment) => segment.startsWith(".") || segment === "__MACOSX")) {
        skipped.push(clean);
        continue;
      }
      const raw = await file.async("string");
      const { frontmatter, body } = splitFrontmatter(raw);
      entries.push({
        path: clean,
        title: frontmatter.title,
        type: frontmatter.type,
        tags: frontmatter.tags,
        summary: frontmatter.summary,
        content: body.trimStart(),
      });
    }
    const imported = await this.importPages(scopeId, entries);
    if (imported > 0) {
      await this.appendLog(scopeId, {
        heading: `导入 vault（${imported} 个页面）`,
        body: entries.map((entry) => `[[${entry.title ?? entry.path}]]`).join("、"),
      });
    }
    return { imported, skipped };
  }

  /** 由 LLM 产出的页面集合合并写入（ingest 落库路径）。
   * 覆盖前存修订快照；meta 与旧值字段级合并——LLM 这次没输出 tags/summary
   * 时不应该清空上次沉淀的元信息。 */
  async applyIngestPages(
    scopeId: string,
    pages: Array<{ path: string; title: string; type: WikiPageType; content: string; meta?: WikiPageMeta }>,
  ): Promise<void> {
    for (const input of pages) {
      const path = normalizePath(input.path);
      const existing = await prisma.wikiPage.findUnique({
        where: { scopeId_path: { scopeId, path } },
      });
      let page = input;
      if (existing) {
        await snapshotRevision(scopeId, existing, "ingest");
        if (page.meta !== undefined) {
          page = { ...page, meta: { ...parseMeta(existing.meta), ...page.meta } };
        }
      }
      await prisma.wikiPage.upsert({
        where: { scopeId_path: { scopeId, path } },
        create: {
          scopeId,
          path,
          title: page.title.trim() || path,
          type: page.type,
          content: page.content,
          meta: JSON.stringify(page.meta ?? {}),
        },
        update: {
          title: page.title.trim() || path,
          type: page.type,
          content: page.content,
          ...(page.meta !== undefined ? { meta: JSON.stringify(page.meta) } : {}),
          updatedAt: new Date(),
        },
      });
    }
    scheduleScopeSync(scopeId);
  }

  /** log.md 追加一条操作记录（llm_wiki 的操作历史）。 */
  async appendLog(
    scopeId: string,
    entry: { heading: string; body: string },
  ): Promise<void> {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const line = `\n\n## ${stamp} · ${entry.heading}\n\n${entry.body.trim()}\n`;
    const existing = await prisma.wikiPage.findUnique({
      where: { scopeId_path: { scopeId, path: "log.md" } },
    });
    const content = existing ? `${existing.content}${line}` : `# 操作历史${line}`;
    await prisma.wikiPage.upsert({
      where: { scopeId_path: { scopeId, path: "log.md" } },
      create: { scopeId, path: "log.md", title: "操作历史", type: "log", content, meta: "{}" },
      update: { content },
    });
    scheduleScopeSync(scopeId);
  }

  /** overview.md 顶部替换为最新全局摘要（LLM 输出的 overview 段落）。 */
  async updateOverview(scopeId: string, summary: string, projectName: string): Promise<void> {
    const label = scopeId === DEFAULT_WIKI_SCOPE ? "默认知识库" : `${projectName} 知识库`;
    const stats = await prisma.wikiPage.groupBy({
      by: ["scopeId"],
      where: { scopeId },
      _count: { _all: true },
    });
    const count = stats[0]?._count._all ?? 0;
    const header = `---\ntitle: ${label}\ntype: overview\n---\n\n# ${label}\n\n`;
    const body = `${summary.trim()}\n\n> 共 ${count} 个页面，由对话自动总结持续更新。最新条目见 [[log]]。\n`;
    await prisma.wikiPage.upsert({
      where: { scopeId_path: { scopeId, path: "overview.md" } },
      create: { scopeId, path: "overview.md", title: "概览", type: "overview", content: `${header}${body}`, meta: "{}" },
      update: { content: `${header}${body}`, updatedAt: new Date() },
    });
    scheduleScopeSync(scopeId);
  }

  /** index.md 目录页：按类型分组的全量页面目录（每次写操作后重建）。 */
  async rebuildIndex(scopeId: string): Promise<void> {
    const rows = await prisma.wikiPage.findMany({
      where: { scopeId, type: { in: ["entity", "concept", "source", "query"] } },
      orderBy: [{ type: "asc" }, { title: "asc" }],
    });
    const sections: string[] = [];
    for (const pageType of ["entity", "concept", "source", "query"] as const) {
      const pages = rows.filter((row) => row.type === pageType);
      if (pages.length === 0) continue;
      const lines = pages.map((row) => `- [[${row.title}]]`);
      sections.push(`## ${WIKI_TYPE_LABELS[pageType]}\n\n${lines.join("\n")}\n`);
    }
    const content = `---\ntitle: 目录\ntype: index\n---\n\n# 内容目录\n\n${sections.join("\n") || "_暂无内容页面。完成一轮对话后，自动总结会在这里建立目录。_\n"}`;
    await prisma.wikiPage.upsert({
      where: { scopeId_path: { scopeId, path: "index.md" } },
      create: { scopeId, path: "index.md", title: "目录", type: "index", content, meta: "{}" },
      update: { content },
    });
    scheduleScopeSync(scopeId);
  }

  /** 版本历史：某页面最近的修订快照（新 → 旧）。 */
  async listRevisions(scopeId: string, path: string, limit = 30): Promise<WikiRevisionInfo[]> {
    await this.ensureScope(scopeId);
    const rows = await prisma.wikiPageRevision.findMany({
      where: { scopeId, path: normalizePath(path) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      reason: isWikiRevisionReason(row.reason) ? row.reason : "manual",
      chars: row.content.length,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** 恢复到某次修订：当前内容先存快照（恢复本身可撤销），再回写旧版本。 */
  async restoreRevision(scopeId: string, path: string, revisionId: string): Promise<WikiPageDetail> {
    await this.ensureScope(scopeId);
    const normalized = normalizePath(path);
    const revision = await prisma.wikiPageRevision.findUnique({ where: { id: revisionId } });
    if (!revision || revision.scopeId !== scopeId || revision.path !== normalized) {
      throw new Error("修订不存在");
    }
    const existing = await prisma.wikiPage.findUnique({
      where: { scopeId_path: { scopeId, path: normalized } },
    });
    if (existing) await snapshotRevision(scopeId, existing, "restore");
    await prisma.wikiPage.upsert({
      where: { scopeId_path: { scopeId, path: normalized } },
      create: {
        scopeId,
        path: normalized,
        title: revision.title,
        type: revision.type,
        content: revision.content,
        meta: revision.meta,
      },
      update: {
        title: revision.title,
        type: revision.type,
        content: revision.content,
        meta: revision.meta,
        updatedAt: new Date(),
      },
    });
    await this.rebuildIndex(scopeId);
    scheduleScopeSync(scopeId);
    void reembedPath(scopeId, normalized).catch(() => undefined);
    return this.page(scopeId, normalized);
  }

  allPages(scopeId: string) {
    return prisma.wikiPage.findMany({ where: { scopeId }, orderBy: [{ updatedAt: "desc" }] });
  }

  /** 导出为 Obsidian 兼容 vault（zip）：每页带 YAML frontmatter；
   * 关联原文档的来源页正文写原文（摘要保留在 frontmatter summary），
   * 已落盘的原始二进制文件放入 raw/sources/（llm-wiki 布局）。
   * 文件内容构建与磁盘镜像共用 buildPageFileContent。 */
  async exportZip(scopeId: string): Promise<Buffer> {
    await this.ensureScope(scopeId);
    const pages = await this.allPages(scopeId);
    const zip = new JSZip();
    for (const row of pages) {
      const meta = parseMeta(row.meta);
      // 来源页有关联原文档时导出原文，保证 vault 里的「来源」即原始文档。
      const rawDocument =
        row.type === "source" && typeof meta.documentId === "string" && meta.documentId
          ? await prisma.wikiDocument.findUnique({ where: { id: meta.documentId } })
          : null;
      zip.file(row.path, buildPageFileContent(row, rawDocument));
      if (rawDocument?.hasFile) {
        const bytes = await readRawDocumentFile(scopeId, rawDocument.id, rawDocument.filename);
        if (bytes) zip.file(`raw/sources/${rawDocument.filename}`, bytes);
      }
    }
    return zip.generateAsync({ type: "nodebuffer" });
  }
}

export const wikiService = new WikiService();
