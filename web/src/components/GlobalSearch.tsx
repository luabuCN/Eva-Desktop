import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  Bot,
  BotIcon,
  CalendarClock,
  Cloud,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Settings,
  Sparkles,
  SquarePen,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ProjectInfo, SessionSummary } from "@/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** 浏览态各分组最多展示的条数，控制面板高度接近 PI-Desktop。 */
const BROWSE_SESSION_RECENT_LIMIT = 7;
const BROWSE_PROJECT_LIMIT = 6;

const DAY_MS = 86_400_000;

/** 设置页分区键（与 SettingsPage 的 SettingsSectionKey 保持一致）。 */
export type GlobalSearchSettingsSection =
  | "general"
  | "projects"
  | "archive"
  | "agents"
  | "subagents"
  | "skills"
  | "models"
  | "tools";

export interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  projects: ProjectInfo[];
  currentSessionId?: string;
  onNewChat: () => void;
  onNewProject: () => void;
  onOpenAutomation: () => void;
  onOpenSettings: (section: GlobalSearchSettingsSection) => void;
  onSelectSession: (id: string, projectId?: string) => void;
  onSelectProject: (projectId: string) => void;
}

/** 小键帽（面板底部提示条用）。 */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / M月D日（跨年带年份）。 */
function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && isSameDay(date, now)) return `${hours} 小时前`;
  const yesterday = new Date(now.getTime() - DAY_MS);
  if (isSameDay(date, yesterday)) return "昨天";
  const days = Math.floor(diffMs / DAY_MS);
  if (days < 7) return `${days} 天前`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function isWithinDays(iso: string, days: number): boolean {
  return Date.now() - new Date(iso).getTime() < days * DAY_MS;
}

/** 面板列表项：图标 + 标题（可带副标题）+ 右侧 meta（时间 / 当前徽标）。 */
function ResultItem({
  icon: Icon,
  title,
  meta,
  subtitle,
  active,
  shortcutValue,
  onSelect,
}: {
  icon: LucideIcon;
  title: ReactNode;
  meta?: ReactNode;
  subtitle?: ReactNode;
  active?: boolean;
  /** cmdk 过滤用的匹配文本（标题 + 拼音外的英文别名等）。 */
  shortcutValue: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={shortcutValue}
      onSelect={onSelect}
      className="gap-3 rounded-md px-3 py-2"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span className="ml-auto flex max-w-44 shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground">
        {active ? (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            当前
          </span>
        ) : null}
        {meta}
      </span>
    </CommandItem>
  );
}

