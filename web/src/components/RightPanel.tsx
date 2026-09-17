import {
  ArrowLeftIcon,
  BarChart3Icon,
  CheckCircleIcon,
  CircleIcon,
  FileDiffIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  ListTodoIcon,
  SquareTerminalIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, memo, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { DiffCard } from "@/components/ai-elements/diff-block";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { getStatusBadge, ToolInput, stringifyToolOutput } from "@/components/ai-elements/tool";
import {
  extractWebFetchOutput,
  extractWebSearchOutput,
  WebFetchContent,
  WebSearchResults,
} from "@/components/ai-elements/web-results";
import { BrowserPane, type PreviewTarget } from "@/components/BrowserPane";
import { ChangesPanel } from "@/components/ChangesPanel";
import { GitPanel } from "@/components/GitPanel";
import { TerminalPane } from "@/components/TerminalPane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  listFiles,
  readFileContent,
  type AgentTaskInfo,
  type FileEntry,
  type ProjectInfo,
} from "@/api";
import {
  collectToolCalls,
  collectToolTokenUsage,
  collectUsage,
  collectUsageSummary,
  formatDuration,
  formatTokenCount,
  toolNameOf,
  type ChatUIMessage,
  type ToolCallRef,
} from "@/lib/chat-utils";
import { friendlyErrorText } from "@/lib/error-display";
import { cn } from "@/lib/utils";

export type RightTab = "files" | "browser" | "terminal" | "tasks" | "changes" | "git" | "tools" | "usage";

export interface RightPanelProps {
  messages: ChatUIMessage[];
  tasks: AgentTaskInfo[];
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  selectedToolId?: string;
  onToolSelect: (id: string) => void;
  width: number;
  project?: ProjectInfo | null;
  sessionId?: string;
  busy?: boolean;
  /** 模型目录里的上下文窗口大小；未知时按 128k 兜底。 */
  contextWindow?: number;
  /** 内置浏览器面板当前加载的预览目标。 */
  previewTarget: PreviewTarget | null;
  /** 工具结果里的链接点击后送进内置浏览器面板（与聊天链接行为一致）。 */
  onOpenLink?: (url: string) => void;
  /** 文件树里点击 office/图片等二进制文件时改在预览面板打开。 */
  onOpenFile?: (filePath: string) => void;
}

