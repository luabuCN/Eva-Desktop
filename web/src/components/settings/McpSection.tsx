import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlaskConical,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Trash2,
} from "lucide-react";

import {
  deleteMcpServer,
  listMcpServers,
  listProjects,
  setMcpServerEnabled,
  testMcpServer,
  type McpServerInfo,
  type McpServerState,
  type ProjectInfo,
} from "@/api";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { McpFormSheet } from "./McpFormSheet";

/** MCP 服务器管理（参考 PI-Desktop 的 AgentMcpPage）：全局级 / 项目级两组，
 * 支持筛选、搜索、启停、编辑、删除与连接测试；启用且连接成功的服务器，
 * 其工具会以 mcp__<服务器>__<工具> 形式进入模型上下文。 */

type ScopeFilter = "all" | "global" | "project";

const STATE_META: Record<McpServerState, { label: string; className: string }> = {
  ready: { label: "已就绪", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  connecting: { label: "连接中", className: "text-muted-foreground" },
  failed: { label: "连接失败", className: "border-destructive/40 text-destructive" },
  idle: { label: "未连接", className: "text-muted-foreground" },
};

function StatusBadge({ server }: { server: McpServerInfo }) {
  const status = server.status;
  if (!status || status.state === "idle") return <Badge variant="outline">未连接</Badge>;
  const meta = STATE_META[status.state];
  if (status.state === "ready") {
    const names = status.toolNames ?? [];
    // 服务端最多带回 50 个名字；超出部分在提示里说明数量。
    const hidden = Math.max(0, status.toolCount - names.length);
    const badge = (
      <Badge variant="outline" className={meta.className}>
        <span className="mr-1 inline-block size-1.5 rounded-full bg-current" />
        {status.toolCount} 个工具
      </Badge>
    );
    if (names.length === 0) return badge;
    return (
      <Tooltip delayDuration={100}>
        <TooltipTrigger asChild>
          {/* 包一层 button：触摸/键盘聚焦即可弹出工具清单，不必精确悬停。 */}
          <button
            type="button"
            aria-label={`查看 ${server.label} 的全部工具`}
            className="rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {badge}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="w-fit max-w-80 p-2">
          <div className="mb-1 text-xs font-medium">全部工具（{status.toolCount}）</div>
          <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {names.map((name) => (
              <li key={name} className="font-mono text-[11px] leading-4">
                {name}
              </li>
            ))}
            {hidden > 0 ? (
              <li className="text-[11px] leading-4 opacity-70">…另有 {hidden} 个未列出</li>
            ) : null}
          </ul>
        </TooltipContent>
      </Tooltip>
    );
  }
  if (status.state === "connecting") {
    return (
      <Badge variant="outline" className={meta.className}>
        <Loader2 size={10} className="mr-1 animate-spin" />
        连接中
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={meta.className} title={status.message ?? undefined}>
      <span className="mr-1 inline-block size-1.5 rounded-full bg-current" />
      连接失败
    </Badge>
  );
}

function ServerRow({
  server,
  level,
  onEdit,
  onDelete,
  onTest,
  onToggle,
  testing,
}: {
  server: McpServerInfo;
  level: "global" | "project";
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  testing: boolean;
}) {
  const commandLine =
    server.transport === "http"
      ? server.url ?? ""
      : [server.command, ...server.args].filter(Boolean).join(" ");
  return (
    <Item variant="outline" className={cn(!server.enabled && "opacity-60")}>
      <ItemContent>
        <ItemTitle>
          {server.transport === "http" ? <Server size={16} /> : <Terminal size={16} />}
          <span className="font-medium">{server.label}</span>
          <code className="text-xs text-muted-foreground">{server.id}</code>
          <Badge variant="secondary">{server.transport === "http" ? "HTTP" : "STDIO"}</Badge>
          <StatusBadge server={server} />
        </ItemTitle>
        <p className="line-clamp-1 font-mono text-xs text-muted-foreground" title={commandLine}>
          {commandLine || "（未配置）"}
        </p>
        {server.description ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{server.description}</p>
        ) : null}
        {server.status?.state === "failed" && server.status.message ? (
          <p className="line-clamp-1 text-xs text-destructive" title={server.status.message}>
            {server.status.message}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          title="连接并清点工具"
          disabled={testing}
          onClick={onTest}
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
          测试
        </Button>
        <Button variant="outline" size="icon-sm" title="编辑" onClick={onEdit}>
          <Pencil size={14} />
        </Button>
        <Button
          variant="destructive"
          size="icon-sm"
          title="删除"
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </Button>
        <Switch
          checked={server.enabled}
          disabled={testing}
          onCheckedChange={(checked) => onToggle(!!checked)}
        />
      </ItemActions>
      <span className="sr-only">{level === "global" ? "全局级" : "项目级"}</span>
    </Item>
  );
}

function EmptyCard({
  message,
  hint,
  action,
}: {
  message: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <Server size={20} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
      {action}
    </div>
  );
}

export function McpSection() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerInfo | null>(null);
  const [deleting, setDeleting] = useState<McpServerInfo | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [serverList, projectList] = await Promise.all([listMcpServers(), listProjects()]);
      setServers(serverList);
      setProjects(projectList);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载 MCP 服务器失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 默认选中第一个项目，让项目级分组立即可用（截图里也默认选中当前项目）。
  useEffect(() => {
    if (selectedProjectId === undefined && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const matches = useCallback(
    (server: McpServerInfo) => {
      const query = search.trim().toLowerCase();
      if (!query) return true;
      return [server.label, server.id, server.description ?? "", server.command ?? "", server.url ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(query);
    },
    [search],
  );

  const globalServers = useMemo(
    () => servers.filter((server) => server.projectId === null && matches(server)),
    [servers, matches],
  );
  const projectServers = useMemo(
    () =>
      servers.filter(
        (server) => server.projectId != null && server.projectId === selectedProjectId && matches(server),
      ),
    [servers, selectedProjectId, matches],
  );
  const counts = {
    all: globalServers.length + projectServers.length,
    global: globalServers.length,
    project: projectServers.length,
  };

  const patchServer = (id: string, patch: Partial<McpServerInfo>) => {
    setServers((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  async function toggle(server: McpServerInfo, enabled: boolean) {
    patchServer(server.id, { enabled });
    try {
      const updated = await setMcpServerEnabled(server.id, enabled);
      patchServer(server.id, { ...updated, enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新失败");
      patchServer(server.id, { enabled: server.enabled });
    }
  }

  async function test(server: McpServerInfo) {
    setTestingId(server.id);
    patchServer(server.id, {
      status: { serverId: server.id, state: "connecting", toolCount: 0, updatedAt: Date.now() },
    });
    try {
      const status = await testMcpServer(server.id);
      patchServer(server.id, { status });
    } catch (cause) {
      patchServer(server.id, {
        status: {
          serverId: server.id,
          state: "failed",
          toolCount: 0,
          message: cause instanceof Error ? cause.message : "测试失败",
          updatedAt: Date.now(),
        },
      });
    } finally {
      setTestingId(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await deleteMcpServer(target.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    }
  }

  /** 新增落到当前筛选指向的作用域：项目筛选 → 选中项目，否则全局。 */
  const createTargetProjectId =
    filter === "project" && selectedProjectId ? selectedProjectId : null;
  const addButton = (
    <Button
      onClick={() => {
        setEditing(null);
        setFormOpen(true);
      }}
    >
      <Plus size={14} />
      新增
    </Button>
  );

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const renderRows = (list: McpServerInfo[], level: "global" | "project") =>
    list.map((server) => (
      <ServerRow
        key={`${level}:${server.id}`}
        server={server}
        level={level}
        testing={testingId === server.id}
        onEdit={() => {
          setEditing(server);
          setFormOpen(true);
        }}
        onDelete={() => setDeleting(server)}
        onTest={() => void test(server)}
        onToggle={(enabled) => void toggle(server, enabled)}
      />
    ));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 p-4">
        <div>
          <div className="text-base font-semibold">MCP 服务器</div>
          <p className="text-xs text-muted-foreground">
            配置 Model Context Protocol 服务器，为智能体扩展外部工具；启用后工具以 mcp__服务器__工具 命名进入模型。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => void refresh()} title="重新加载">
            <RefreshCw size={14} />
            刷新
          </Button>
          {addButton}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <div className="flex items-center rounded-md border p-0.5">
          {(
            [
              ["all", `全部 ${counts.all}`],
              ["global", `全局 ${counts.global}`],
              ["project", `项目 ${counts.project}`],
            ] as Array<[ScopeFilter, string]>
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                filter === value
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFilter(value)}
            >
              {text}
            </button>
          ))}
        </div>
        {showProject ? (
          <Select
            value={selectedProjectId ?? ""}
            onValueChange={(value) => setSelectedProjectId(value || undefined)}
          >
            <SelectTrigger size="sm" className="w-48">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              {projects.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">暂无项目</div>
              ) : (
                projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        ) : null}
        <div className="relative ml-auto">
          <Search
            size={14}
            className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="h-8 w-56 pl-8 text-xs"
            placeholder="搜索名称 / 命令 / URL"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {error ? <p className="px-4 pb-2 text-xs text-destructive">{error}</p> : null}

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            加载中...
          </p>
        ) : counts.all === 0 && search.trim() ? (
          <div className="p-4">
            <EmptyCard message="没有匹配的 MCP 服务器" hint="换个关键词，或清空搜索查看全部。" />
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-4 pt-1">
            {showGlobal ? (
              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 px-1 text-sm font-medium">
                  <Globe size={14} />
                  全局级
                  <span className="text-xs font-normal text-muted-foreground">
                    {globalServers.length} 个 · 对所有项目生效
                  </span>
                </div>
                {globalServers.length === 0 ? (
                  <EmptyCard
                    message="暂无全局 MCP 服务器"
                    hint="添加后所有项目的会话都可使用其工具。"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-1"
                        onClick={() => {
                          setFilter("global");
                          setEditing(null);
                          setFormOpen(true);
                        }}
                      >
                        <Plus size={13} />
                        新增
                      </Button>
                    }
                  />
                ) : (
                  renderRows(globalServers, "global")
                )}
              </section>
            ) : null}
            {showProject ? (
              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 px-1 text-sm font-medium">
                  <Server size={14} />
                  项目级
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {projectServers.length} 个 ·{" "}
                    {selectedProject
                      ? `仅对「${selectedProject.name}」生效`
                      : "选择项目后管理"}
                  </span>
                </div>
                {!selectedProject ? (
                  <EmptyCard message="先在上方选择一个项目" hint="项目级服务器只在该项目的会话中连接。" />
                ) : projectServers.length === 0 ? (
                  <EmptyCard
                    message={`「${selectedProject.name}」暂无项目级 MCP 服务器`}
                    hint="作用域选为该项目的服务器只在此出现。"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-1"
                        onClick={() => {
                          setFilter("project");
                          setEditing(null);
                          setFormOpen(true);
                        }}
                      >
                        <Plus size={13} />
                        新增
                      </Button>
                    }
                  />
                ) : (
                  renderRows(projectServers, "project")
                )}
              </section>
            ) : null}
          </div>
        )}
      </ScrollArea>

      <McpFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        projects={projects}
        defaultProjectId={createTargetProjectId}
        onSaved={() => void refresh()}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除 MCP 服务器「{deleting?.label ?? ""}」？将断开其连接并移除配置，操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void remove()}
            >
              <Trash2 size={14} />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