export function GlobalSearch({
  open,
  onOpenChange,
  sessions,
  projects,
  currentSessionId,
  onNewChat,
  onNewProject,
  onOpenAutomation,
  onOpenSettings,
  onSelectSession,
  onSelectProject,
}: GlobalSearchProps) {
  const [query, setQuery] = useState("");

  // 每次打开时清空上次的关键词，回到浏览态。
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  const recentProjects = useMemo(
    () =>
      projects
        .filter((project) => !project.archivedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );

  // 服务端已按更新时间倒序返回；浏览态只展示近 7 天的对话。
  const recentSessions = useMemo(
    () => sessions.filter((session) => isWithinDays(session.updatedAt, 7)),
    [sessions],
  );

  const browsing = query.trim() === "";

  const close = () => onOpenChange(false);
  // 先关面板再切视图，避免关闭动画与整页重挂载互相打架。
  const run = (action: () => void) => {
    close();
    requestAnimationFrame(action);
  };

  const sessionItems = (items: SessionSummary[]) =>
    items.map((session) => (
      <ResultItem
        key={session.id}
        icon={MessageSquare}
        shortcutValue={`${session.title} ${session.id}`}
        title={session.title || "未命名对话"}
        active={session.id === currentSessionId}
        subtitle={
          session.projectId
            ? (projectNameById.get(session.projectId) ?? "")
            : undefined
        }
        meta={formatRelativeTime(session.updatedAt)}
        onSelect={() =>
          run(() => onSelectSession(session.id, session.projectId ?? undefined))
        }
      />
    ));

  const projectItems = (items: ProjectInfo[]) =>
    items.map((project) => (
      <ResultItem
        key={project.id}
        icon={Folder}
        shortcutValue={`${project.name} ${project.rootPath}`}
        title={project.name}
        subtitle={project.rootPath}
        meta={formatRelativeTime(project.updatedAt)}
        onSelect={() => run(() => onSelectProject(project.id))}
      />
    ));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">全局搜索</DialogTitle>
        <DialogDescription className="sr-only">
          搜索对话、项目，或打开建议与配置命令
        </DialogDescription>
        <Command loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="搜索对话、项目或命令…"
            containerClassName="h-14 px-4"
            className="h-14 text-base"
          />

          <CommandList className="max-h-[min(56vh,420px)] px-2 py-2">
            <CommandEmpty>没有找到匹配的结果</CommandEmpty>

            {/* 搜索态第一项：用输入内容直接开启新对话 */}
            {browsing ? null : (
              <CommandGroup heading="快速操作">
                <ResultItem
                  icon={SquarePen}
                  shortcutValue={`新对话 ${query}`}
                  title={
                    <>
                      新建对话
                      {query.trim() ? (
                        <span className="text-muted-foreground">
                          ：{query.trim()}
                        </span>
                      ) : null}
                    </>
                  }
                  onSelect={() => run(onNewChat)}
                />
              </CommandGroup>
            )}

            {/* 建议分组：高频入口 */}
            <CommandGroup heading="建议">
              <ResultItem
                icon={SquarePen}
                shortcutValue="新对话 new chat"
                title="新对话"
                onSelect={() => run(onNewChat)}
              />
              <ResultItem
                icon={FolderPlus}
                shortcutValue="新项目 new project"
                title="新项目"
                onSelect={() => run(onNewProject)}
              />
              <ResultItem
                icon={CalendarClock}
                shortcutValue="自动化 定时任务 automation"
                title="自动化"
                subtitle="查看定时任务与执行历史"
                onSelect={() => run(onOpenAutomation)}
              />
              <ResultItem
                icon={Settings}
                shortcutValue="设置 settings"
                title="设置"
                subtitle="常规偏好与外观"
                onSelect={() => run(() => onOpenSettings("general"))}
              />
            </CommandGroup>

            {/* 对话分组：浏览态展示近 7 天；搜索态全量匹配 */}
            {browsing ? (
              recentSessions.length > 0 ? (
                <CommandGroup heading="对话 · 近 7 天">
                  {sessionItems(
                    recentSessions.slice(0, BROWSE_SESSION_RECENT_LIMIT),
                  )}
                </CommandGroup>
              ) : null
            ) : (
              <CommandGroup heading="对话">
                {sessionItems(sessions)}
              </CommandGroup>
            )}

            {/* 项目分组：最近使用的项目（含路径副标题） */}
            <CommandGroup heading="最近项目">
              {projectItems(
                browsing
                  ? recentProjects.slice(0, BROWSE_PROJECT_LIMIT)
                  : recentProjects,
              )}
            </CommandGroup>

            {/* 配置分组：直达设置页各分区 */}
            <CommandGroup heading="配置">
              <ResultItem
                icon={Cloud}
                shortcutValue="模型 提供商 models providers"
                title="模型与提供商"
                onSelect={() => run(() => onOpenSettings("models"))}
              />
              <ResultItem
                icon={Bot}
                shortcutValue="智能体 agents"
                title="智能体"
                onSelect={() => run(() => onOpenSettings("agents"))}
              />
              <ResultItem
                icon={BotIcon}
                shortcutValue="子智能体 subagents"
                title="子智能体"
                onSelect={() => run(() => onOpenSettings("subagents"))}
              />
              <ResultItem
                icon={Sparkles}
                shortcutValue="技能 skills"
                title="技能"
                onSelect={() => run(() => onOpenSettings("skills"))}
              />
              <ResultItem
                icon={Wrench}
                shortcutValue="工具 tools"
                title="工具"
                onSelect={() => run(() => onOpenSettings("tools"))}
              />
              <ResultItem
                icon={FolderOpen}
                shortcutValue="项目管理 projects"
                title="项目管理"
                onSelect={() => run(() => onOpenSettings("projects"))}
              />
              <ResultItem
                icon={Archive}
                shortcutValue="归档 archive"
                title="归档"
                onSelect={() => run(() => onOpenSettings("archive"))}
              />
            </CommandGroup>
          </CommandList>

          {/* 底部快捷键提示条（PI-Desktop 风格） */}
          <footer className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground select-none">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="ml-1">浏览</span>
              <span className="mx-1.5">·</span>
              <Kbd>Enter</Kbd>
              <span className="ml-1">打开</span>
              <span className="mx-1.5">·</span>
              <Kbd>Esc</Kbd>
              <span className="ml-1">关闭</span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </span>
          </footer>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
