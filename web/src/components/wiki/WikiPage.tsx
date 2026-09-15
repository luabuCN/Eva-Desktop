import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  Boxes,
  Braces,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  History,
  Link2,
  Loader2,
  Network,
  Pencil,
  RefreshCw,
  Search,
  Tag,
  Trash2,
} from "lucide-react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import {
  deleteWikiPage,
  fetchWikiGraph,
  fetchWikiJobs,
  fetchWikiPage,
  fetchWikiRevisions,
  fetchWikiSettings,
  fetchWikiTree,
  importWikiVault,
  listWikiScopes,
  restoreWikiRevision,
  retryFailedWikiJobs,
  rebuildWiki,
  saveWikiPage,
  uploadWikiDocument,
  type WikiGraphData,
  type WikiJobsInfo,
  type WikiPageDetail,
  type WikiPageSummary,
  type WikiRevision,
  type WikiScopeInfo,
  type WikiTree,
  type WikiTreeGroup,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SidebarPeekTrigger } from "@/components/SidebarPeekTrigger";
import {
  isTauriWindow,
  windowControlsReserveClass,
} from "@/components/WindowControls";
import { WikiGraph } from "./WikiGraph";
import { cn } from "@/lib/utils";

const streamdownPlugins = { cjk, code, math, mermaid };

/** 原文件预览（@file-viewer + preset-office）较重，打开来源页时才按需加载。 */
const DocumentFilePreview = lazy(() => import("./DocumentFilePreview"));

/** 侧栏分组：页面类型分组之外，末尾追加「原始资料」（原文档）分组。 */
type SidebarGroup =
  | WikiTreeGroup
  | { type: "raw"; label: string; pages: WikiPageSummary[] };

/** 文件树节点（「文件」标签页）：llm-wiki 的 raw/ + wiki/ 目录视图。
 * raw/sources 为上传的原文档，wiki/ 为生成的页面文件；点击都打开对应页面。 */
interface FileTreeNode {
  name: string;
  kind: "dir" | "file";
  /** 目录/文件的逻辑路径（展开状态与 React key 用）。 */
  path: string;
  /** 点击打开的 wiki 页面路径。 */
  pagePath?: string;
  children?: FileTreeNode[];
}

/** 按关键词过滤文件树：保留命中的文件及其祖先目录。 */
function filterFileTree(nodes: FileTreeNode[], keyword: string): FileTreeNode[] {
  const result: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      if (!keyword || node.name.toLowerCase().includes(keyword)) result.push(node);
      continue;
    }
    const children = filterFileTree(node.children ?? [], keyword);
    if (children.length > 0) result.push({ ...node, children });
  }
  return result;
}

const TYPE_BADGE_CLASS: Record<string, string> = {
  entity: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  concept: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  source: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  query: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  overview: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  index: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  log: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

const TYPE_ICONS: Record<string, typeof FileText> = {
  entity: Boxes,
  concept: Braces,
  source: BookMarked,
  query: Search,
  overview: BookOpen,
  index: BookOpen,
  log: BookOpen,
};

/** 版本历史来源标签。 */
const REASON_LABELS: Record<WikiRevision["reason"], string> = {
  manual: "手动编辑前",
  ingest: "总结合并前",
  delete: "删除前",
  restore: "恢复前",
};

/** [[wikilink]] 在正文预览里渲染为强调文本（链接跳转由下方 chips 提供）。 */
function renderWikiMarkdown(content: string): string {
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target, label) => `**${String(label || target).trim()}**`);
}

/** 支持原样预览的二进制文档扩展名（服务端上传解析同款集合）。 */
const FILE_PREVIEW_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

function documentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

interface WikiPageViewProps {
  onExit: () => void;
  /** 聊天里 wiki:// 链接的跳转目标：切到此视图时打开指定 scope 的页面。 */
  target?: { scopeId: string; path: string; nonce: number } | null;
}

