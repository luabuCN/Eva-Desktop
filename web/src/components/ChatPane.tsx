import type { UseChatHelpers } from "@ai-sdk/react";
import { isToolUIPart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatUIMessage } from "@/lib/chat-utils";
import { parseWikiHref } from "@/lib/chat-utils";
import { friendlyErrorText, rawErrorDetail } from "@/lib/error-display";
import { prepareAttachments } from "@/lib/attachments";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  BookMarked,
  Check,
  CircleAlertIcon,
  ImageIcon,
  InfoIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type {
  ApprovalAction,
  PlanApprovalAction,
  PlanApprovalInfo,
  ApprovalInfo,
  AskUserInfo,
  ModelSelection,
  PermissionMode,
  ProjectInfo,
  ProviderInfo,
  ReasoningEffort,
  RunInfo,
  SkillInfo,
} from "@/api";
import { ingestConversationToWiki, listSkills } from "@/api";
import { MessageView } from "./MessageView";
import { FileLinkContext, MessageLinkContext, WikiLinkContext } from "./ai-elements/message";
import { ConversationMinimap } from "./ConversationMinimap";
import { ModelSelector } from "./ModelSelector";
import { AgentSelector } from "./AgentSelector";
import { ProjectSelector } from "./ProjectSelector";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { AskUserPrompt } from "./AskUserPrompt";
import { PlanApprovalPrompt } from "./PlanApprovalPrompt";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { SlashSkillMenu } from "./SlashSkillMenu";

/** 单个附件的大小上限；PDF/Word/表格以 data URL 形式随消息发送，过大
 * 的文件会显著拖慢请求与每轮重放，超限时在前端直接拦截。 */
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** 最近一次回合异常结束（且没有文字总结）时的提示。 */
export interface TurnOutcomeNote {
  kind: "failed" | "aborted";
  message: string;
}

