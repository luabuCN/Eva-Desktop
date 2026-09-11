import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { PanelRightCloseIcon, PanelRightOpenIcon, Search } from "lucide-react";
import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  apiFetch,
  API_URL,
  isReasoningEffort,
  listConversationRuns,
  listConversationTasks,
  listAgents,
  listProjects,
  listProviders,
  abortConversation,
  answerAsk,
  decideApproval,
  decidePlan,
  deleteProject as apiDeleteProject,
  deleteSession as apiDeleteSession,
  isPermissionMode,
  updateProject,
  updateSession,
  type ApprovalAction,
  type AskUserInfo,
  type PlanApprovalAction,
  type PlanApprovalInfo,
  type ModelSelection,
  type PermissionMode,
  type ProjectInfo,
  type ProviderInfo,
  type ReasoningEffort,
  type RunInfo,
  type SessionSummary,
  type AgentTaskInfo,
  type AgentInfo,
} from "./api";
import type { ChatUIMessage } from "./lib/chat-utils";
import { ChatPane, type TurnOutcomeNote } from "./components/ChatPane";
import type { PreviewTarget } from "./components/BrowserPane";
import { defaultModelSelection } from "./components/ModelSelector";
import { RightPanel, type RightTab } from "./components/RightPanel";
import { AppSidebar } from "./components/AppSidebar";
import { WorkspaceGate } from "./components/WorkspaceGate";
import { Button } from "@/components/ui/button";
import { SidebarPeekTrigger } from "@/components/SidebarPeekTrigger";
import {
  isTauriWindow,
  WindowControls,
  windowControlsReserveClass,
} from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { SettingsPage } from "./components/settings/SettingsPage";
import { AutomationPage } from "./components/automation/AutomationPage";
import { WikiPageView } from "./components/wiki/WikiPage";
import { GlobalSearch, type GlobalSearchSettingsSection } from "./components/GlobalSearch";
import { ProjectForm } from "./components/settings/ProjectForm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { lastAssistantHasText } from "./lib/chat-utils";

const SESSION_KEY = "openharness.sessionId";
const THINKING_MODE_KEY = "openharness.thinkingMode";
const REASONING_EFFORT_KEY = "openharness.reasoningEffort";

function sessionsSignature(sessions: SessionSummary[]): string {
  return sessions
    .map(
      (session) =>
        `${session.id}:${session.title}:${session.pinned ? 1 : 0}:${session.updatedAt}:${session.activeRunStatus ?? ""}`,
    )
    .join("|");
}

/** 推理等级持久化：新键优先；旧 deep 设置迁移为 medium。 */
function loadReasoningEffort(): ReasoningEffort {
  const storedEffort = localStorage.getItem(REASONING_EFFORT_KEY);
  if (isReasoningEffort(storedEffort)) return storedEffort;
  if (localStorage.getItem(THINKING_MODE_KEY) === "deep") return "medium";
  return "off";
}
const PERMISSION_MODE_KEY = "openharness.permissionMode";
const AGENT_KEY = "openharness.agentId";
const PROJECT_KEY = "openharness.projectId";
// 标签栏（文件/浏览器/任务/变更/Git/工具结果/用量）七个标签的最小内容
// 宽度实测约 524px，最小宽度取 530 保证全部可见、无需横向滚动——否则
// "用量"会被裁在标签条右缘，看起来像面板丢了。
const PANEL_WIDTH_MIN = 530;
const PANEL_WIDTH_DEFAULT = 530;

/** Stable identity across renders so memoized RightPanel skips work on tabs
 * that do not read the transcript (files/tasks/changes/git). */
const EMPTY_MESSAGES: ChatUIMessage[] = [];

/** 各会话的预览通知处理状态，模块级共享：SessionView 因 key 切换或热更新
 * 重挂载时，已消费的通知不会重复触发，更重要的是首次基线不会把重挂载后
 * 才到的新通知误当历史吞掉（组件级 ref 在重挂载时会整体重置）。 */
const previewSeen = new Map<string, { seen: Set<string>; baselined: boolean }>();

function createSessionId() {
  return crypto.randomUUID();
}

