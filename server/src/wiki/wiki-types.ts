/** 知识库模块的共享类型（llm-wiki 架构，参考 nashsu/llm_wiki）。 */

/** 页面类型：决定目录树分组与图谱节点着色。 */
export const WIKI_PAGE_TYPES = [
  "overview",
  "index",
  "log",
  "entity",
  "concept",
  "source",
  "query",
] as const;

export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export function isWikiPageType(value: unknown): value is WikiPageType {
  return typeof value === "string" && (WIKI_PAGE_TYPES as readonly string[]).includes(value);
}

/** 类型 → 目录树分组标签（与 llm_wiki 的目录一致：概览/实体/概念/来源/查询）。 */
export const WIKI_TYPE_LABELS: Record<WikiPageType, string> = {
  overview: "概览",
  index: "目录",
  log: "历史",
  entity: "实体",
  concept: "概念",
  source: "来源",
  query: "查询",
};

/** 页面 frontmatter（meta 列的 JSON 结构）。 */
export interface WikiPageMeta {
  tags?: string[];
  /** 本页面引用的来源页路径（entities/concepts 与 source 摘要的溯源线）。 */
  sources?: string[];
  /** 相关页面标题（wikilink 目标）。 */
  related?: string[];
  /** 一句话摘要（图谱 hover / index 目录用）。 */
  summary?: string;
  /** 来源页关联的原文档 id（正文由 WikiDocument.text 渲染）。 */
  documentId?: string;
  /** 来源页关联的原始文件名。 */
  filename?: string;
  [key: string]: unknown;
}

/** 知识库原文档（raw 层）：上传文档提取的原始全文。 */
export interface WikiDocumentInfo {
  id: string;
  filename: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
  /** 原始二进制文件已落盘：支持原样预览/下载（旧数据可能为 false）。 */
  hasFile: boolean;
  createdAt: string;
}

/** 目录树里的原文档条目（「原始资料」分组）；path 指向对应 sources/ 来源页。 */
export interface WikiTreeDocument {
  id: string;
  filename: string;
  title: string;
  path: string;
  createdAt: string;
}

export interface WikiScopeInfo {
  id: string;
  label: string;
  kind: "default" | "project";
  projectId?: string | null;
  pageCount: number;
  lastUpdatedAt?: string | null;
}

export interface WikiPageSummary {
  path: string;
  title: string;
  type: WikiPageType;
  updatedAt: string;
  summary?: string;
  tags: string[];
}

export interface WikiPageDetail extends WikiPageSummary {
  content: string;
  meta: WikiPageMeta;
  /** 从正文中解析出的 [[wikilink]] 目标（去重，保持出现顺序）。 */
  links: string[];
  /** 反向链接：正文中 [[双链]] 指向本页的页面（按更新时间倒序）。 */
  backlinks: Array<{ path: string; title: string }>;
  /** 来源页关联的原文档（正文展示原文而非 LLM 摘要）。 */
  document?: WikiDocumentInfo;
}

/** 修订快照：内容被覆盖 / 删除 / 恢复前的存档（版本历史条目）。 */
export interface WikiRevisionInfo {
  id: string;
  path: string;
  title: string;
  /** manual = 手动编辑；ingest = 总结合并；delete = 删除前；restore = 恢复前 */
  reason: WikiRevisionReason;
  /** 快照正文字符数。 */
  chars: number;
  createdAt: string;
}

export const WIKI_REVISION_REASONS = ["manual", "ingest", "delete", "restore"] as const;
export type WikiRevisionReason = (typeof WIKI_REVISION_REASONS)[number];

export function isWikiRevisionReason(value: unknown): value is WikiRevisionReason {
  return typeof value === "string" && (WIKI_REVISION_REASONS as readonly string[]).includes(value);
}

export interface WikiTreeGroup {
  type: WikiPageType;
  label: string;
  pages: WikiPageSummary[];
}

export interface WikiTree {
  scopeId: string;
  groups: WikiTreeGroup[];
  totals: { pages: number };
  /** 原始资料分组（上传的原文档，按上传时间倒序）。 */
  documents: WikiTreeDocument[];
}

export interface WikiSearchHit {
  path: string;
  title: string;
  type: WikiPageType;
  /** 命中片段（正文截断）。 */
  snippet: string;
}

/** 图谱数据（前端 canvas 力导向渲染）。 */
export interface WikiGraphData {
  nodes: Array<{
    id: string;
    title: string;
    type: WikiPageType;
    /** 社区编号（label propagation，0..k-1）。 */
    community: number;
    degree: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    /** link = wikilink 引用；source = 共同来源。 */
    kind: "link" | "source";
  }>;
  communities: number;
  stats: { pages: number; links: number; isolated: number };
}

/** LLM 总结产物（一次调用输出的 JSON 结构）。 */
export interface WikiIngestResult {
  /** 本次对话主题概述（写入 log / overview）。 */
  summary: string;
  /** overview 页的最新一段全局摘要（追加到 overview 顶部）。 */
  overview?: string;
  pages: Array<{
    path: string;
    title: string;
    type: WikiPageType;
    content: string;
    tags?: string[];
    summary?: string;
    /** 引用的查询页路径（溯源）。 */
    sources?: string[];
  }>;
}