/** 「存入知识库」：把当前会话整体交给 wiki 总结队列（llm-wiki 的 Save to Wiki）。 */
function SaveToWikiButton({
  conversationId,
  projectId,
  disabled,
}: {
  conversationId: string;
  projectId?: string;
  disabled: boolean;
}) {
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  useEffect(() => {
    if (state !== "done" && state !== "error") return;
    const timer = window.setTimeout(() => setState("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [state]);

  const save = useCallback(() => {
    setState("saving");
    void ingestConversationToWiki(projectId ? `p:${projectId}` : "default", conversationId)
      .then(() => setState("done"))
      .catch(() => setState("error"));
  }, [conversationId, projectId]);

  return (
    <button
      type="button"
      onClick={save}
      disabled={disabled || state === "saving"}
      title={
        state === "done"
          ? "已加入总结队列"
          : state === "error"
            ? "入队失败，请稍后重试"
            : "把这段对话总结进知识库"
      }
      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {state === "saving" ? (
        <LoaderCircleIcon className="size-3.5 animate-spin" />
      ) : state === "done" ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <BookMarked className="size-3.5" />
      )}
      <span className="text-xs">存入知识库</span>
    </button>
  );
}

export interface ChatPaneProps {
  chat: UseChatHelpers<ChatUIMessage>;
  providers: ProviderInfo[];
  displaySelection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  agentId?: string;
  onAgentChange: (agentId: string) => void;
  selectedToolId?: string;
  onToolSelect: (id: string) => void;
  projects: ProjectInfo[];
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
  onProjectCreated: () => void;
  pendingApprovals: Array<{ run: RunInfo; approval: ApprovalInfo }>;
  onApprovalDecision: (
    runId: string,
    approvalId: string,
    action: ApprovalAction,
  ) => void;
  /** askUser 工具挂起的提问卡片（与审批一样由运行轮询驱动）。 */
  pendingAsks: Array<{ run: RunInfo; ask: AskUserInfo }>;
  onAskAnswer: (
    runId: string,
    askId: string,
    answers: Array<string[] | null>,
  ) => void;
  /** ExitPlanMode 工具挂起的计划审批卡（同样由运行轮询驱动）。 */
  pendingPlans: Array<{ run: RunInfo; plan: PlanApprovalInfo }>;
  onPlanDecision: (
    runId: string,
    planId: string,
    action: PlanApprovalAction,
    feedback?: string,
  ) => void;
  turnNote?: TurnOutcomeNote;
  /** 聊天内容里的链接点击后改在内置浏览器面板中打开。 */
  onOpenLink?: (url: string) => void;
  /** 聊天内容里的 open-file: 文件链接点击后在右侧面板打开预览。 */
  onOpenFile?: (filePath: string) => void;
  /** 聊天内容里的 wiki:// 知识库引用链接点击后跳转知识库对应页面。 */
  onOpenWikiPage: (scopeId: string, path: string) => void;
  /** 停止按钮：运行与连接解耦后需要走服务端中止 API；缺省退回本地断流。 */
  onStop?: () => void;
}

export function ChatPane({
  chat,
  providers,
  displaySelection,
  onSelectionChange,
  reasoningEffort,
  onReasoningEffortChange,
  permissionMode,
  onPermissionModeChange,
  agentId,
  onAgentChange,
  selectedToolId,
  onToolSelect,
  projects,
  projectId,
  onProjectChange,
  onProjectCreated,
  pendingApprovals,
  onApprovalDecision,
  pendingPlans,
  pendingAsks,
  onPlanDecision,
  onAskAnswer,
  turnNote,
  onOpenLink,
  onOpenFile,
  onOpenWikiPage,
  onStop,
}: ChatPaneProps) {
  const busy = chat.status === "submitted" || chat.status === "streaming";
  const waiting = busy && !hasVisibleAssistantWork(chat.messages);
  const streamingMessageId =
    busy && chat.messages.at(-1)?.role === "assistant"
      ? chat.messages.at(-1)?.id
      : undefined;
  // 附件被拒（超大小/类型不符）时的短暂提示，几秒后自动消失。
  const [attachmentError, setAttachmentError] = useState<string>();
  useEffect(() => {
    if (!attachmentError) return;
    const timer = window.setTimeout(() => setAttachmentError(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [attachmentError]);
  const error =
    chat.error instanceof Error
      ? chat.error.message
      : typeof chat.error === "string"
        ? chat.error
        : undefined;
  // 当前选中模型是否声明了图片输入：true/false 明确提示，undefined 表示目录
  // 未配置模态信息（不做提示，避免误导）。
  const selectedModel = displaySelection
    ? providers
        .find((provider) => provider.id === displaySelection.providerId)
        ?.models.find((model) => model.id === displaySelection.modelId)
    : undefined;
  const modelAcceptsImages = selectedModel?.modalities?.input?.includes("image");
  // 一次只确认一条：按创建时间取最早的一条，其余等这条处理完再依次出现。
  const sortedApprovals = [...pendingApprovals].sort((a, b) =>
    a.approval.createdAt.localeCompare(b.approval.createdAt),
  );
  const activeApproval = sortedApprovals[0];
  // 提问卡片同理：最早一条先答；与审批同时挂起时审批优先（权限先放行，回合才能继续）。
  const sortedAsks = [...pendingAsks].sort((a, b) =>
    a.ask.createdAt.localeCompare(b.ask.createdAt),
  );
  const activeAsk = sortedAsks[0];
  // 计划卡同理：最早一张先裁决。
  const sortedPlans = [...pendingPlans].sort((a, b) =>
    a.plan.createdAt.localeCompare(b.plan.createdAt),
  );
  const activePlan = sortedPlans[0];

  // wiki:// 知识库引用链接：解析 scope 与 path 后跳转知识库页面。
  const handleWikiLink = useCallback(
    (href: string) => {
      const target = parseWikiHref(href);
      if (target) onOpenWikiPage(target.scopeId, target.path);
    },
    [onOpenWikiPage],
  );

  // /open-file/<encoded> 文件链接：解码出路径后交右侧面板预览。
  const handleFileLink = useCallback(
    (href: string) => {
      const encoded = href.slice("/open-file/".length);
      try {
        onOpenFile?.(decodeURIComponent(encoded));
      } catch {
        // 编码异常的 href 直接忽略，避免把乱码路径送进预览
      }
    },
    [onOpenFile],
  );

  // 聊天里的链接（markdown/自动识别的 URL）默认会走系统浏览器打开；
  // 拦截后送进内置浏览器面板，和预览行为保持一致。文件/wiki 链接在
  // context 缺失时会退回普通 <a>（相对路径），这里兜底转对应的处理器，
  // 避免相对路径被当成应用内导航打开 404。
  const handleLinkClickCapture = useCallback(
    (event: React.MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        event.stopPropagation();
        onOpenLink?.(href);
        return;
      }
      if (href.startsWith("/open-file/")) {
        event.preventDefault();
        event.stopPropagation();
        handleFileLink(href);
        return;
      }
      if (href.startsWith("/wiki/") || href.startsWith("wiki/")) {
        event.preventDefault();
        event.stopPropagation();
        handleWikiLink(href);
      }
    },
    [handleFileLink, handleWikiLink, onOpenLink],
  );

  // —— 输入框「/技能」斜杠菜单 ——
  // 输入以 "/" 开头且光标仍在首词内时弹出；选中后把首词替换为 "/<id> "，
  // 发送时由服务端展开技能正文（历史里保留紧凑的命令文本）。
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dismissedTokenRef = useRef<string | null>(null);
  const skillsFetchedAtRef = useRef(0);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [slash, setSlash] = useState<{ open: boolean; query: string }>({ open: false, query: "" });
  const [slashHighlight, setSlashHighlight] = useState(0);

  const refreshSkills = useCallback(async () => {
    try {
      const { skills: next } = await listSkills();
      setSkills(next.filter((item) => item.enabled));
    } catch {
      // 技能目录读取失败不影响聊天输入
    } finally {
      skillsFetchedAtRef.current = Date.now();
    }
  }, []);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const filteredSkills = useMemo(() => {
    if (!slash.open) return [];
    const query = slash.query.toLowerCase();
    if (!query) return skills.slice(0, 8);
    return skills
      .filter(
        (item) =>
          item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [slash.open, slash.query, skills]);
  const slashMenuOpen = slash.open && filteredSkills.length > 0;

  // 输入变化/光标移动时重新判定触发词。
  const syncSlash = useCallback((el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length;
    const token = el.value.slice(0, pos);
    if (token.startsWith("/") && !/\s/.test(token)) {
      if (dismissedTokenRef.current === token) return;
      const query = token.slice(1);
      setSlash((prev) => (prev.open && prev.query === query ? prev : { open: true, query }));
    } else {
      dismissedTokenRef.current = null;
      setSlash((prev) => (prev.open ? { open: false, query: "" } : prev));
    }
  }, []);

  useEffect(() => {
    setSlashHighlight(0);
  }, [slash.query]);

  const acceptSkill = useCallback((skill: SkillInfo) => {
    const el = textareaRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? el.value.length;
    el.value = `/${skill.id} ${el.value.slice(pos)}`;
    const caret = skill.id.length + 2;
    el.setSelectionRange(caret, caret);
    dismissedTokenRef.current = null;
    setSlash({ open: false, query: "" });
  }, []);

  const handleTextareaEvent = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      syncSlash(event.currentTarget);
    },
    [syncSlash],
  );

  const handleTextareaFocus = useCallback(
    (event: React.FocusEvent<HTMLTextAreaElement>) => {
      syncSlash(event.currentTarget);
      // 设置页增删技能后回到聊天，聚焦时刷新目录（限频）。
      if (Date.now() - skillsFetchedAtRef.current > 5_000) void refreshSkills();
    },
    [syncSlash, refreshSkills],
  );

  const handleSlashKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!slashMenuOpen || event.nativeEvent.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSlashHighlight(
          (current) => (current + delta + filteredSkills.length) % filteredSkills.length,
        );
      } else if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      ) {
        event.preventDefault();
        const target = filteredSkills[slashHighlight] ?? filteredSkills[0];
        if (target) acceptSkill(target);
      } else if (event.key === "Escape") {
        event.preventDefault();
        const el = textareaRef.current;
        dismissedTokenRef.current = el
          ? el.value.slice(0, el.selectionStart ?? el.value.length)
          : null;
        setSlash({ open: false, query: "" });
      }
    },
    [slashMenuOpen, filteredSkills, slashHighlight, acceptSkill],
  );

  // 加号菜单里的「输入 / 选择技能」：聚焦输入框并进入斜杠选择状态。
  const openSlashFromMenu = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!el.value.startsWith("/")) el.value = `/${el.value}`;
    el.focus();
    el.setSelectionRange(1, 1);
    dismissedTokenRef.current = null;
    syncSlash(el);
  }, [syncSlash]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <MessageLinkContext.Provider value={onOpenLink}>
      <WikiLinkContext.Provider value={handleWikiLink}>
      <FileLinkContext.Provider value={handleFileLink}>
        <Conversation onClickCapture={handleLinkClickCapture}>
          <ConversationContent className="mx-auto min-h-full w-full max-w-5xl gap-6 py-6">
            {chat.messages.length === 0 ? (
              <ConversationEmptyState className="flex-1 gap-4">
                <img
                  src={`${import.meta.env.BASE_URL}bloub.gif`}
                  alt=""
                  draggable={false}
                  className="size-28 select-none object-contain"
                />
                <h2 className="text-3xl leading-tight text-foreground">
                  今天想做点什么？
                </h2>
              </ConversationEmptyState>
            ) : (
              chat.messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  isStreaming={message.id === streamingMessageId}
                  selectedToolId={selectedToolId}
                  onToolSelect={onToolSelect}
                />
              ))
            )}
            {waiting ? <AssistantLoadingView effort={reasoningEffort} /> : null}
            {!busy && turnNote ? <TurnNoteView note={turnNote} /> : null}
            {!busy && error ? <AssistantErrorView message={error} /> : null}
          </ConversationContent>
          <ConversationMinimap messages={chat.messages} />
          <ConversationScrollButton />
        </Conversation>
      </FileLinkContext.Provider>
      </WikiLinkContext.Provider>
      </MessageLinkContext.Provider>

      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-5xl">
          {activeApproval ? (
            <div className="mb-12">
              <ApprovalPrompt
                run={activeApproval.run}
                approval={activeApproval.approval}
                remainingCount={sortedApprovals.length - 1}
                onDecision={(action) =>
                  onApprovalDecision(
                    activeApproval.run.id,
                    activeApproval.approval.id,
                    action,
                  )
                }
              />
            </div>
          ) : null}
          {activeAsk ? (
            <div className="mb-12">
              <AskUserPrompt
                ask={activeAsk.ask}
                onSubmit={(answers) =>
                  onAskAnswer(activeAsk.run.id, activeAsk.ask.id, answers)
                }
              />
            </div>
          ) : null}
          {activePlan ? (
            <div className="mb-12">
              <PlanApprovalPrompt
                plan={activePlan.plan}
                onSubmit={(action, feedback) =>
                  onPlanDecision(activePlan.run.id, activePlan.plan.id, action, feedback)
                }
              />
            </div>
          ) : null}
          <div className="relative">
            {slashMenuOpen ? (
              <SlashSkillMenu
                items={filteredSkills}
                highlight={Math.min(slashHighlight, filteredSkills.length - 1)}
                onHighlightChange={setSlashHighlight}
                onAccept={acceptSkill}
              />
            ) : null}
          <PromptInput
            className="w-full rounded-xl border bg-card shadow-sm"
            onSubmit={async ({ text, files }) => {
              if (busy || (!text.trim() && files.length === 0)) return;
              setSlash({ open: false, query: "" });
              // 发送前处理附件：压缩大图。其余类型（PDF/Word/表格等）原样
              // 发送，服务端会落盘并把路径告诉模型。
              const prepared = await prepareAttachments(files);
              if (!text.trim() && prepared.length === 0) return;
              void chat.sendMessage(
                {
                  text,
                  ...(prepared.length > 0 ? { files: prepared } : {}),
                },
                {
                  body: {
                    thinkingMode: reasoningEffort === "off" ? "fast" : "deep",
                    reasoningEffort,
                    agentId,
                    projectId,
                  },
                },
              );
            }}
            maxFileSize={ATTACHMENT_MAX_BYTES}
            onError={(issue) => setAttachmentError(issue.message)}
          >
            <PromptInputBody>
              {attachmentError ? (
                <p className="flex w-full items-center gap-1.5 px-1 pb-1 text-xs text-destructive">
                  <CircleAlertIcon className="size-3.5 shrink-0" />
                  {attachmentError}
                </p>
              ) : null}
              <PromptInputAttachments />
              <AttachmentVisionHint acceptsImages={modelAcceptsImages} />
              <PromptInputTextarea
                ref={textareaRef}
                placeholder="有什么可以帮忙的？输入 / 选择技能"
                onChange={handleTextareaEvent}
                onClick={handleTextareaEvent}
                onKeyUp={handleTextareaEvent}
                onSelect={handleTextareaEvent}
                onFocus={handleTextareaFocus}
                onKeyDown={handleSlashKeyDown}
              />
            </PromptInputBody>
            <PromptInputFooter>
              {/* 工具条可换行：窗口缩窄时按钮分多行排布，避免溢出被截断；
                  发送按钮 self-end 固定在右下角。 */}
              <PromptInputTools className="flex-wrap">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger tooltip="添加附件" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments />
                    <PromptInputActionMenuItem onSelect={openSlashFromMenu}>
                      <SparklesIcon className="mr-2 size-4" />
                      输入 / 选择技能
                    </PromptInputActionMenuItem>
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                <AgentSelector value={agentId} onChange={onAgentChange} />
                <SaveToWikiButton
                  conversationId={chat.id}
                  projectId={projectId}
                  disabled={chat.messages.length === 0}
                />
                <ProjectSelector
                  projects={projects}
                  projectId={projectId}
                  onSelectProject={onProjectChange}
                  onChanged={onProjectCreated}
                />
                <PermissionModeSelector
                  value={permissionMode}
                  onChange={onPermissionModeChange}
                />
                <ModelSelector
                  providers={providers}
                  value={displaySelection}
                  onChange={onSelectionChange}
                  effort={reasoningEffort}
                  onEffortChange={onReasoningEffortChange}
                />
              </PromptInputTools>
              <PromptInputSubmit
                status={chat.status}
                onStop={onStop ?? (() => void chat.stop())}
                className="size-8 self-end rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              />
            </PromptInputFooter>
          </PromptInput>
          </div>
        </div>
      </div>
    </section>
  );
}