interface SessionViewProps {
  sessionId: string;
  title: string;
  providers: ProviderInfo[];
  requestSelection: ModelSelection | null;
  displaySelection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => void;
  reasoningEffort: ReasoningEffort;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  agentId?: string;
  onAgentChange: (agentId: string) => void;
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
  projects: ProjectInfo[];
  onProjectCreated: () => void;
  initialMessages: ChatUIMessage[];
  /** 历史快照是否已加载完成；后台运行续接在快照就绪后触发。 */
  snapshotReady: boolean;
  onFinished: () => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  /** 打开全局搜索命令面板（顶栏搜索按钮，Ctrl+K 同效）。 */
  onOpenSearch: () => void;
  /** 聊天里的 wiki:// 链接点击后跳转知识库对应页面。 */
  onOpenWikiPage: (scopeId: string, path: string) => void;
}

function SessionView({
  sessionId,
  title,
  providers,
  requestSelection,
  displaySelection,
  onSelectionChange,
  reasoningEffort,
  permissionMode,
  onPermissionModeChange,
  agentId,
  onAgentChange,
  projectId,
  onProjectChange,
  projects,
  onProjectCreated,
  initialMessages,
  snapshotReady,
  onFinished,
  onReasoningEffortChange,
  panelOpen,
  onPanelOpenChange,
  onOpenSearch,
  onOpenWikiPage,
}: SessionViewProps) {
  const [tab, setTab] = useState<RightTab>("files");
  const [selectedToolId, setSelectedToolId] = useState<string>();
  const [panelWidth, setPanelWidth] = useState(PANEL_WIDTH_DEFAULT);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const reasoningEffortRef = useRef(reasoningEffort);
  const permissionModeRef = useRef(permissionMode);
  const agentIdRef = useRef(agentId);
  const projectIdRef = useRef(projectId);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [tasks, setTasks] = useState<AgentTaskInfo[]>([]);
  const runsSignatureRef = useRef("");

  useEffect(() => {
    reasoningEffortRef.current = reasoningEffort;
  }, [reasoningEffort]);

  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  // Poll results keep their object identity only when the server state is
  // unchanged; skipping identical responses stops poll-driven re-renders of
  // the whole chat tree during long runs.
  const tasksSignatureRef = useRef("");
  const refreshTasks = useCallback(() => {
    void listConversationTasks(sessionId)
      .then((next) => {
        const signature = next
          .map((task) => `${task.id}:${task.status}:${task.activeForm ?? ""}`)
          .join("|");
        if (signature === tasksSignatureRef.current) return;
        tasksSignatureRef.current = signature;
        setTasks(next);
      })
      .catch(() => undefined);
  }, [sessionId]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: `${API_URL}/api/chat`,
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            id: sessionId,
            messages,
            reasoningEffort: reasoningEffortRef.current,
            thinkingMode: reasoningEffortRef.current === "off" ? "fast" : "deep",
            permissionMode: isPermissionMode(body?.permissionMode)
              ? body.permissionMode
              : permissionModeRef.current,
            agentId:
              typeof body?.agentId === "string" && body.agentId
                ? body.agentId
                : agentIdRef.current,
            projectId:
              typeof body?.projectId === "string" && body.projectId
                ? body.projectId
                : projectIdRef.current,
            ...(requestSelection ? { model: requestSelection } : {}),
          },
        }),
      }),
    [sessionId, projectId, requestSelection],
  );

  // 重进会话的续接开关：快照就绪后若发现进行中的运行则翻转（见下方 effect）。
  const [resumeActive, setResumeActive] = useState(false);
  const resumeCheckedRef = useRef(false);

  const chat: UseChatHelpers<ChatUIMessage> = useChat<ChatUIMessage>({
    id: sessionId,
    messages: initialMessages,
    transport,
    resume: resumeActive,
    // Coalesce stream chunks into ~20 renders/sec. Without this every token
    // delta re-renders the whole streaming message (the server accumulates an
    // entire agent run into one message), which froze long answers.
    experimental_throttle: 50,
    onFinish: async (event) => {
      void event;
      onFinished();
    },
  });

  const setChatMessages = chat.setMessages;
  useEffect(() => {
    setChatMessages(initialMessages);
  }, [initialMessages, setChatMessages]);

  // 重进会话时续接仍在后台运行的回合：快照就绪后查询一次运行列表，
  // 存在进行中的运行就翻转 resume，useChat 通过 GET /api/chat/:id/stream
  // 回放缓冲并接管直播流。每个挂载只尝试一次，且要求本地空闲——resume
  // 会先中止当前活跃响应，不能打断刚发出的新回合。
  const chatStatus = chat.status;
  useEffect(() => {
    if (!snapshotReady || resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;
    if (chatStatus !== "ready") return;
    void listConversationRuns(sessionId)
      .then((runs) => {
        const active = runs.some(
          (run) =>
            run.status === "running" ||
            run.status === "waiting_approval" ||
            run.status === "queued",
        );
        if (active) setResumeActive(true);
      })
      .catch(() => undefined);
  }, [snapshotReady, sessionId, chatStatus]);

  // 停止按钮：运行已在服务端与连接解耦，本地断流不再能中止它，必须先调
  // 中止 API，再断开本地流视图。
  const chatStop = chat.stop;
  const handleStop = useCallback(() => {
    void abortConversation(sessionId)
      .catch(() => undefined)
      .finally(() => chatStop());
  }, [sessionId, chatStop]);

  const busy = chat.status === "submitted" || chat.status === "streaming";

  useEffect(() => {
    if (!busy) {
      setRuns([]);
      runsSignatureRef.current = "";
      return;
    }

    let cancelled = false;
    const loadRuns = () => {
      void listConversationRuns(sessionId)
        .then((next) => {
          if (cancelled) return;
          const signature = next
            .map(
              (run) =>
                `${run.id}:${run.status}:${run.approvals.filter((approval) => approval.status === "pending").length}:${(run.asks ?? []).filter((ask) => ask.status === "pending").length}`,
            )
            .join("|");
          if (signature === runsSignatureRef.current) return;
          runsSignatureRef.current = signature;
          setRuns(next);
        })
        .catch(() => undefined);
    };

    loadRuns();
    const timer = window.setInterval(loadRuns, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, sessionId]);

  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);

  useEffect(() => {
    if (!busy) {
      const timer = window.setTimeout(refreshTasks, 500);
      return () => window.clearTimeout(timer);
    }

    const timer = window.setInterval(refreshTasks, 1_500);
    return () => window.clearInterval(timer);
  }, [busy, refreshTasks]);

  const pendingApprovals = runs.flatMap((run) =>
    run.approvals
      .filter((approval) => approval.status === "pending")
      .map((approval) => ({ run, approval })),
  );

  const pendingAsks = runs.flatMap((run) =>
    (run.asks ?? [])
      .filter((ask) => ask.status === "pending")
      .map((ask) => ({ run, ask })),
  );

  const pendingPlans = runs.flatMap((run) =>
    (run.plans ?? [])
      .filter((plan) => plan.status === "pending")
      .map((plan) => ({ run, plan })),
  );

  // 模型目录里的上下文窗口大小，供用量页计算上下文占用。
  const contextWindow = useMemo(() => {
    if (!displaySelection) return undefined;
    const provider = providers.find(
      (candidate) => candidate.id === displaySelection.providerId,
    );
    const model = provider?.models.find(
      (candidate) => candidate.id === displaySelection.modelId,
    );
    return model?.limit?.context;
  }, [providers, displaySelection]);

  // 最近的回合异常结束（失败/中止）且没有文字总结时，在对话流末尾补一条提示；
  // 运行期间与正常回合不显示。刷新页面导致的中断在服务端记为 aborted，这里同样覆盖。
  const [latestRun, setLatestRun] = useState<RunInfo | null>(null);
  const refreshLatestRun = useCallback(() => {
    void listConversationRuns(sessionId)
      .then((next) => setLatestRun(next[0] ?? null))
      .catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    refreshLatestRun();
  }, [refreshLatestRun, initialMessages]);

  useEffect(() => {
    if (!busy) refreshLatestRun();
  }, [busy, refreshLatestRun]);

  const turnNote = useMemo<TurnOutcomeNote | undefined>(() => {
    if (busy || !latestRun) return undefined;
    if (latestRun.status !== "failed" && latestRun.status !== "aborted") return undefined;
    if (lastAssistantHasText(chat.messages)) return undefined;
    return latestRun.status === "failed"
      ? {
          kind: "failed",
          message: `上次回合失败${latestRun.error ? `：${latestRun.error}` : "，未生成文字总结"}`,
        }
      : { kind: "aborted", message: "上次回合已被中止，未生成文字总结" };
  }, [busy, latestRun, chat.messages]);

  const handleApprovalDecision = useCallback(
    async (runId: string, approvalId: string, action: ApprovalAction) => {
      await decideApproval(runId, approvalId, action);
      setRuns((current) =>
        current.map((run) =>
          run.id !== runId
            ? run
            : {
                ...run,
                approvals: run.approvals.map((approval) => {
                  if (approval.id !== approvalId) return approval;

                  return {
                    ...approval,
                    status: action === "reject" ? "rejected" : "approved",
                  };
                }),
              },
        ),
      );
    },
    [],
  );

  // 提交后先本地把卡片置为已回答（1 秒轮询回来前界面立即收起），
  // 失败则回退为 pending，让用户重试。
  const handleAskAnswer = useCallback(
    async (runId: string, askId: string, answers: Array<string[] | null>) => {
      const mark = (status: AskUserInfo["status"]) =>
        setRuns((current) =>
          current.map((run) =>
            run.id !== runId
              ? run
              : {
                  ...run,
                  asks: (run.asks ?? []).map((ask) =>
                    ask.id === askId ? { ...ask, status } : ask,
                  ),
                },
          ),
        );
      mark("answered");
      try {
        await answerAsk(runId, askId, answers);
      } catch {
        mark("pending");
      }
    },
    [],
  );

  // 计划卡裁决：先本地置为已裁决让卡片立即收起，失败回退 pending 重试。
  const handlePlanDecision = useCallback(
    async (
      runId: string,
      planId: string,
      action: PlanApprovalAction,
      feedback?: string,
    ) => {
      const mark = (status: PlanApprovalInfo["status"]) =>
        setRuns((current) =>
          current.map((run) =>
            run.id !== runId
              ? run
              : {
                  ...run,
                  plans: (run.plans ?? []).map((plan) =>
                    plan.id === planId ? { ...plan, status } : plan,
                  ),
                },
          ),
        );
      mark(action === "reject" ? "rejected" : "approved");
      try {
        await decidePlan(runId, planId, action, feedback);
      } catch {
        mark("pending");
      }
    },
    [],
  );

  const handleToolSelect = useCallback((id: string) => {
    setSelectedToolId(id);
    setTab("tools");
  }, []);

  // 监听 data-oh:preview.open（生成 HTML / 启动开发服务器）：新通知到达时
  // 载入浏览器面板并自动切换。基线只在页面生命周期内首次接触该会话时登记
  // 一次，之后无论 SessionView 怎么重挂载，新通知都会正常触发。
  useEffect(() => {
    let state = previewSeen.get(sessionId);
    if (!state) {
      state = { seen: new Set(), baselined: false };
      previewSeen.set(sessionId, state);
    }
    if (!state.baselined) {
      // 首次基线：当前会话里已有的通知视为历史，不触发自动打开
      state.baselined = true;
      for (const message of chat.messages) {
        for (const part of message.parts) {
          if (part.type === "data-oh:preview.open") {
            state.seen.add(part.id ?? part.data.url);
          }
        }
      }
      return;
    }
    for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
      const parts = chat.messages[i].parts;
      for (let j = parts.length - 1; j >= 0; j -= 1) {
        const part = parts[j];
        if (part.type !== "data-oh:preview.open") continue;
        // 数据部件的 id 是可选的；缺省时用消息内位置兜底。
        const seenKey = part.id ?? `${i}:${j}:${part.data.url}`;
        if (state.seen.has(seenKey)) continue;
        state.seen.add(seenKey);
        setPreviewTarget({
          url: part.data.url,
          kind: part.data.kind,
          label: part.data.label,
          nonce: Date.now(),
        });
        setTab("browser");
        if (!panelOpen) onPanelOpenChange(true);
        return;
      }
    }
  }, [chat.messages, sessionId, panelOpen, onPanelOpenChange]);

  // 聊天里的链接点击后送进内置浏览器面板（localhost 地址标记为服务器预览）
  const handleOpenLink = useCallback(
    (url: string) => {
      const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|$)/i.test(url);
      setPreviewTarget({ url, kind: isLocal ? "server" : undefined, nonce: Date.now() });
      setTab("browser");
      if (!panelOpen) onPanelOpenChange(true);
    },
    [panelOpen, onPanelOpenChange],
  );

  const handleTogglePanel = useCallback(() => {
    onPanelOpenChange(!panelOpen);
  }, [onPanelOpenChange, panelOpen]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth;

      const handleMove = (moveEvent: MouseEvent) => {
        const maxWidth = Math.max(
          PANEL_WIDTH_MIN,
          Math.floor(window.innerWidth * 0.6),
        );
        const next = Math.min(
          Math.max(startWidth + (startX - moveEvent.clientX), PANEL_WIDTH_MIN),
          maxWidth,
        );
        setPanelWidth(next);
      };
      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [panelWidth],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 窗口标题栏（无边框）：横贯整个内容区。右侧面板展开时整体
          位于这一行下方，面板标签条不会再与自绘窗口按钮争同一行。
          空白处可拖拽移动窗口，双击最大化。 */}
      <header
        data-tauri-drag-region="deep"
        className={cn(
          "flex h-9 shrink-0 items-center justify-between gap-3 border-b px-4 select-none",
          isTauriWindow() && windowControlsReserveClass,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <SidebarPeekTrigger />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSearch}
            title="搜索对话、项目或命令 (Ctrl+K)"
            aria-label="全局搜索"
          >
            <Search className="size-4" />
          </Button>
          <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleTogglePanel}
          title={panelOpen ? "折叠面板" : "展开面板"}
          aria-label={panelOpen ? "折叠面板" : "展开面板"}
        >
          {panelOpen ? (
            <PanelRightCloseIcon className="size-4" />
          ) : (
            <PanelRightOpenIcon className="size-4" />
          )}
        </Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1">
        <ChatPane
          chat={chat}
          providers={providers}
          displaySelection={displaySelection}
          onSelectionChange={onSelectionChange}
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={onReasoningEffortChange}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          agentId={agentId}
          onAgentChange={onAgentChange}
          selectedToolId={selectedToolId}
          onToolSelect={handleToolSelect}
          projects={projects}
          projectId={projectId}
          onProjectChange={onProjectChange}
          onProjectCreated={onProjectCreated}
          pendingApprovals={pendingApprovals}
          onApprovalDecision={(runId, approvalId, action) =>
            void handleApprovalDecision(runId, approvalId, action)
          }
          pendingAsks={pendingAsks}
          onAskAnswer={(runId, askId, answers) =>
            void handleAskAnswer(runId, askId, answers)
          }
          pendingPlans={pendingPlans}
          onPlanDecision={(runId, planId, action, feedback) =>
            void handlePlanDecision(runId, planId, action, feedback)
          }
          turnNote={turnNote}
          onOpenLink={handleOpenLink}
          onOpenWikiPage={onOpenWikiPage}
          onStop={handleStop}
        />
        {panelOpen ? (
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleResizeStart}
            className="group relative hidden w-1 shrink-0 cursor-col-resize lg:block"
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/60 group-active:bg-primary" />
          </div>
        ) : null}
        {panelOpen ? (
          <RightPanel
            messages={tab === "tools" || tab === "usage" ? chat.messages : EMPTY_MESSAGES}
            tasks={tasks}
            tab={tab}
            onTabChange={setTab}
            selectedToolId={selectedToolId}
            onToolSelect={setSelectedToolId}
            width={panelWidth}
            project={projects.find((candidate) => candidate.id === projectId)}
            sessionId={sessionId}
            busy={busy}
            contextWindow={contextWindow}
            previewTarget={previewTarget}
            onOpenLink={handleOpenLink}
          />
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(SESSION_KEY) ?? createSessionId(),
  );
  // 首次启动的工作区引导：未配置过默认工作区时全屏拦截，选定后放行。
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  // 当前会话的历史快照是否已从服务端加载完成；重进会话时只有在快照就绪
  // 之后才尝试续接后台运行，避免回放消息被迟到的快照整体覆盖。
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [error, setError] = useState<string>();
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    loadReasoningEffort,
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    const stored = localStorage.getItem(PERMISSION_MODE_KEY);
    return isPermissionMode(stored) ? stored : "confirm";
  });
  const [agentId, setAgentId] = useState<string | undefined>(
    () => localStorage.getItem(AGENT_KEY) ?? undefined,
  );
  const [view, setView] = useState<"chat" | "settings" | "automation" | "wiki">("chat");
  // 聊天里 wiki:// 链接的跳转目标（nonce 让重复点击同一链接也能重新打开）。
  const [wikiTarget, setWikiTarget] = useState<{
    scopeId: string;
    path: string;
    nonce: number;
  } | null>(null);
  /** 聊天里的知识库引用链接 → 切到知识库视图并打开对应页面。 */
  const openWikiPage = useCallback((scopeId: string, path: string) => {
    setWikiTarget({ scopeId, path, nonce: Date.now() });
    setView("wiki");
  }, []);
  // 全局搜索（Ctrl+K 命令面板）与它驱动的设置页直达分区。
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<GlobalSearchSettingsSection>("general");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [projectId, setProjectId] = useState<string | undefined>(
    () => localStorage.getItem(PROJECT_KEY) ?? undefined,
  );

  const refreshProviders = useCallback(() => {
    void listProviders()
      .then(setProviders)
      .catch(() => undefined);
  }, []);

  const isValidSelection = useCallback(
    (selection: ModelSelection | null | undefined): selection is ModelSelection =>
      !!selection &&
      providers.some(
        (provider) =>
          provider.isActive &&
          provider.id === selection.providerId &&
          provider.models.some((model) => model.enabled && model.id === selection.modelId),
      ),
    [providers],
  );

  const resolveConfiguredSelection = useCallback(
    (providerId?: string | null, modelId?: string | null): ModelSelection | null => {
      if (providerId && modelId) {
        const selection = { providerId, modelId };
        return isValidSelection(selection) ? selection : null;
      }
      if (!modelId) return null;
      const provider = providers.find(
        (entry) =>
          entry.isActive &&
          entry.models.some((model) => model.enabled && model.id === modelId),
      );
      return provider ? { providerId: provider.id, modelId } : null;
    },
    [isValidSelection, providers],
  );

  // 会话列表内容签名：静默轮询用它跳过无变化的重渲染。
  const sessionsSignatureRef = useRef("");

  const refreshSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const data = await apiFetch<{ sessions: SessionSummary[] }>("/api/sessions");
      setSessions(data.sessions);
      sessionsSignatureRef.current = sessionsSignature(data.sessions);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接本地服务");
    } finally {
      setLoadingSessions(false);
    }
  }, []);
  // 后台运行状态轮询：会话在后台执行时，侧栏状态点与排序靠这里的静默
  // 刷新驱动（不触发加载态）。内容无变化时跳过 setState，避免整树重渲染。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void apiFetch<{ sessions: SessionSummary[] }>("/api/sessions")
        .then((data) => {
          const signature = sessionsSignature(data.sessions);
          if (signature === sessionsSignatureRef.current) return;
          sessionsSignatureRef.current = signature;
          setSessions(data.sessions);
        })
        .catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  // Ctrl/Cmd+K 打开（再按切换关闭）全局搜索面板。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const refreshAgents = useCallback(() => {
    void listAgents()
      .then(setAgents)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshAgents();
  }, [refreshAgents]);

  const refreshProjects = useCallback(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, sessionId);
  }, [sessionId]);

  useEffect(() => {
    localStorage.setItem(REASONING_EFFORT_KEY, reasoningEffort);
    // 旧字段同步写一份，回滚到旧版本前端时设置不丢。
    localStorage.setItem(THINKING_MODE_KEY, reasoningEffort === "off" ? "fast" : "deep");
  }, [reasoningEffort]);

  useEffect(() => {
    localStorage.setItem(PERMISSION_MODE_KEY, permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    if (agentId) {
      localStorage.setItem(AGENT_KEY, agentId);
    } else {
      localStorage.removeItem(AGENT_KEY);
    }
  }, [agentId]);

  useEffect(() => {
    if (projectId) localStorage.setItem(PROJECT_KEY, projectId);
    else localStorage.removeItem(PROJECT_KEY);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setSnapshotReady(false);

    apiFetch<{ messages: ChatUIMessage[] }>(`/api/sessions/${sessionId}`)
      .then((data) => {
        if (!cancelled) setMessages(data.messages);
      })
      .catch(() => setMessages([]))
      .finally(() => {
        if (!cancelled) setSnapshotReady(true);
      });
    void refreshSessions();

    return () => {
      cancelled = true;
    };
  }, [refreshSessions, sessionId]);

  const initialMessages = useMemo(() => messages, [messages]);
  const selectedProject = projects.find((project) => project.id === projectId);
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const displaySelection = useMemo(() => {
    if (isValidSelection(modelSelection)) return modelSelection;
    return (
      resolveConfiguredSelection(
        selectedProject?.defaultProviderId,
        selectedProject?.defaultModelId,
      ) ??
      resolveConfiguredSelection(
        selectedAgent?.defaultProviderId,
        selectedAgent?.defaultModelId,
      ) ??
      defaultModelSelection(providers)
    );
  }, [
    isValidSelection,
    modelSelection,
    providers,
    resolveConfiguredSelection,
    selectedAgent,
    selectedProject,
  ]);
  const title = sessions.find((session) => session.id === sessionId)?.title ?? "新建对话";

  function selectSession(id: string, nextProjectId?: string) {
    // 项目分组里的会话把运行上下文切到对应项目；"最近"里的会话一律回到
    // 默认工作区，避免之前选中的项目上下文残留到不相关的对话。
    // 任何会话选择都意味着回到聊天视图（从自动化/设置页点会话应直接进入）。
    setView("chat");
    setProjectId(nextProjectId);
    if (id === sessionId) return;
    setSessionId(id);
    setMessages([]);
  }

  // 顶部"新对话"永远开在默认工作区；项目专属的新对话走项目行的 + 按钮。
  function startNewSession() {
    setView("chat");
    setProjectId(undefined);
    setSessionId(createSessionId());
    setMessages([]);
  }

  function startProjectSession(projectId: string) {
    setView("chat");
    setProjectId(projectId);
    setSessionId(createSessionId());
    setMessages([]);
  }

  /** 全局搜索/侧栏共用：打开设置页并可直达指定分区（key 重挂载生效）。 */
  function openSettings(section: GlobalSearchSettingsSection = "general") {
    setSettingsSection(section);
    setView("settings");
  }

  function handleSelectProject(nextProjectId?: string) {
    setView("chat");
    setProjectId(nextProjectId);
    const inScope = sessions.filter(
      (session) => (session.projectId ?? undefined) === nextProjectId,
    );
    if (inScope.some((session) => session.id === sessionId)) return;
    if (inScope.length > 0) {
      setSessionId(inScope[0].id);
      setMessages([]);
    } else if (nextProjectId) {
      startProjectSession(nextProjectId);
    } else {
      startNewSession();
    }
  }

  async function renameSession(id: string, title: string) {
    try {
      await updateSession(id, { title });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重命名失败");
    }
    void refreshSessions();
  }

  async function toggleSessionPin(id: string, pinned: boolean) {
    try {
      await updateSession(id, { pinned });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "置顶失败");
    }
    void refreshSessions();
  }

  async function archiveSession(id: string) {
    try {
      await updateSession(id, { archived: true });
      // 归档当前会话后侧栏不再展示它，切到新对话保持视图干净。
      if (id === sessionId) startNewSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "归档失败");
    }
    void refreshSessions();
  }

  async function deleteSession(id: string) {
    try {
      await apiDeleteSession(id);
      if (id === sessionId) startNewSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除会话失败");
    }
    void refreshSessions();
  }

  async function toggleProjectPin(id: string, pinned: boolean) {
    try {
      await updateProject(id, { pinned });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "置顶项目失败");
    }
    void refreshProjects();
  }

  async function archiveProject(id: string) {
    try {
      await updateProject(id, { archived: true });
      // 归档当前项目后侧栏不再展示它，回到默认工作区。
      if (id === projectId) handleSelectProject(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "归档项目失败");
    }
    void refreshProjects();
    void refreshSessions();
  }

  async function deleteProject(id: string) {
    try {
      await apiDeleteProject(id);
      if (id === projectId) handleSelectProject(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除项目失败");
    }
    void refreshProjects();
    void refreshSessions();
  }

  /** 定时任务执行历史 → 打开产物会话：回到聊天视图并带出项目上下文。 */
  function openConversation(conversationId: string) {
    const session = sessions.find((candidate) => candidate.id === conversationId);
    setProjectId(session?.projectId ?? undefined);
    if (conversationId !== sessionId) {
      setSessionId(conversationId);
      setMessages([]);
    }
    setView("chat");
  }

  return (
    <SidebarProvider className="h-screen min-w-0 overflow-hidden">
      <AppSidebar
        sessions={sessions}
        sessionId={sessionId}
        loading={loadingSessions}
        error={error}
        projects={projects}
        activeProjectId={projectId}
        onSelectProject={handleSelectProject}
        onSelect={selectSession}
        onNew={startNewSession}
        onNewInProject={startProjectSession}
        onRename={(id, title) => void renameSession(id, title)}
        onTogglePin={(id, pinned) => void toggleSessionPin(id, pinned)}
        onArchive={(id) => void archiveSession(id)}
        onDelete={(id) => void deleteSession(id)}
        onToggleProjectPin={(id, pinned) => void toggleProjectPin(id, pinned)}
        onArchiveProject={(id) => void archiveProject(id)}
        onDeleteProject={(id) => void deleteProject(id)}
        onProjectsChanged={refreshProjects}
        onOpenSettings={() => openSettings()}
        onOpenAutomation={() => setView("automation")}
        automationActive={view === "automation"}
        onOpenWiki={() => setView("wiki")}
        wikiActive={view === "wiki"}
      />
      <SidebarInset className="min-w-0">
        {view === "settings" ? (
          <SettingsPage
            key={settingsSection}
            initialSection={settingsSection}
            onExit={() => setView("chat")}
            onChanged={() => {
              refreshProviders();
              refreshProjects();
              refreshAgents();
              void refreshSessions();
            }}
          />
        ) : view === "automation" ? (
          <AutomationPage
            onExit={() => setView("chat")}
            onOpenConversation={openConversation}
          />
        ) : view === "wiki" ? (
          <WikiPageView onExit={() => setView("chat")} target={wikiTarget} />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1">
            <SessionView
              key={sessionId}
              sessionId={sessionId}
              title={title}
              providers={providers}
              requestSelection={modelSelection}
              displaySelection={displaySelection}
              onSelectionChange={setModelSelection}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              agentId={agentId}
              onAgentChange={setAgentId}
              projects={projects}
              projectId={projectId}
              onProjectChange={setProjectId}
              onProjectCreated={refreshProjects}
              initialMessages={initialMessages}
              snapshotReady={snapshotReady}
              onFinished={() => void refreshSessions()}
              panelOpen={panelOpen}
              onPanelOpenChange={setPanelOpen}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenWikiPage={openWikiPage}
            />
          </div>
        )}
      </SidebarInset>

      {/* 全局搜索命令面板（Ctrl+K 或侧栏搜索入口打开）。 */}
      <GlobalSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        sessions={sessions}
        projects={projects}
        currentSessionId={sessionId}
        onNewChat={startNewSession}
        onNewProject={() => setProjectDialogOpen(true)}
        onOpenAutomation={() => setView("automation")}
        onOpenSettings={openSettings}
        onSelectSession={selectSession}
        onSelectProject={handleSelectProject}
      />

      {/* 全局搜索「新项目」命令打开的创建对话框（与侧栏入口同款表单）。 */}
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>添加项目</DialogTitle>
          </DialogHeader>
          {projectDialogOpen ? (
            <ProjectForm
              onSaved={(project) => {
                setProjectDialogOpen(false);
                refreshProjects();
                handleSelectProject(project.id);
              }}
              onCancel={() => setProjectDialogOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 无边框窗口的自绘控制按钮，固定在窗口右上角、浮于各顶栏之上。 */}
      {!workspaceReady ? (
        <WorkspaceGate onReady={() => setWorkspaceReady(true)} />
      ) : null}
      <WindowControls />
    </SidebarProvider>
  );
}