function RightPanelBase({
  messages,
  tasks,
  tab,
  onTabChange,
  selectedToolId,
  onToolSelect,
  width,
  project,
  sessionId,
  busy,
  contextWindow,
  previewTarget,
  onOpenLink,
  onOpenFile,
}: RightPanelProps) {
  return (
    <aside
      className="hidden min-w-0 shrink-0 flex-col bg-background lg:flex"
      style={{ width }}
    >
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as RightTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* 标签条保持单行紧凑：纵向禁止滚动（激活项下划线伪元素会溢出 5px），
            横向可滚但隐藏滚动条——8px 的全局滚动条在标签栏下太笨重。
            选中态只用淡主题色背景，不加边框和阴影。标签条位于窗口
            标题栏下方，右端不会被自绘窗口按钮遮挡。 */}
        <TabsList className="group-data-[orientation=horizontal]/tabs:h-9 w-full shrink-0 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none border-b bg-transparent px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger value="files" className={TAB_TRIGGER_CLASS}>
            <FolderOpenIcon className="size-3.5" />
            文件
          </TabsTrigger>
          <TabsTrigger value="browser" className={TAB_TRIGGER_CLASS}>
            <GlobeIcon className="size-3.5" />
            浏览器
          </TabsTrigger>
          <TabsTrigger value="terminal" className={TAB_TRIGGER_CLASS}>
            <SquareTerminalIcon className="size-3.5" />
            终端
          </TabsTrigger>
          <TabsTrigger value="tasks" className={TAB_TRIGGER_CLASS}>
            <ListTodoIcon className="size-3.5" />
            任务
          </TabsTrigger>
          <TabsTrigger value="changes" className={TAB_TRIGGER_CLASS}>
            <FileDiffIcon className="size-3.5" />
            变更
          </TabsTrigger>
          <TabsTrigger value="git" className={TAB_TRIGGER_CLASS}>
            <GitBranchIcon className="size-3.5" />
            Git
          </TabsTrigger>
          <TabsTrigger value="tools" className={TAB_TRIGGER_CLASS}>
            <WrenchIcon className="size-3.5" />
            工具结果
          </TabsTrigger>
          <TabsTrigger value="usage" className={TAB_TRIGGER_CLASS}>
            <BarChart3Icon className="size-3.5" />
            用量
          </TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="m-0 min-h-0 flex-1 overflow-hidden p-3">
          <FileBrowser
            key={project?.id ?? "workspace"}
            project={project}
            onOpenFile={onOpenFile}
          />
        </TabsContent>
        {/* forceMount 保持 iframe 与导航历史跨标签存活；Radix 对 forceMount
            的内容不设 hidden，需要自己按 data-state 收起，否则浏览器会
            叠进其他标签页的内容区 */}
        <TabsContent
          value="browser"
          forceMount
          className="m-0 min-h-0 flex-1 overflow-hidden p-0 data-[state=inactive]:hidden"
        >
          <BrowserPane target={previewTarget} />
        </TabsContent>
        {/* forceMount 保持 PTY 会话与输出流跨标签存活（同浏览器页签） */}
        <TabsContent
          value="terminal"
          forceMount
          className="m-0 min-h-0 flex-1 overflow-hidden p-0 data-[state=inactive]:hidden"
        >
          <TerminalPane key={project?.id ?? "workspace"} project={project} />
        </TabsContent>
        <TabsContent value="tasks" className="m-0 min-h-0 flex-1 overflow-y-auto p-3">
          <TaskList tasks={tasks} />
        </TabsContent>
        <TabsContent value="changes" className="m-0 min-h-0 flex-1 overflow-hidden p-3">
          <ChangesPanel key={project?.id ?? "workspace"} project={project} sessionId={sessionId} busy={busy} />
        </TabsContent>
        <TabsContent value="git" className="m-0 min-h-0 flex-1 overflow-hidden p-3">
          <GitPanel key={project?.id ?? "workspace"} project={project} />
        </TabsContent>
        <TabsContent value="tools" className="m-0 min-h-0 flex-1 overflow-y-auto p-3">
          <ToolResults
            messages={messages}
            selectedToolId={selectedToolId}
            onToolSelect={onToolSelect}
            onOpenLink={onOpenLink}
          />
        </TabsContent>
        <TabsContent value="usage" className="m-0 min-h-0 flex-1 overflow-y-auto p-3">
          <UsageView messages={messages} contextWindow={contextWindow} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/** Memoized: during streaming the messages array gets a new identity on every
 * chunk. App passes a stable empty array except on the tools/usage tabs, so
 * the panel and its children skip re-rendering entirely while the agent runs. */
export const RightPanel = memo(RightPanelBase);
RightPanel.displayName = "RightPanel";

/** 面板标签的选中态：只保留淡主题色背景与主题色文字，
 * 覆盖掉基础样式的边框、阴影和白底。 */
const TAB_TRIGGER_CLASS = cn(
  "h-7 gap-1.5 px-2.5 text-xs",
  "data-[state=active]:border-transparent data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none",
  "dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-primary/20 dark:data-[state=active]:text-primary",
  "group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none",
);

function EmptyNote({ text }: { text: string }) {
  return <p className="py-10 text-center text-xs text-muted-foreground">{text}</p>;
}

/** 这些扩展名的文件文本视图显示不了（office）或体验差（大图），点击时
 * 改在预览面板打开：office 走 file-viewer，图片/PDF 走 /preview 路由。 */
const PANEL_PREVIEW_EXTENSIONS = new Set([
  "pptx", "docx", "xlsx", "pdf",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "ico",
  "mp4", "webm", "mp3", "wav",
]);

function fileExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function FileBrowser({
  project,
  onOpenFile,
}: {
  project?: ProjectInfo | null;
  onOpenFile?: (filePath: string) => void;
}) {
  const rootPath = project?.rootPath ?? "";
  const rootLabel =
    project?.name ??
    rootPath.split(/[\\/]/).filter(Boolean).at(-1) ??
    "工作区";

  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRef = useRef<Set<string>>(new Set());

  const load = useCallback((path: string) => {
    if (loadedRef.current.has(path)) return;
    loadedRef.current.add(path);
    listFiles(path)
      .then((list) => setEntries((prev) => ({ ...prev, [path]: list })))
      .catch(() => loadedRef.current.delete(path));
  }, []);

  useEffect(() => {
    load(rootPath);
  }, [load, rootPath, reloadToken]);

  const refresh = useCallback(() => {
    loadedRef.current = new Set();
    setEntries({});
    setExpanded(new Set());
    setSelected(undefined);
    setSelectedFile(undefined);
    setReloadToken((token) => token + 1);
  }, []);

  const handleExpandedChange = useCallback(
    (next: Set<string>) => {
      setExpanded(next);
      for (const path of next) load(path);
    },
    [load],
  );

  // Workspace mode uses workspace-relative paths ("a/b.txt"); project mode
  // uses absolute paths rooted at the project folder.
  const childPath = (dirPath: string, name: string) => {
    if (!dirPath) return rootPath ? `${rootPath.replaceAll("\\", "/")}/${name}` : name;
    return `${dirPath.replaceAll("\\", "/")}/${name}`;
  };

  const isFilePath = useCallback(
    (path: string) => {
      for (const [dirPath, list] of Object.entries(entries)) {
        if (list.some((entry) => entry.isFile && childPath(dirPath, entry.name) === path)) {
          return true;
        }
      }
      return false;
    },
    [entries, rootPath], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleSelect = useCallback(
    (path: string) => {
      setSelected(path);
      if (!isFilePath(path)) return;
      // 文本类文件留在面板内查看；office/图片等走预览面板（浏览器标签）。
      if (PANEL_PREVIEW_EXTENSIONS.has(fileExtension(path))) {
        onOpenFile?.(path);
        return;
      }
      setSelectedFile(path);
    },
    [isFilePath, onOpenFile],
  );

  const renderDir = (dirPath: string): ReactNode =>
    (entries[dirPath] ?? []).map((entry) => {
      const path = childPath(dirPath, entry.name);
      return entry.isDirectory ? (
        <FileTreeFolder key={path} path={path} name={entry.name}>
          {expanded.has(path) ? renderDir(path) : null}
        </FileTreeFolder>
      ) : (
        <FileTreeFile key={path} path={path} name={entry.name} />
      );
    });

  const rootLoaded = rootPath in entries;

  if (selectedFile) {
    return (
      <FileContentView
        filePath={selectedFile}
        rootPath={rootPath}
        onBack={() => setSelectedFile(undefined)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{rootLabel}</span>
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={refresh}
          title="刷新"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileTree
          expanded={expanded}
          onExpandedChange={handleExpandedChange}
          selectedPath={selected}
          onSelect={handleSelect}
          className="rounded-none border-0"
        >
          {rootLoaded ? (
            renderDir(rootPath)
          ) : (
            <EmptyNote text={project ? "正在加载项目文件…" : "正在加载工作区…"} />
          )}
          {rootLoaded && (entries[rootPath] ?? []).length === 0 ? (
            <EmptyNote text="文件夹为空。" />
          ) : null}
        </FileTree>
      </div>
    </div>
  );
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  cjs: "javascript", json: "json", jsonc: "json", rs: "rust", py: "python",
  go: "go", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", sql: "sql",
  html: "html", htm: "html", css: "css", scss: "scss", vue: "vue",
  yml: "yaml", yaml: "yaml", toml: "toml", md: "markdown", mdx: "markdown",
  xml: "xml", dockerfile: "dockerfile", prisma: "prisma", graphql: "graphql",
  gql: "graphql", ini: "ini", lua: "lua", zig: "zig",
};

function languageForFile(filePath: string): string {
  const name = filePath.split("/").at(-1) ?? "";
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGE[extension] ?? "text";
}

function FileContentView({
  filePath,
  rootPath,
  onBack,
}: {
  filePath: string;
  rootPath: string;
  onBack: () => void;
}) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const rootPrefix = rootPath ? `${rootPath.replaceAll("\\", "/")}/` : "";
  const relativePath = rootPrefix && filePath.startsWith(rootPrefix)
    ? filePath.slice(rootPrefix.length)
    : filePath;

  useEffect(() => {
    setContent(undefined);
    setError(undefined);
    let cancelled = false;
    readFileContent(filePath)
      .then((file) => {
        if (!cancelled) setContent(file.content);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "读取文件失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={onBack} title="返回文件树">
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={filePath}>
          {relativePath || filePath}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
        {error ? (
          <EmptyNote text={error} />
        ) : content === undefined ? (
          <EmptyNote text="正在加载文件…" />
        ) : (
          <CodeBlock
            code={content}
            language={languageForFile(filePath) as never}
            showLineNumbers
            className="rounded-none border-0 bg-transparent"
          />
        )}
      </div>
    </div>
  );
}

const TASK_STATUS_ICONS = {
  pending: <CircleIcon className="size-4 text-muted-foreground" />,
  in_progress: <LoaderCircleIcon className="size-4 animate-spin text-blue-600" />,
  completed: <CheckCircleIcon className="size-4 text-green-600" />,
} as const;

function TaskList({ tasks }: { tasks: AgentTaskInfo[] }) {
  if (tasks.length === 0) {
    return <EmptyNote text="当前会话暂无任务。" />;
  }

  const completedCount = tasks.filter((task) => task.status === "completed").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>共 {tasks.length} 个</span>
        <span>已完成 {completedCount} 个</span>
      </div>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-start gap-2.5 rounded-md border p-2.5">
            <span className="mt-0.5 shrink-0">{TASK_STATUS_ICONS[task.status]}</span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p
                  className={cn(
                    "min-w-0 flex-1 text-sm font-medium",
                    task.status === "completed" && "text-muted-foreground line-through",
                  )}
                >
                  #{task.taskId} {task.subject}
                </p>
                <Badge
                  variant={task.status === "completed" ? "secondary" : "outline"}
                  className="shrink-0 text-[10px]"
                >
                  {task.status === "in_progress"
                    ? "进行中"
                    : task.status === "pending"
                      ? "待处理"
                      : "已完成"}
                </Badge>
              </div>
              {task.status === "in_progress" && task.activeForm ? (
                <p className="text-xs text-blue-600">{task.activeForm}</p>
              ) : null}
              {task.description ? (
                <p className="text-xs text-muted-foreground">{task.description}</p>
              ) : null}
              {task.blockedBy.length > 0 ? <DependencyTags label="阻塞于" ids={task.blockedBy} /> : null}
              {task.blocks.length > 0 ? <DependencyTags label="阻塞" ids={task.blocks} /> : null}
              {task.owner ? (
                <p className="font-mono text-[10px] text-muted-foreground">{task.owner}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DependencyTags({ label, ids }: { label: string; ids: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
      <span>{label}</span>
      {ids.map((id) => (
        <Badge key={`${label}-${id}`} variant="outline" className="px-1.5 py-0 text-[10px]">
          #{id}
        </Badge>
      ))}
    </div>
  );
}

function ToolResults({
  messages,
  selectedToolId,
  onToolSelect,
  onOpenLink,
}: {
  messages: ChatUIMessage[];
  selectedToolId?: string;
  onToolSelect: (id: string) => void;
  onOpenLink?: (url: string) => void;
}) {
  // messages changes identity on every stream chunk while this tab is open;
  // the scan is O(all parts), so memoize instead of running it per chunk.
  const calls = useMemo(() => collectToolCalls(messages), [messages]);
  const selected = calls.find((call) => call.id === selectedToolId) ?? calls.at(-1);

  if (calls.length === 0) {
    return <EmptyNote text="当前会话暂无工具调用。" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {calls.map((call) => (
          <button
            key={call.id}
            type="button"
            onClick={() => onToolSelect(call.id)}
            className={cn(
              "cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors",
              selected?.id === call.id
                ? "border-transparent bg-accent text-accent-foreground"
                : "hover:bg-muted",
            )}
          >
            {call.name}
          </button>
        ))}
      </div>
      {selected ? <ToolDetail call={selected} onOpenLink={onOpenLink} /> : null}
    </div>
  );
}

function ToolDetail({ call, onOpenLink }: { call: ToolCallRef; onOpenLink?: (url: string) => void }) {
  const { part } = call;
  const name = toolNameOf(part);
  const output = "output" in part ? part.output : undefined;
  const outputRecord =
    output && typeof output === "object" && !(output instanceof Error)
      ? (output as Record<string, unknown>)
      : undefined;
  const editDiff =
    (name === "editFile" || name === "writeFile") &&
    part.state === "output-available" &&
    typeof outputRecord?.path === "string"
      ? {
          path: outputRecord.path as string,
          unifiedDiff:
            typeof outputRecord.unifiedDiff === "string" ? outputRecord.unifiedDiff : null,
          additions: typeof outputRecord.additions === "number" ? outputRecord.additions : undefined,
          deletions: typeof outputRecord.deletions === "number" ? outputRecord.deletions : undefined,
        }
      : undefined;
  const gitDiffText =
    name === "gitDiff" && typeof outputRecord?.diff === "string" && outputRecord.diff !== "(no changes)"
      ? (outputRecord.diff as string)
      : undefined;
  const searchOutput = extractWebSearchOutput(name, part);
  const fetchOutput = extractWebFetchOutput(name, part);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{call.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{call.id}</p>
        </div>
        {getStatusBadge(part.state)}
      </div>

      {"input" in part && part.input !== undefined ? <ToolInput input={part.input} /> : null}

      {"errorText" in part && part.errorText ? (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {friendlyErrorText(part.errorText)}
        </div>
      ) : null}

      {editDiff ? (
        <DiffCard
          title={editDiff.path}
          diff={editDiff.unifiedDiff}
          additions={editDiff.additions}
          deletions={editDiff.deletions}
        />
      ) : gitDiffText ? (
        <DiffCard title="git diff" diff={gitDiffText} />
      ) : searchOutput ? (
        <WebSearchResults output={searchOutput} onOpenLink={onOpenLink} />
      ) : fetchOutput ? (
        <WebFetchContent output={fetchOutput} />
      ) : output !== undefined ? (
        <CodeBlock
          code={
            typeof output === "string"
              ? output
              : (stringifyToolOutput(output) ?? "")
          }
          language={call.name === "bash" ? "powershell" : "json"}
        />
      ) : null}
    </div>
  );
}

const USAGE_DEFAULT_CONTEXT_WINDOW = 128_000;
const USAGE_RING_RADIUS = 15;
const USAGE_RING_CIRCUMFERENCE = 2 * Math.PI * USAGE_RING_RADIUS;

function positiveCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function UsageSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border p-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function UsageRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** 用量页：上下文占用（环形）、窗口用量、本回合吞吐与 Provider 明细、
 * 会话累计、工具 token 估算。参考 PI-Desktop 的 ContextUsageInspector。 */
function UsageView({
  messages,
  contextWindow,
}: {
  messages: ChatUIMessage[];
  contextWindow?: number;
}) {
  const stats = useMemo(() => collectUsage(messages), [messages]);
  const usage = useMemo(() => collectUsageSummary(messages), [messages]);
  const tools = useMemo(() => collectToolTokenUsage(messages), [messages]);

  const safeWindow =
    positiveCount(contextWindow) || USAGE_DEFAULT_CONTEXT_WINDOW;
  const latest = usage.latest;
  // 上下文占用以最近一个回合的 totalTokens 为准（服务端按整段上下文计费）。
  const usedTokens = positiveCount(latest?.totalTokens);
  const remainingTokens = Math.max(0, safeWindow - usedTokens);
  const remainingRatio = 1 - Math.min(1, usedTokens / safeWindow);
  const remainingPercent = Math.round(remainingRatio * 100);
  const level =
    remainingPercent <= 10 ? "critical" : remainingPercent <= 25 ? "warning" : "ok";
  const ringColor =
    level === "critical"
      ? "stroke-red-500"
      : level === "warning"
        ? "stroke-yellow-500"
        : "stroke-primary";

  const throughput =
    latest && latest.durationMs > 0 && latest.outputTokens > 0
      ? Math.round(latest.outputTokens / (latest.durationMs / 1000))
      : undefined;
  const promptTokens =
    positiveCount(latest?.inputTokens) + positiveCount(latest?.cacheReadTokens);
  const cacheRate =
    latest && promptTokens > 0
      ? Math.round((positiveCount(latest.cacheReadTokens) / promptTokens) * 100)
      : undefined;

  if (!latest) {
    return (
      <EmptyNote text="完成一次对话后，这里会展示上下文占用与 token 用量。" />
    );
  }

  return (
    <div className="space-y-3">
      {/* 上下文剩余 + 窗口占用 */}
      <section className="rounded-lg border p-3">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 36 36" className="size-16 shrink-0 -rotate-90" aria-hidden>
            <circle
              className="fill-none stroke-muted"
              cx="18"
              cy="18"
              r={USAGE_RING_RADIUS}
              strokeWidth="3.5"
            />
            <circle
              className={`fill-none ${ringColor} transition-[stroke-dashoffset]`}
              cx="18"
              cy="18"
              r={USAGE_RING_RADIUS}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={USAGE_RING_CIRCUMFERENCE}
              strokeDashoffset={USAGE_RING_CIRCUMFERENCE * (1 - remainingRatio)}
            />
          </svg>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">上下文剩余</p>
            <p className="text-2xl font-semibold tabular-nums">
              {remainingPercent}%
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatTokenCount(remainingTokens)} token
            </p>
          </div>
        </div>
        <div className="mt-3 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">上下文窗口</span>
            <span className="font-medium tabular-nums">
              {formatTokenCount(usedTokens)} / {formatTokenCount(safeWindow)}
              <span className="ml-1.5 text-muted-foreground">
                {100 - remainingPercent}%
              </span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${
                level === "critical"
                  ? "bg-red-500"
                  : level === "warning"
                    ? "bg-yellow-500"
                    : "bg-primary"
              }`}
              style={{ width: `${Math.min(100, 100 - remainingPercent)}%` }}
            />
          </div>
        </div>
      </section>

      {/* 本回合 */}
      <UsageSection title="本回合">
        <div className="grid grid-cols-2 gap-x-3">
          <UsageRow
            label="Token 总量"
            value={formatTokenCount(positiveCount(latest.totalTokens))}
          />
          <UsageRow
            label="输出速度"
            value={throughput !== undefined ? `${formatTokenCount(throughput)} tok/s` : "—"}
          />
          <UsageRow label="耗时" value={formatDuration(latest.durationMs)} />
          <UsageRow
            label="模型"
            value={<span className="truncate">{latest.modelId ?? "—"}</span>}
          />
        </div>
      </UsageSection>

      {/* Provider 用量明细（本回合） */}
      <UsageSection title="Provider 用量（本回合）">
        <div className="grid grid-cols-2 gap-x-3">
          <UsageRow label="输入" value={formatTokenCount(positiveCount(latest.inputTokens))} />
          <UsageRow label="输出" value={formatTokenCount(positiveCount(latest.outputTokens))} />
          <UsageRow
            label="缓存读取"
            value={
              latest.cacheReadTokens > 0
                ? formatTokenCount(positiveCount(latest.cacheReadTokens))
                : "—"
            }
          />
          <UsageRow
            label="缓存率"
            value={cacheRate !== undefined ? `${cacheRate}%` : "—"}
          />
          <UsageRow
            label="缓存写入"
            value={
              latest.cacheWriteTokens > 0
                ? formatTokenCount(positiveCount(latest.cacheWriteTokens))
                : "—"
            }
          />
          <UsageRow
            label="推理"
            value={
              latest.reasoningTokens > 0
                ? formatTokenCount(positiveCount(latest.reasoningTokens))
                : "—"
            }
          />
        </div>
      </UsageSection>

      {/* 会话累计 */}
      <UsageSection title="会话累计">
        <div className="grid grid-cols-2 gap-x-3">
          <UsageRow label="回合数" value={String(usage.totals.turns)} />
          <UsageRow
            label="总 Token"
            value={formatTokenCount(usage.totals.totalTokens)}
          />
          <UsageRow
            label="总耗时"
            value={formatDuration(usage.totals.durationMs)}
          />
          <UsageRow label="总输入" value={formatTokenCount(usage.totals.inputTokens)} />
          <UsageRow label="总输出" value={formatTokenCount(usage.totals.outputTokens)} />
          <UsageRow label="工具调用" value={String(stats.toolCalls)} />
          <UsageRow label="用户消息" value={String(stats.userMessages)} />
          <UsageRow label="助手消息" value={String(stats.assistantMessages)} />
        </div>
      </UsageSection>

      {/* 工具 token 估算（序列化长度 / 4） */}
      <UsageSection title={`工具调用（估算 · ${tools.length} 种）`}>
        {tools.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无工具调用</p>
        ) : (
          <ul className="space-y-1">
            {tools.map((tool) => (
              <li
                key={tool.toolName}
                className="flex items-baseline justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {tool.toolName}
                </span>
                <span className="shrink-0 tabular-nums">
                  {tool.callCount} 次 · ~{formatTokenCount(tool.totalTokens)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </UsageSection>
    </div>
  );
}
