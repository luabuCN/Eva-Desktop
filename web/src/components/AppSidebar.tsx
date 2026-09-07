import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Archive,
  CalendarClock,
  ChevronDown,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { ProjectInfo, SessionSummary } from "@/api";
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
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ProjectForm } from "@/components/settings/ProjectForm";

export interface AppSidebarProps {
  sessions: SessionSummary[];
  sessionId: string;
  loading: boolean;
  error?: string;
  projects: ProjectInfo[];
  activeProjectId?: string;
  onSelectProject: (projectId?: string) => void;
  /** Selecting a session under a project also switches the project context. */
  onSelect: (id: string, projectId?: string) => void;
  onNew: () => void;
  /** 在指定项目下新建对话（项目行右侧的 + 按钮）。 */
  onNewInProject: (projectId: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleProjectPin: (id: string, pinned: boolean) => void;
  onArchiveProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onProjectsChanged: () => void;
  onOpenSettings: () => void;
  /** 打开「自动化」定时任务页。 */
  onOpenAutomation: () => void;
  /** 当前是否处于自动化页（高亮侧边栏项）。 */
  automationActive?: boolean;
}

function CollapsibleGroup({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarGroup className="py-1">
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="w-full cursor-pointer">
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown className="ml-auto transition-transform group-data-[state=closed]/collapsible:-rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>{children}</CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

/**
 * Single-line title with ellipsis; when the text overflows, hovering pauses a
 * beat and then scrolls it back and forth until the pointer leaves. While the
 * scroll animation is active the inner span drops `truncate` (ellipsis) and
 * shrinks to content width so the full text slides without a trailing "...".
 */
function ScrollableTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState<number>();

  const handleMouseEnter = () => {
    const element = ref.current;
    if (!element) return;
    const overflow = element.scrollWidth - element.clientWidth;
    setScrollDistance(overflow > 4 ? overflow : undefined);
  };

  const scrolling = scrollDistance !== undefined;
  const style = scrolling
    ? ({
        "--scroll-distance": `${-scrollDistance}px`,
        animation: `session-title-scroll ${Math.max(2, scrollDistance / 40).toFixed(2)}s ease-in-out 0.35s infinite alternate`,
      } as CSSProperties)
    : undefined;

  return (
    <span className="min-w-0 flex-1 overflow-hidden">
      <span
        ref={ref}
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setScrollDistance(undefined)}
        className={
          scrolling
            ? "block w-max whitespace-nowrap text-sm"
            : "block truncate text-sm"
        }
      >
        {text}
      </span>
    </span>
  );
}

/**
 * 会话项左侧的运行状态点（参考 PI-Desktop）：
 * - 后台运行中：橙色呼吸圆点
 * - 等待审批：紫色脉冲圆点
 * 空闲会话不显示任何点。
 */
function SessionStatusDot({ status }: { status?: string | null }) {
  if (status === "waiting_approval") {
    return <span className="oh-session-dot oh-session-dot--waiting" title="等待审批" />;
  }
  if (status === "running" || status === "queued") {
    return <span className="oh-session-dot oh-session-dot--running" title="后台运行中" />;
  }
  return null;
}

/** 会话项「···」悬浮菜单里的重命名对话框（参考 PI-Desktop 的重命名任务）。 */
function RenameSessionDialog({
  target,
  onConfirm,
  onOpenChange,
}: {
  target: { id: string; title: string };
  onConfirm: (id: string, title: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(target.title);

  // 每次打开都重新初始化输入值并全选，方便直接覆盖输入。
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const submit = () => {
    const title = value.trim();
    if (!title || title === target.title) {
      onOpenChange(false);
      return;
    }
    onConfirm(target.id, title);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名对话</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            ref={inputRef}
            autoFocus
            value={value}
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
            placeholder="对话标题"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AppSidebar({
  sessions,
  sessionId,
  loading,
  error,
  projects,
  activeProjectId,
  onSelectProject,
  onSelect,
  onNew,
  onNewInProject,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
  onToggleProjectPin,
  onArchiveProject,
  onDeleteProject,
  onProjectsChanged,
  onOpenSettings,
  onOpenAutomation,
  automationActive,
}: AppSidebarProps) {
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectInfo | null>(null);
  // Undefined = never toggled; falls back to "open when project is active".
  const [projectExpanded, setProjectExpanded] = useState<Record<string, boolean>>({});
  // 当前悬停的行（会话 id / 项目 id）。悬浮按钮的显隐由它驱动而不是 CSS
  // group-hover：触摸屏点击后 :hover 会粘滞到下一次点击，纯 CSS 会出现
  // 多行按钮同时常显；JS 状态永远只保留最近交互的一行。
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // 归档项目不在侧栏展示（设置页归档分区管理）；置顶排序由服务端返回顺序决定。
  const visibleProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects],
  );

  const projectSessions = useMemo(() => {
    const grouped = new Map<string, SessionSummary[]>();
    for (const project of projects) grouped.set(project.id, []);
    const recent: SessionSummary[] = [];
    for (const session of sessions) {
      if (session.projectId && grouped.has(session.projectId)) {
        grouped.get(session.projectId)!.push(session);
      } else if (!session.projectId) {
        recent.push(session);
      }
    }
    return { grouped, recent };
  }, [sessions, projects]);

  // 悬浮操作按钮显隐：只认 hoveredKey（防触摸 :hover 粘滞导致多行常显），
  // 菜单展开（data-state=open）与键盘聚焦时单独保持可见可点。
  const actionClass = (visible: boolean, extra?: string) =>
    cn(
      "top-1/2! -translate-y-1/2 text-muted-foreground transition-opacity hover:text-sidebar-accent-foreground",
      extra,
      visible ? "opacity-100" : "pointer-events-none opacity-0",
      "focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
    );

  const renderSessionItem = (session: SessionSummary, projectId?: string) => (
    <SidebarMenuItem
      key={session.id}
      onMouseEnter={() => setHoveredKey(session.id)}
      onMouseLeave={() => setHoveredKey((key) => (key === session.id ? null : key))}
    >
      <SidebarMenuButton
        isActive={session.id === sessionId}
        onClick={() => onSelect(session.id, projectId)}
      >
        <SessionStatusDot status={session.activeRunStatus} />
        {session.pinned ? (
          <Pin aria-label="已置顶" className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
        <ScrollableTitle text={session.title} />
      </SidebarMenuButton>

      {/* 悬浮「···」菜单（参考 PI-Desktop）：触发器同时是菜单动作按钮，
          data-state=open 时保持可见。 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            className={actionClass(hoveredKey === session.id)}
            title="对话操作"
          >
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="min-w-36">
          <DropdownMenuItem onClick={() => setRenaming({ id: session.id, title: session.title })}>
            <Pencil />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onTogglePin(session.id, !session.pinned)}>
            {session.pinned ? <PinOff /> : <Pin />}
            {session.pinned ? "取消置顶" : "置顶"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onArchive(session.id)}>
            <Archive />
            归档
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(session.id)}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );

  const sessionList = (items: SessionSummary[], projectId?: string) =>
    items.length === 0 ? (
      <p className="px-2 py-4 text-center text-xs text-muted-foreground">
        {loading ? "加载中..." : "暂无对话"}
      </p>
    ) : (
      <SidebarMenu>{items.map((session) => renderSessionItem(session, projectId))}</SidebarMenu>
    );

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onNew}>
                <SquarePen className="text-muted-foreground" />
                <span>新对话</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setProjectFormOpen(true)}>
                <FolderPlus className="text-muted-foreground" />
                <span>新项目</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={automationActive}
                onClick={onOpenAutomation}
              >
                <CalendarClock className="text-muted-foreground" />
                <span>自动化</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent className="gap-0">
          <CollapsibleGroup label="项目">
            <SidebarGroupContent>
              {visibleProjects.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">暂无项目</p>
              ) : (
                <SidebarMenu>
                  {visibleProjects.map((project) => {
                    const open = projectExpanded[project.id] ?? project.id === activeProjectId;
                    return (
                      <Collapsible
                        key={project.id}
                        open={open}
                        onOpenChange={(next) =>
                          setProjectExpanded((prev) => ({ ...prev, [project.id]: next }))
                        }
                      >
                        <SidebarMenuItem>
                          {/* 项目行单独包一层 relative：SidebarMenuAction 的
                              top-1/2 只应相对行高居中，若直接放在含展开列表
                              的菜单项里，加号会掉到整组高度的中点。 */}
                          <div
                            className="relative"
                            onMouseEnter={() => setHoveredKey(project.id)}
                            onMouseLeave={() => setHoveredKey((key) => (key === project.id ? null : key))}
                          >
                            <CollapsibleTrigger asChild>
                              <SidebarMenuButton
                                isActive={project.id === activeProjectId}
                                title={project.rootPath}
                                onClick={() => onSelectProject(project.id)}
                              >
                                {open ? (
                                  <FolderOpen className="text-muted-foreground" />
                                ) : (
                                  <Folder className="text-muted-foreground" />
                                )}
                                {project.pinned ? (
                                  <Pin
                                    aria-label="已置顶"
                                    className="size-3 shrink-0 text-muted-foreground"
                                  />
                                ) : null}
                                <span className="truncate">{project.name}</span>
                              </SidebarMenuButton>
                            </CollapsibleTrigger>

                            {/* 项目「···」悬浮菜单：置顶 / 归档 / 删除（参考 PI-Desktop） */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <SidebarMenuAction
                                  className={actionClass(hoveredKey === project.id, "right-7!")}
                                  title="项目操作"
                                >
                                  <Ellipsis />
                                </SidebarMenuAction>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="min-w-36">
                                <DropdownMenuItem
                                  onClick={() => onToggleProjectPin(project.id, !project.pinned)}
                                >
                                  {project.pinned ? <PinOff /> : <Pin />}
                                  {project.pinned ? "取消置顶" : "置顶项目"}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onArchiveProject(project.id)}>
                                  <Archive />
                                  归档项目
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setDeletingProject(project)}
                                >
                                  <Trash2 />
                                  删除项目
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>

                            <SidebarMenuAction
                              className={actionClass(hoveredKey === project.id)}
                              onClick={() => onNewInProject(project.id)}
                              title="新建项目对话"
                            >
                              <Plus />
                            </SidebarMenuAction>
                          </div>
                          <CollapsibleContent>
                            <div className="mt-1 ml-4 py-1">
                              {sessionList(projectSessions.grouped.get(project.id) ?? [], project.id)}
                            </div>
                          </CollapsibleContent>
                        </SidebarMenuItem>
                      </Collapsible>
                    );
                  })}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </CollapsibleGroup>

          <CollapsibleGroup label="最近">
            <SidebarGroupContent>{sessionList(projectSessions.recent)}</SidebarGroupContent>
          </CollapsibleGroup>
        </SidebarContent>

        {error ? (
          <div className="border-t border-sidebar-border p-2 text-xs text-destructive">
            <span className="block truncate">{error}</span>
          </div>
        ) : null}

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onOpenSettings}>
                <Settings className="text-muted-foreground" />
                <span>设置</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <Dialog open={projectFormOpen} onOpenChange={setProjectFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>添加项目</DialogTitle>
          </DialogHeader>
          {projectFormOpen ? (
            <ProjectForm
              onSaved={(project) => {
                setProjectFormOpen(false);
                onProjectsChanged();
                onSelectProject(project.id);
              }}
              onCancel={() => setProjectFormOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {renaming ? (
        <RenameSessionDialog
          target={renaming}
          onConfirm={onRename}
          onOpenChange={() => setRenaming(null)}
        />
      ) : null}

      <AlertDialog
        open={deletingProject !== null}
        onOpenChange={(open) => !open && setDeletingProject(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除项目“{deletingProject?.name}”吗？项目下的对话会保留并移到“最近”，项目的默认配置将被移除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deletingProject) onDeleteProject(deletingProject.id);
                setDeletingProject(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