function hasVisibleAssistantWork(messages: ChatUIMessage[]): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;

  return last.parts.some((part) => {
    if (part.type === "text") return part.text.length > 0;
    // A reasoning part is visible as soon as it exists, even before the first
    // delta arrives, so the loading placeholder never doubles up with it.
    if (part.type === "reasoning") return true;
    return isToolUIPart(part);
  });
}

/** 暂存了图片但当前模型明确不支持图片输入时的一行提示。必须在
 * PromptInput 内渲染（读取附件上下文）；模态未知时不提示。 */
function AttachmentVisionHint({ acceptsImages }: { acceptsImages?: boolean }) {
  const attachments = usePromptInputAttachments();
  const hasImage = attachments.files.some((file) =>
    file.mediaType.startsWith("image/"),
  );
  if (!hasImage || acceptsImages !== false) return null;
  return (
    <p className="flex w-full items-center gap-1.5 px-1 pb-1 text-xs text-amber-600 dark:text-amber-400">
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        当前模型未声明图片输入，附件图片可能被忽略。可在「管理模型」中勾选模型的图像输入模态，或切换到支持视觉的模型。
      </span>
    </p>
  );
}

function AssistantLoadingView({ effort }: { effort: ReasoningEffort }) {
  if (effort !== "off") {
    // 与消息流里的 ThinkingLine 保持一致的一行式占位。
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
        <SparklesIcon className="size-3.5 shrink-0" />
        <Shimmer as="span" duration={1.6}>思考中…</Shimmer>
      </div>
    );
  }

  // Pure CSS animations only: JS-driven ones (motion) freeze whenever the
  // main thread is busy rendering the stream, which reads as "stuck".
  return (
    <div className="flex w-full items-center gap-3 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <span className="block h-3 w-40 animate-pulse rounded bg-muted-foreground/25" />
        <span className="block h-3 max-w-64 animate-pulse rounded bg-muted-foreground/15 [animation-delay:150ms]" />
      </div>
    </div>
  );
}

function AssistantErrorView({ message }: { message: string }) {
  const friendly = friendlyErrorText(message);
  const detail = rawErrorDetail(message);
  return (
    <div className="w-full space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">{friendly}</span>
      </div>
      {detail ? (
        <Collapsible className="text-xs">
          <CollapsibleTrigger className="text-muted-foreground underline-offset-2 hover:underline">
            技术详情
          </CollapsibleTrigger>
          <CollapsibleContent className="outline-none">
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** 历史/结束后补充的回合结果提示：失败用错误色，中止用中性色。 */
function TurnNoteView({ note }: { note: TurnOutcomeNote }) {
  const failed = note.kind === "failed";
  return (
    <div
      className={
        failed
          ? "flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          : "flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      }
    >
      {failed ? (
        <CircleAlertIcon className="size-3.5 shrink-0" />
      ) : (
        <InfoIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">{note.message}</span>
    </div>
  );
}