export function WikiPageView({ onExit, target }: WikiPageViewProps) {
  const [scopes, setScopes] = useState<WikiScopeInfo[]>([]);
  // 初始 scope 由设置「默认知识库」决定（服务端下发），加载前为 null。
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [tree, setTree] = useState<WikiTree | null>(null);
  const [page, setPage] = useState<WikiPageDetail | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [tab, setTab] = useState<"docs" | "graph">("docs");
  const [filter, setFilter] = useState("");
  /** 当前页面是从哪个侧栏分组打开的（来源/原始资料同指一页，高亮只留在点击的分组）。 */
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  /** 侧栏标签页：知识目录 / 文件树（llm-wiki 的 Knowledge / Files）。 */
  const [sidebarTab, setSidebarTab] = useState<"knowledge" | "files">("knowledge");
  /** 文件树目录展开状态（默认展开 raw 与 wiki，类型子目录收起）。 */
  const [fileExpanded, setFileExpanded] = useState<Record<string, boolean>>({
    raw: true,
    "raw/sources": true,
    wiki: true,
  });
  const [graph, setGraph] = useState<WikiGraphData | null>(null);
  const [jobs, setJobs] = useState<WikiJobsInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rebuildConfirm, setRebuildConfirm] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [uploadState, setUploadState] = useState<"idle" | "uploading">("idle");
  const [uploadNotice, setUploadNotice] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vaultInputRef = useRef<HTMLInputElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const jobsSignatureRef = useRef("");
  // 版本历史（修订快照）：打开时拉取，恢复后刷新列表。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<WikiRevision[] | null>(null);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  /** 来源页正文视图：原文件预览（默认，原件已落盘时）/ 提取文本。 */
  const [docView, setDocView] = useState<"file" | "text">("file");

  const refreshTree = useCallback((targetScope: string) => {
    void fetchWikiTree(targetScope)
      .then(setTree)
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "目录加载失败"),
      );
  }, []);

  // 初始加载：知识库列表 + 设置（默认知识库）一起取，默认 scope 优先。
  useEffect(() => {
    void Promise.all([listWikiScopes(), fetchWikiSettings()])
      .then(([next, settings]) => {
        setScopes(next);
        setScopeId((current) => {
          if (current && next.some((scope) => scope.id === current)) return current;
          if (next.some((scope) => scope.id === settings.defaultScope)) {
            return settings.defaultScope;
          }
          return next[0]?.id ?? "default";
        });
      })
      .catch(() => setScopeId((current) => current ?? "default"));
  }, []);

  useEffect(() => {
    setPage(null);
    setEditing(false);
    setGraph(null);
    if (scopeId) refreshTree(scopeId);
  }, [scopeId, refreshTree]);

  // 聊天跳转目标：先切 scope（scope 就绪后由下方效果打开指定页面）。
  useEffect(() => {
    if (!target) return;
    setScopeId((current) => (current === target.scopeId ? current : target.scopeId));
  }, [target?.nonce, target?.scopeId]);

  // 队列状态轮询：有任务排队/处理中时驱动左栏角标刷新。
  useEffect(() => {
    const load = () => {
      void fetchWikiJobs()
        .then((next) => {
          const signature = `${next.stats.queued}:${next.stats.processing}:${next.stats.failedRecent}:${next.jobs[0]?.id ?? ""}:${next.jobs[0]?.status ?? ""}`;
          if (signature === jobsSignatureRef.current) return;
          jobsSignatureRef.current = signature;
          setJobs(next);
          // 有任务刚完成 → 刷新目录与图谱（总结结果落库）。
          if (next.jobs[0]?.status === "completed" && jobs?.jobs[0]?.id === next.jobs[0].id) {
            if (scopeId) refreshTree(scopeId);
            setGraph(null);
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 3_000);
    return () => window.clearInterval(timer);
  }, [scopeId, refreshTree, jobs?.jobs]);

  const openPage = useCallback(
    (path: string, group?: string) => {
      if (!scopeId) return;
      setEditing(false);
      setHistoryOpen(false);
      setRevisions(null);
      setDocView("file");
      setActiveGroup(group ?? null);
      setPageLoading(true);
      void fetchWikiPage(scopeId, path)
        .then(setPage)
        .catch((cause: unknown) =>
          setActionError(cause instanceof Error ? cause.message : "页面加载失败"),
        )
        .finally(() => setPageLoading(false));
    },
    [scopeId],
  );

  // scope 与跳转目标一致时打开指定页面（nonce 让重复点击同一链接也生效）。
  useEffect(() => {
    if (!target || scopeId !== target.scopeId) return;
    openPage(target.path);
  }, [target, scopeId, openPage]);

  const openGraph = useCallback(() => {
    setTab("graph");
    if (!graph && scopeId) {
      void fetchWikiGraph(scopeId)
        .then(setGraph)
        .catch((cause: unknown) =>
          setActionError(cause instanceof Error ? cause.message : "图谱加载失败"),
        );
    }
  }, [graph, scopeId]);

  /** wikilink 目标 → 目录内页面路径（标题或路径基名匹配）。 */
  const resolveLink = useCallback(
    (target: string): string | undefined => {
      if (!tree) return undefined;
      const key = target.trim().toLowerCase().replace(/\.md$/, "");
      for (const group of tree.groups) {
        const hit = group.pages.find(
          (candidate) =>
            candidate.title.toLowerCase() === key ||
            candidate.path.toLowerCase() === `${key}.md` ||
            candidate.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase() === key,
        );
        if (hit) return hit.path;
      }
      return undefined;
    },
    [tree],
  );

  /** 侧栏分组：类型分组 + 末尾「原始资料」（上传的原文档，点击打开对应来源页）。 */
  const filteredGroups = useMemo<SidebarGroup[]>(() => {
    if (!tree) return [];
    const keyword = filter.trim().toLowerCase();
    const matchKeyword = (candidate: {
      title: string;
      path: string;
      tags: string[];
    }) =>
      !keyword ||
      candidate.title.toLowerCase().includes(keyword) ||
      candidate.path.toLowerCase().includes(keyword) ||
      candidate.tags.some((tag) => tag.toLowerCase().includes(keyword));
    // 无关键词时保持服务端分组原样（含空概览组）；有关键词时丢弃空组。
    // 注意不能原地 push：tree.groups 是 state，变异会在 memo 重算时叠加分组。
    const groups: SidebarGroup[] = keyword
      ? tree.groups
          .map((group) => ({ ...group, pages: group.pages.filter(matchKeyword) }))
          .filter((group) => group.pages.length > 0)
      : [...tree.groups];
    if (tree.documents.length > 0) {
      groups.push({
        type: "raw",
        label: "原始资料",
        pages: tree.documents
          .filter((doc) => matchKeyword({ title: doc.filename, path: doc.path, tags: [] }))
          .map((doc) => ({
            path: doc.path,
            title: doc.filename,
            type: "source" as const,
            updatedAt: doc.createdAt,
            summary: undefined,
            tags: [],
          })),
      });
    }
    return groups;
  }, [tree, filter]);

  /** 文件树（「文件」标签页）：raw/sources 原文档 + wiki/ 页面文件（llm-wiki 目录布局）。 */
  const fileTree = useMemo<FileTreeNode[]>(() => {
    if (!tree) return [];
    const rawFiles: FileTreeNode[] = tree.documents.map((doc) => ({
      name: doc.filename,
      kind: "file",
      path: `raw/sources/${doc.filename}`,
      pagePath: doc.path,
    }));
    const dirMap = new Map<string, FileTreeNode>();
    const rootFiles: FileTreeNode[] = [];
    for (const group of tree.groups) {
      for (const entry of group.pages) {
        const segments = entry.path.split("/");
        if (segments.length === 1) {
          rootFiles.push({
            name: segments[0],
            kind: "file",
            path: `wiki/${entry.path}`,
            pagePath: entry.path,
          });
          continue;
        }
        const dir = segments[0];
        let node = dirMap.get(dir);
        if (!node) {
          node = { name: dir, kind: "dir", path: `wiki/${dir}`, children: [] };
          dirMap.set(dir, node);
        }
        node.children!.push({
          name: segments.slice(1).join("/"),
          kind: "file",
          path: `wiki/${entry.path}`,
          pagePath: entry.path,
        });
      }
    }
    const byName = (a: FileTreeNode, b: FileTreeNode) => a.name.localeCompare(b.name);
    const wikiDirs = [...dirMap.values()].sort(byName);
    for (const dir of wikiDirs) dir.children!.sort(byName);
    rootFiles.sort(byName);
    return [
      {
        name: "raw",
        kind: "dir",
        path: "raw",
        children: [
          { name: "sources", kind: "dir", path: "raw/sources", children: rawFiles },
        ],
      },
      // llm-wiki 布局：类型目录在前，index/log/overview 固定在 wiki 根部。
      { name: "wiki", kind: "dir", path: "wiki", children: [...wikiDirs, ...rootFiles] },
    ];
  }, [tree]);

  /** 递归渲染文件树（关键词过滤时目录全部展开）。 */
  const renderFileNode = useCallback(
    (node: FileTreeNode, depth: number, keyword: string): ReactNode => {
      if (node.kind === "dir") {
        const children = filterFileTree(node.children ?? [], keyword);
        if (keyword && children.length === 0) return null;
        const open = keyword ? true : fileExpanded[node.path] ?? false;
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() =>
                setFileExpanded((prev) => ({ ...prev, [node.path]: !open }))
              }
              className="flex w-full items-center gap-1 rounded-md py-1.5 pr-2 text-left text-xs transition-colors hover:bg-accent"
              style={{ paddingLeft: depth * 12 + 6 }}
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {open ? (
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
            </button>
            {open ? <div>{children.map((child) => renderFileNode(child, depth + 1, keyword))}</div> : null}
          </div>
        );
      }
      return (
        <button
          key={node.path}
          type="button"
          title={node.name}
          onClick={() => node.pagePath && openPage(node.pagePath)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs transition-colors hover:bg-accent",
            page?.path === node.pagePath && "bg-accent font-medium",
          )}
          style={{ paddingLeft: depth * 12 + 22 }}
        >
          <FileTypeIcon name={node.name} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
      );
    },
    [fileExpanded, openPage, page?.path],
  );

  const activeScope = scopes.find((scope) => scope.id === scopeId);
  const queueBusy = (jobs?.stats.queued ?? 0) > 0 || (jobs?.stats.processing ?? 0) > 0;

  const startEdit = useCallback(() => {
    if (!page) return;
    setDraft({ title: page.title, content: page.content });
    setEditing(true);
  }, [page]);

  const saveEdit = useCallback(async () => {
    if (!page || !scopeId) return;
    setSaving(true);
    try {
      const saved = await saveWikiPage(scopeId, {
        path: page.path,
        title: draft.title.trim() || page.title,
        content: draft.content,
      });
      setPage(saved);
      setEditing(false);
      refreshTree(scopeId);
      setGraph(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [draft, page, refreshTree, scopeId]);

  const confirmDelete = useCallback(async () => {
    if (!page || !scopeId) return;
    try {
      await deleteWikiPage(scopeId, page.path);
      setPage(null);
      refreshTree(scopeId);
      setGraph(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "删除失败");
    }
  }, [page, refreshTree, scopeId]);

  const runRebuild = useCallback(async () => {
    if (!scopeId) return;
    try {
      await rebuildWiki(scopeId);
      setActionError(undefined);
      window.setTimeout(() => refreshTree(scopeId), 1_000);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "构建任务入队失败");
    }
  }, [refreshTree, scopeId]);

  /** 打开/关闭版本历史（打开时拉取修订列表）。 */
  const toggleHistory = useCallback(() => {
    if (!scopeId || !page) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    setRevisionsLoading(true);
    void fetchWikiRevisions(scopeId, page.path)
      .then(setRevisions)
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "版本历史加载失败"),
      )
      .finally(() => setRevisionsLoading(false));
  }, [historyOpen, page, scopeId]);

  /** 恢复到某次修订：当前内容会先存一份「恢复前」快照，恢复本身可撤销。 */
  const restoreFromHistory = useCallback(
    async (revisionId: string) => {
      if (!scopeId || !page) return;
      setRestoringId(revisionId);
      try {
        const restored = await restoreWikiRevision(scopeId, page.path, revisionId);
        setPage(restored);
        refreshTree(scopeId);
        setGraph(null);
        setRevisions(await fetchWikiRevisions(scopeId, page.path));
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "恢复失败");
      } finally {
        setRestoringId(null);
      }
    },
    [page, refreshTree, scopeId],
  );

  /** 重试全部失败的总结任务并立刻刷新队列状态。 */
  const retryFailed = useCallback(async () => {
    try {
      await retryFailedWikiJobs();
      jobsSignatureRef.current = "";
      setJobs(await fetchWikiJobs());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "重试失败");
    }
  }, []);

  /** 上传文档 → base64 → 服务端存原文档（立即出现在「来源/原始资料」）并总结。 */
  const handleUpload = useCallback(
    async (file: File | undefined) => {
      if (!file || !scopeId) return;
      setUploadState("uploading");
      setUploadNotice(undefined);
      try {
        const result = await uploadWikiDocument(scopeId, file);
        setUploadNotice(
          `「${file.name}」原文档已存入（提取 ${result.chars.toLocaleString()} 字符${
            result.truncated ? "，超长已截断" : ""
          }），总结完成后「来源」页会补充摘要与关联页面`,
        );
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "上传失败");
      } finally {
        setUploadState("idle");
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [scopeId],
  );

  /** 导入 Obsidian vault（zip）：.md 按 frontmatter 建页，双链天然兼容。 */
  const handleImportVault = useCallback(
    async (file: File | undefined) => {
      if (!file || !scopeId) return;
      setUploadState("uploading");
      setUploadNotice(undefined);
      try {
        const result = await importWikiVault(scopeId, file);
        setUploadNotice(
          result.imported > 0
            ? `已从「${file.name}」导入 ${result.imported} 个页面${
                result.skipped.length > 0 ? `（跳过 ${result.skipped.length} 个非 .md 文件）` : ""
              }`
            : "zip 中没有可导入的 .md 文件",
        );
        refreshTree(scopeId);
        setGraph(null);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "导入失败");
      } finally {
        setUploadState("idle");
        if (vaultInputRef.current) vaultInputRef.current.value = "";
      }
    },
    [refreshTree, scopeId],
  );

  useEffect(() => {
    if (!uploadNotice) return;
    const timer = window.setTimeout(() => setUploadNotice(undefined), 6_000);
    return () => window.clearTimeout(timer);
  }, [uploadNotice]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header
        data-tauri-drag-region="deep"
        className={cn(
          "flex h-11 shrink-0 items-center gap-3 border-b px-4 select-none",
          isTauriWindow() && windowControlsReserveClass,
        )}
      >
        <SidebarPeekTrigger />
        <Button variant="ghost" size="icon-sm" onClick={onExit} title="返回">
          <ArrowLeft size={16} />
        </Button>
        <Separator orientation="vertical" className="h-4!" />
        <BookOpen className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">知识库</span>
        <div className="w-56">
          <Select value={scopeId ?? undefined} onValueChange={setScopeId}>
            <SelectTrigger size="sm" className="h-7 text-xs">
              <SelectValue placeholder="选择知识库" />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((scope) => (
                <SelectItem key={scope.id} value={scope.id} className="text-xs">
                  {scope.kind === "project" ? "项目 · " : ""}
                  {scope.label}（{scope.pageCount}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.txt,.html,.htm,.pdf,.docx,.xlsx,.pptx"
            className="hidden"
            onChange={(event) => {
              void handleUpload(event.target.files?.[0]);
            }}
          />
          <input
            ref={vaultInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(event) => {
              void handleImportVault(event.target.files?.[0]);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={uploadState === "uploading"}
            onClick={() => vaultInputRef.current?.click()}
            title="导入 Obsidian vault（zip 内 .md 文件按 frontmatter 建页，与导出对偶）"
          >
            {uploadState === "uploading" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FolderOpen className="size-3.5" />
            )}
            导入 vault
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={uploadState === "uploading"}
            onClick={() => fileInputRef.current?.click()}
            title="上传文档解析入知识库：md / txt / html / pdf / docx / xlsx / pptx"
          >
            {uploadState === "uploading" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileUp className="size-3.5" />
            )}
            上传文档
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setRebuildConfirm(true)}>
            <RefreshCw className="size-3.5" />
            从历史会话构建
          </Button>
        </div>
      </header>

      {uploadNotice ? (
        <p className="border-b bg-primary/5 px-4 py-1.5 text-xs text-primary">
          {uploadNotice}
        </p>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* 左栏：知识目录 / 文件树（llm-wiki 的 Knowledge / Files 双标签） */}
        <aside className="flex w-64 shrink-0 flex-col border-r">
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            {(
              [
                { key: "knowledge", label: "知识库" },
                { key: "files", label: "文件" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setSidebarTab(key)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  sidebarTab === key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选页面…"
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {/* viewport 子元素为 table 布局：容器加横向 padding 会撑出横向滚动条，
                横向留白由条目自身的 px 提供。 */}
            <div className="py-1.5">
              {sidebarTab === "files" ? (
                fileTree.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    暂无文件
                  </p>
                ) : (
                  <div className="px-1">
                    {fileTree.map((node) =>
                      renderFileNode(node, 0, filter.trim().toLowerCase()),
                    )}
                  </div>
                )
              ) : filteredGroups.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {tree?.totals.pages === 0
                    ? "知识库为空：完成一轮对话后自动总结，上传文档，或点右上「从历史会话构建」"
                    : "没有匹配的页面"}
                </p>
              ) : (
                filteredGroups.map((group) => {
                  const collapsed = collapsedGroups[group.type] ?? false;
                  const Icon = TYPE_ICONS[group.type] ?? FileText;
                  return (
                    <Collapsible
                      key={group.type}
                      open={!collapsed}
                      onOpenChange={(next) =>
                        setCollapsedGroups((prev) => ({ ...prev, [group.type]: !next }))
                      }
                    >
                      <CollapsibleTrigger className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent">
                        {collapsed ? (
                          <ChevronRight className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                        {group.label}
                        <span className="ml-auto tabular-nums">{group.pages.length}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="pb-1">
                          {group.pages.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              onClick={() => openPage(entry.path, group.type)}
                              title={entry.summary ?? entry.path}
                              className={cn(
                                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 pl-5 text-left text-xs transition-colors hover:bg-accent",
                                page?.path === entry.path &&
                                  (activeGroup === group.type ||
                                    (!activeGroup && group.type !== "raw")) &&
                                  "bg-accent font-medium",
                              )}
                            >
                              {/* 原始资料按文件类型显示图标；页面分组仍用类型图标。 */}
                              {group.type === "raw" ? (
                                <FileTypeIcon name={entry.title} className="size-4 shrink-0" />
                              ) : (
                                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                            </button>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })
              )}
            </div>
          </ScrollArea>
          {/* 总结队列状态 */}
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {queueBusy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                总结中：{jobs?.stats.processing ?? 0} 处理 / {jobs?.stats.queued ?? 0} 排队
              </span>
            ) : jobs?.stats.failedRecent ? (
              <span className="flex items-center gap-2 text-destructive">
                近 1 小时 {jobs.stats.failedRecent} 条总结失败
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => void retryFailed()}
                >
                  重试
                </button>
              </span>
            ) : (
              <span>总结队列空闲</span>
            )}
          </div>
        </aside>

        {/* 主区：文档预览 / 编辑 / 知识图谱 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
            {(
              [
                { key: "docs", label: "文档", icon: FileText },
                { key: "graph", label: "知识图谱", icon: Network },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => (key === "graph" ? openGraph() : setTab("docs"))}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                  tab === key
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>

          {actionError ? (
            <p className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {actionError}
              <button type="button" className="ml-2 underline" onClick={() => setActionError(undefined)}>
                关闭
              </button>
            </p>
          ) : null}

          {tab === "graph" ? (
            graph ? (
              <WikiGraph data={graph} onSelectNode={openPage} />
            ) : (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在构建图谱…
              </div>
            )
          ) : editing ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
              <div className="flex items-center gap-2">
                <Input
                  value={draft.title}
                  onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                  className="h-8 text-sm font-medium"
                  placeholder="页面标题"
                />
                <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={() => void saveEdit()}>
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  保存
                </Button>
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setEditing(false)}>
                  取消
                </Button>
              </div>
              <Textarea
                value={draft.content}
                onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
                className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed"
                placeholder="markdown 正文（支持 [[双链]]）"
              />
            </div>
          ) : pageLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              加载中…
            </div>
          ) : page ? (
            <ScrollArea className="min-h-0 flex-1">
              <article className="mx-auto w-full max-w-5xl px-8 py-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="truncate text-xl font-semibold">{page.title}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {page.path} · 更新于 {new Date(page.updatedAt).toLocaleString("zh-CN")}
                    </p>
                    {page.document ? (
                      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                        <FileText className="size-3 shrink-0" />
                        <span>
                          原文档 {page.document.filename} ·{" "}
                          {page.document.chars.toLocaleString()} 字符
                          {page.document.truncated ? "（超长已截断）" : ""} · 上传于{" "}
                          {new Date(page.document.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge className={cn("border-transparent", TYPE_BADGE_CLASS[page.type])}>
                      {page.type}
                    </Badge>
                    {/* 系统派生页（目录/历史/概览）不入修订历史。 */}
                    {["index.md", "log.md", "overview.md"].includes(page.path) ? null : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleHistory}
                        title="版本历史"
                      >
                        <History className={cn("size-3.5", historyOpen && "text-primary")} />
                      </Button>
                    )}
                    {/* 来源页正文为原文档（或系统生成的摘要），只读；编辑仅开放给实体/概念/查询页。 */}
                    {page.type === "source" ? null : (
                      <Button variant="ghost" size="icon-sm" onClick={startEdit} title="编辑">
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                    {["index.md", "log.md", "overview.md"].includes(page.path) ? null : (
                      <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(true)} title="删除">
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {(page.tags.length > 0 || page.meta.summary) && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {page.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="gap-1 text-xs font-normal">
                        <Tag className="size-3" />
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                {page.document ? (
                  // 来源页关联原文档：正文展示原文（不可变），LLM 摘要单独呈现。
                  <div className="mt-3 rounded-lg border bg-muted/40 px-3 py-2">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">总结摘要</p>
                    {page.meta.summary ? (
                      <p className="mb-2 text-sm text-muted-foreground">{page.meta.summary}</p>
                    ) : null}
                    <Streamdown plugins={streamdownPlugins} className="text-sm">
                      {renderWikiMarkdown(page.content)}
                    </Streamdown>
                  </div>
                ) : page.meta.summary ? (
                  <p className="mt-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    {page.meta.summary}
                  </p>
                ) : null}

                {page.document?.hasFile &&
                FILE_PREVIEW_EXTENSIONS.has(documentExtension(page.document.filename)) &&
                scopeId ? (
                  <>
                    <div className="mt-4 flex items-center gap-1 border-b pb-2">
                      {(
                        [
                          { key: "file", label: "原文件预览" },
                          { key: "text", label: "提取文本" },
                        ] as const
                      ).map(({ key, label }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setDocView(key)}
                          className={cn(
                            "rounded-md px-2.5 py-1 text-xs transition-colors",
                            docView === key
                              ? "bg-accent font-medium text-accent-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {docView === "file" ? (
                      <div className="mt-3">
                        <Suspense
                          fallback={
                            <div className="flex h-[70vh] flex-col items-center justify-center gap-2 rounded-lg border">
                              <Loader2 className="size-5 animate-spin text-muted-foreground" />
                              <p className="text-xs text-muted-foreground">正在加载预览组件…</p>
                            </div>
                          }
                        >
                          <DocumentFilePreview scopeId={scopeId} document={page.document} />
                        </Suspense>
                      </div>
                    ) : (
                      <div className="mt-5">
                        <Streamdown plugins={streamdownPlugins}>
                          {renderWikiMarkdown(page.document.text)}
                        </Streamdown>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-5">
                    {page.document ? (
                      <p className="mb-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                        这份文档早于「原件保存」功能上传，暂只能展示提取文本；
                        重新上传同名文件后即可原样预览 PDF / Word / Excel / PPT。
                      </p>
                    ) : null}
                    <Streamdown plugins={streamdownPlugins}>
                      {renderWikiMarkdown(page.document ? page.document.text : page.content)}
                    </Streamdown>
                  </div>
                )}

                {page.links.length > 0 || page.backlinks.length > 0 || historyOpen ? (
                  <div className="mt-8 space-y-5 border-t pt-4">
                    {page.links.length > 0 ? (
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <Link2 className="size-3.5" />
                          链接（{page.links.length}）
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {page.links.map((link) => {
                            const target = resolveLink(link);
                            return target ? (
                              <button
                                key={link}
                                type="button"
                                onClick={() => openPage(target)}
                                className="rounded-full border bg-accent/60 px-2.5 py-1 text-xs text-accent-foreground transition-colors hover:bg-accent"
                              >
                                {link}
                              </button>
                            ) : (
                              <span
                                key={link}
                                title="尚未创建"
                                className="rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground"
                              >
                                {link}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {page.backlinks.length > 0 ? (
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <CornerUpLeft className="size-3.5" />
                          反向链接（{page.backlinks.length}）
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {page.backlinks.map((backlink) => (
                            <button
                              key={backlink.path}
                              type="button"
                              onClick={() => openPage(backlink.path)}
                              title={backlink.path}
                              className="rounded-full border bg-accent/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                              {backlink.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {historyOpen ? (
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <History className="size-3.5" />
                          版本历史（{revisions?.length ?? 0}）· 恢复前会自动保存当前版本
                        </p>
                        {revisionsLoading ? (
                          <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" />
                            加载中…
                          </p>
                        ) : revisions && revisions.length > 0 ? (
                          <ul className="space-y-1.5">
                            {revisions.map((revision) => (
                              <li
                                key={revision.id}
                                className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                              >
                                <span className="text-muted-foreground">
                                  {new Date(revision.createdAt).toLocaleString("zh-CN")}
                                </span>
                                <Badge variant="secondary" className="text-xs font-normal">
                                  {REASON_LABELS[revision.reason]}
                                </Badge>
                                <span className="text-muted-foreground">
                                  {revision.chars.toLocaleString()} 字符
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="ml-auto h-6 px-2 text-xs"
                                  disabled={restoringId !== null}
                                  onClick={() => void restoreFromHistory(revision.id)}
                                >
                                  {restoringId === revision.id ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : null}
                                  恢复此版本
                                </Button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-muted-foreground">暂无历史修订</p>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </ScrollArea>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <BookOpen className="size-10 text-muted-foreground/50" />
              <div>
                <p className="text-sm font-medium">{activeScope?.label ?? "知识库"}</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  llm-wiki 模式：对话回合完成后自动总结为实体/概念/查询页面，
                  项目对话沉淀到对应项目知识库。左侧选择页面预览，切换「知识图谱」查看关联。
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除页面</AlertDialogTitle>
            <AlertDialogDescription>
              {page?.document
                ? `确定删除「${page?.title}」吗？关联的原文档「${page.document.filename}」会一并删除，引用它的 [[双链]] 会变成未创建状态，此操作无法撤销。`
                : `确定删除「${page?.title}」吗？引用它的 [[双链]] 会变成未创建状态，此操作无法撤销。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rebuildConfirm} onOpenChange={setRebuildConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从历史会话构建知识库</AlertDialogTitle>
            <AlertDialogDescription>
              将「{activeScope?.label}」下的全部历史会话逐个总结入队（串行执行，
              会话较多时需要一些时间与 token）。已总结过的会话会按最新内容重新生成。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRebuildConfirm(false);
                void runRebuild();
              }}
            >
              开始构建
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
