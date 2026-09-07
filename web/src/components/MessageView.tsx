import { isToolUIPart, type FileUIPart, type ReasoningUIPart } from "ai";
import {
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MinusIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  SquareStackIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { memo, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DiffCard } from "@/components/ai-elements/diff-block";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  extractWebFetchOutput,
  extractWebSearchOutput,
  WebFetchContent,
  WebSearchResults,
} from "@/components/ai-elements/web-results";
import { ImageLightbox } from "@/components/ImageLightbox";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  messageText,
  splitCronContext,
  stripCronContext,
  type ChatUIMessage,
  type CronContextInfo,
  type SubagentEventData,
  type ToolPart,
} from "@/lib/chat-utils";
import { describeTool, type ToolAction } from "@/lib/tool-display";

interface MessageViewProps {
  message: ChatUIMessage;
  isStreaming?: boolean;
  selectedToolId?: string;
  onToolSelect?: (id: string) => void;
}

function MessageViewBase({
  message,
  isStreaming = false,
  selectedToolId,
  onToolSelect,
}: MessageViewProps) {
  const isUser = message.role === "user";

  // 连续的 reasoning / tool 调用归为一个“活动”块，整块折叠成一行
  // （“处理中 … / 已处理 · N 个步骤”）；其余 part 原样渲染。
  // 委派子智能体的 data-oh:subagent.* 事件先折叠为单张实时卡片。
  const parts = useMemo(() => collapseSubagentParts(message.parts), [message.parts]);
  const blocks = useMemo(() => groupParts(parts), [parts]);

  const renderAssistantPart = (
    part: RenderablePart,
    index: number,
    isGroupActive: boolean,
  ): ReactNode => {
    if (part.type === "oh-delegation-card") {
      return <DelegationCard key={`delegation-${part.data.delegationId}`} data={part.data} />;
    }
    if (part.type === "text") {
      return (
        <MessageContent key={index}>
          <MessageResponse>{linkifyUrls(stripCronContext(part.text))}</MessageResponse>
        </MessageContent>
      );
    }
    if (part.type === "reasoning") {
      return <ThinkingLine key={index} part={part} streaming={isGroupActive} />;
    }
    if (part.type === "file") {
      return (
        <MessageContent key={index}>
          <FilePartView part={part} />
        </MessageContent>
      );
    }
    if (isToolUIPart(part)) {
      return (
        <ToolLine
          key={part.toolCallId}
          part={part}
          active={selectedToolId === part.toolCallId}
          onToolSelect={onToolSelect}
        />
      );
    }
    return <DataPartView key={index} part={part} />;
  };

  return (
    // content-visibility lets the browser skip layout/paint of messages that
    // are outside the viewport; long conversations scroll and stream smoothly.
    <Message
      from={message.role}
      data-minimap-id={message.id}
      className="[content-visibility:auto] [contain-intrinsic-size:auto_720px]"
    >
      {isUser ? (
        <MessageContent>
          {message.parts.map((part, index) => {
            if (part.type === "text") {
              // 定时任务发起的回合：剥离 <cron-context> 原始块，换主题色徽标。
              const { context, text } = splitCronContext(part.text);
              return (
                <Fragment key={index}>
                  {context ? <CronOriginBadge context={context} /> : null}
                  {text ? <p className="whitespace-pre-wrap">{text}</p> : null}
                </Fragment>
              );
            }
            if (part.type === "file") {
              return <FilePartView key={index} part={part} />;
            }
            return null;
          })}
        </MessageContent>
      ) : (
        blocks.map((block, index) =>
          block.kind === "activity" ? (
            block.items.length === 1 ? (
              renderAssistantPart(
                block.items[0].part,
                index,
                block.items[0].kind === "thinking" && block.items[0].part.state === "streaming",
              )
            ) : (
              <ActivityGroup
                key={index}
                items={block.items}
                isActive={isStreaming && index === blocks.length - 1}
                selectedToolId={selectedToolId}
                onToolSelect={onToolSelect}
              />
            )
          ) : (
            renderAssistantPart(block.part, index, false)
          ),
        )
      )}
      {isUser || !isStreaming ? (
        <MessageActions className={isUser ? "justify-end" : undefined}>
          <MessageAction
            tooltip="复制消息"
            onClick={() => void navigator.clipboard.writeText(messageText(message))}
          >
            <CopyIcon size={14} />
          </MessageAction>
        </MessageActions>
      ) : null}
    </Message>
  );
}

type ActivityItem =
  | { kind: "thinking"; part: ReasoningUIPart }
  | { kind: "tool"; part: ToolPart };

/** 一个后台委派的聚合视图：start/progress/done/error 事件折叠成这一张卡。 */
interface DelegationCardData {
  delegationId: string;
  agentName: string;
  task?: string;
  steps: number;
  currentTool?: string;
  status: "running" | "completed" | "failed" | "aborted" | "stopped";
  durationMs?: number;
  error?: string;
}

type DelegationCardPart = { type: "oh-delegation-card"; data: DelegationCardData };
type RenderablePart = ChatUIMessage["parts"][number] | DelegationCardPart;

/** 把同一委派的全部 data-oh:subagent.* 事件折叠为一张卡片（位置取 start
 * 首次出现处；缺 start 的孤儿事件——例如回放截断——在首次出现处建卡）。 */
function collapseSubagentParts(parts: ChatUIMessage["parts"]): RenderablePart[] {
  if (!parts.some((part) => part.type.startsWith("data-oh:subagent."))) return parts;
  const out: RenderablePart[] = [];
  const cards = new Map<string, DelegationCardData>();
  for (const part of parts) {
    if (!part.type.startsWith("data-oh:subagent.")) {
      out.push(part);
      continue;
    }
    const data = (part as { data?: SubagentEventData }).data;
    if (!data) continue;
    const key = data.delegationId || data.agentName || "unknown";
    let card = cards.get(key);
    if (!card) {
      card = {
        delegationId: key,
        agentName: data.agentName || "子智能体",
        task: data.task,
        steps: 0,
        status: "running",
      };
      cards.set(key, card);
      out.push({ type: "oh-delegation-card", data: card });
    }
    if (part.type === "data-oh:subagent.start") {
      if (data.task) card.task = data.task;
      if (data.agentName) card.agentName = data.agentName;
    } else if (part.type === "data-oh:subagent.progress") {
      card.steps = data.steps ?? card.steps;
      card.currentTool = data.currentTool;
    } else if (part.type === "data-oh:subagent.done") {
      card.status = data.status ?? "completed";
      card.durationMs = data.durationMs;
      card.steps = data.steps ?? card.steps;
      card.currentTool = undefined;
    } else if (part.type === "data-oh:subagent.error") {
      card.status = "failed";
      card.error = data.error;
      card.currentTool = undefined;
    }
  }
  return out;
}

/** 把消息里的裸 URL 转成 markdown 链接（dev server 地址等），点击后由
 * ChatPane 的捕获层送进内置浏览器面板。跳过代码围栏与行内代码，避免
 * 改写代码内容；已处在链接语法里的 URL（前邻 [ 或 ( ）不再重复包一层。 */
function linkifyUrls(text: string): string {
  const linkifySegment = (segment: string) =>
    segment
      .split(/(`[^`\n]*`)/g)
      .map((piece, pieceIndex) =>
        pieceIndex % 2 === 1
          ? piece
          : piece.replace(
              /(^|[^[(\w])(https?:\/\/[^\s<>()[\]{}]*)/g,
              (_match, prefix: string, rawUrl: string) => {
                const url = rawUrl.replace(/[.,;:。；、*_]+$/, "");
                const tail = rawUrl.slice(url.length);
                return `${prefix}[${url}](${url})${tail}`;
              },
            ),
      )
      .join("");
  return text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((segment, index) => (index % 2 === 1 ? segment : linkifySegment(segment)))
    .join("");
}

type AssistantBlock =
  | { kind: "activity"; items: ActivityItem[] }
  | { kind: "part"; part: RenderablePart };

function groupParts(parts: RenderablePart[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  let activity: ActivityItem[] | null = null;
  const flush = () => {
    if (activity && activity.length > 0) blocks.push({ kind: "activity", items: activity });
    activity = null;
  };
  parts.forEach((part) => {
    if (part.type === "reasoning") {
      activity = activity ?? [];
      activity.push({ kind: "thinking", part });
      return;
    }
    if (part.type !== "oh-delegation-card" && isToolUIPart(part)) {
      activity = activity ?? [];
      activity.push({ kind: "tool", part });
      return;
    }
    flush();
    blocks.push({ kind: "part", part });
  });
  flush();
  return blocks;
}

/** Streaming updates replace the message object each chunk; unchanged parts
 * keep their object identity, so memoized part views skip everything except
 * the actively streaming part. */
const ThinkingLine = memo(function ThinkingLine({
  part,
  streaming,
}: {
  part: ReasoningUIPart;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const text = part.text ?? "";
  const tail = lastThinkingLine(text);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/think w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
        <SparklesIcon className="size-3.5 shrink-0" />
        {streaming ? <Shimmer as="span" duration={1.6}>思考中</Shimmer> : <span className="shrink-0">思考</span>}
        {tail ? <span className="min-w-0 flex-1 truncate">{tail}</span> : null}
        <ChevronRightIcon className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]/think:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="outline-none">
        <div className="ml-3 border-l py-1 pl-3 text-sm text-muted-foreground">
          {text ? (
            <Streamdown plugins={streamdownPlugins}>{text}</Streamdown>
          ) : (
            <Shimmer duration={2}>等待思考输出…</Shimmer>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

const streamdownPlugins = { cjk, code, math, mermaid };

/** 思考文本的一行式摘要：取最后一个非空行，去掉 Markdown 修饰符。 */
function lastThinkingLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^#+\s*|\*\*/g, "").trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length > 100 ? `${last.slice(0, 100)}…` : last;
}

const ACTION_ICONS: Record<ToolAction, typeof WrenchIcon> = {
  read: FileTextIcon,
  list: FolderIcon,
  search: SearchIcon,
  write: SquarePenIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  git: GitBranchIcon,
  task: ListTodoIcon,
  delegate: BotIcon,
  browse: GlobeIcon,
  cron: CalendarClockIcon,
  use: WrenchIcon,
};

const RUNNING_STATES = new Set<ToolPart["state"]>(["input-streaming", "input-available"]);

function StatusPill({ state }: { state: ToolPart["state"] }) {
  if (state === "output-available") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <CheckIcon className="size-3 text-green-600" />
        已完成
      </span>
    );
  }
  if (state === "output-error") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-red-600">
        <XCircleIcon className="size-3" />
        失败
      </span>
    );
  }
  if (state === "output-denied") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-orange-600">
        <MinusIcon className="size-3" />
        已拒绝
      </span>
    );
  }
  if (state === "approval-requested") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-yellow-600">
        <ClockIcon className="size-3" />
        等待审批
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <LoaderCircleIcon className="size-3 animate-spin" />
      运行中
    </span>
  );
}

/** PI 式委派卡片：一行头部（子智能体名 + 实时步骤/状态），展开看任务简报。
 * 运行中实时计时并在折叠头显示当前内部工具；结束后收起为“已完成 · N 个步骤 · 时长”。 */
const DelegationCard = memo(function DelegationCard({ data }: { data: DelegationCardData }) {
  const running = data.status === "running";
  const [open, setOpen] = useState(running);
  const wasRunningRef = useRef(running);

  // 运行→结束时自动收起；再次开始（同 id 复用极罕见）则重新展开。
  useEffect(() => {
    if (wasRunningRef.current !== running) {
      setOpen(running);
      wasRunningRef.current = running;
    }
  }, [running]);

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const startedAt = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [running]);

  const failed = data.status === "failed";
  const stopped = data.status === "stopped" || data.status === "aborted";
  const duration = data.durationMs
    ? formatDuration(data.durationMs)
    : running
      ? `${elapsed}s`
      : "";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/delegation w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
        <BotIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-mono">{data.agentName}</span>
        {running ? (
          <Shimmer
            as="span"
            duration={1.6}
          >{`运行中${data.steps > 0 ? ` · ${data.steps} 个步骤` : ""}`}</Shimmer>
        ) : failed ? (
          <span className="flex shrink-0 items-center gap-1 text-red-600">
            <XCircleIcon className="size-3" />
            失败
          </span>
        ) : stopped ? (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <MinusIcon className="size-3" />
            已停止
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <CheckIcon className="size-3 text-green-600" />
            已完成
          </span>
        )}
        {!running && data.steps > 0 ? (
          <span className="shrink-0">· {data.steps} 个步骤</span>
        ) : null}
        {duration ? <span className="shrink-0 text-[11px]">· {duration}</span> : null}
        {running && data.currentTool ? (
          <span className="min-w-0 flex-1 truncate font-mono">{data.currentTool}…</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <ChevronRightIcon className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]/delegation:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="outline-none">
        <div className="ml-3 space-y-1.5 border-l py-1 pl-3 text-xs text-muted-foreground">
          {data.task ? (
            <p className="whitespace-pre-wrap break-words">{data.task}</p>
          ) : null}
          {failed && data.error ? (
            <p className="break-words text-red-600">{data.error}</p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

/** Successful edit-tool outputs carry the before/after diff; render it as a
 * diff card instead of the raw JSON dump ToolOutput would print. */
const EDIT_TOOLS = new Set(["editFile", "writeFile"]);

interface EditDiffInfo {
  path: string;
  unifiedDiff: string | null;
  additions?: number;
  deletions?: number;
  changeKind?: string;
}

function extractEditDiff(toolName: string, part: ToolPart): EditDiffInfo | null {
  if (!EDIT_TOOLS.has(toolName) || part.state !== "output-available") return null;
  const output = "output" in part ? part.output : undefined;
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  if (typeof record.error === "string") return null;
  if (typeof record.path !== "string") return null;
  return {
    path: record.path,
    unifiedDiff: typeof record.unifiedDiff === "string" ? record.unifiedDiff : null,
    additions: typeof record.additions === "number" ? record.additions : undefined,
    deletions: typeof record.deletions === "number" ? record.deletions : undefined,
    changeKind: typeof record.changeKind === "string" ? record.changeKind : undefined,
  };
}

function extractGitDiff(toolName: string, part: ToolPart): string | null {
  if (toolName !== "gitDiff" || part.state !== "output-available") return null;
  const output = "output" in part ? part.output : undefined;
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  return typeof record.diff === "string" && record.diff !== "(no changes)" ? record.diff : null;
}

/** 单行工具调用：图标 + 动词 + 参数摘要 + 状态，展开后才是详细输入/输出。 */
const ToolLine = memo(
  function ToolLine({
    part,
    active,
    onToolSelect,
  }: {
    part: ToolPart;
    active: boolean;
    onToolSelect?: (id: string) => void;
  }) {
    const title = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
    const display = describeTool(part);
    const ActionIcon = ACTION_ICONS[display.action];
    const running = RUNNING_STATES.has(part.state) || part.state === "approval-requested";
    const failed = part.state === "output-error";
    const [open, setOpen] = useState(failed);

    // 失败的调用自动展开，让错误第一时间可见。
    useEffect(() => {
      if (failed) setOpen(true);
    }, [failed]);

    const select = () => onToolSelect?.(part.toolCallId);
    const editDiff = extractEditDiff(title, part);
    const gitDiffText = extractGitDiff(title, part);
    // webSearch/webFetch 成功时用专属卡片代替输入/输出 JSON（卡片头部已带查询词或网址）
    const searchOutput = extractWebSearchOutput(title, part);
    const fetchOutput = extractWebFetchOutput(title, part);

    return (
      <Collapsible open={open} onOpenChange={setOpen} className="group/tool w-full">
        {/* The active highlight is an inset ring: a regular outer ring paints
            1px outside the row, and content-visibility paint containment on
            Message clips it wherever the full-width row touches the edges. */}
        <CollapsibleTrigger
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors",
            active
              ? "inset-ring-1 inset-ring-ring bg-accent"
              : "hover:bg-muted/50",
          )}
          onClick={select}
        >
          <ActionIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0">{running ? display.runningVerb : display.verb}</span>
          {display.summary ? (
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {display.summary}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <StatusPill state={part.state} />
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="outline-none">
          <div className="ml-3 space-y-3 border-l py-1 pl-3">
            {"input" in part && part.input !== undefined && !searchOutput && !fetchOutput ? (
              <ToolInput input={part.input} />
            ) : null}
            {searchOutput ? <WebSearchResults output={searchOutput} /> : null}
            {fetchOutput ? <WebFetchContent output={fetchOutput} /> : null}
            {editDiff ? (
              <div className="space-y-2">
                <DiffCard
                  title={
                    editDiff.changeKind === "create"
                      ? `新建 ${editDiff.path}`
                      : editDiff.path
                  }
                  diff={editDiff.unifiedDiff}
                  additions={editDiff.additions}
                  deletions={editDiff.deletions}
                />
              </div>
            ) : null}
            {gitDiffText ? (
              <DiffCard title="git diff" diff={gitDiffText} defaultOpen={false} />
            ) : null}
            {editDiff || searchOutput || fetchOutput ? null : (
              <ToolOutput
                output={"output" in part ? part.output : undefined}
                errorText={"errorText" in part ? part.errorText : undefined}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  },
  (prev, next) =>
    prev.part === next.part &&
    prev.active === next.active &&
    prev.onToolSelect === next.onToolSelect,
);

/** 一段活动（若干思考 + 工具调用）的分组折叠头：
 * 进行中显示实时计时与当前动作的一行摘要，结束后收起为
 * “已处理 · N 个步骤”。 */
const ActivityGroup = memo(function ActivityGroup({
  items,
  isActive,
  selectedToolId,
  onToolSelect,
}: {
  items: ActivityItem[];
  isActive: boolean;
  selectedToolId?: string;
  onToolSelect?: (id: string) => void;
}) {
  // 流式期间默认展开，让每个调用按行出现；结束后自动收起。
  // 手动开合不受 isActive 翻转影响。
  const [open, setOpen] = useState(isActive);
  const wasActiveRef = useRef(isActive);

  useEffect(() => {
    if (wasActiveRef.current !== isActive) {
      setOpen(isActive);
      wasActiveRef.current = isActive;
    }
  }, [isActive]);

  // 从右侧面板选中本组内的工具时，展开定位到它。
  const containsSelected =
    selectedToolId !== undefined &&
    items.some((item) => item.kind === "tool" && item.part.toolCallId === selectedToolId);
  useEffect(() => {
    if (containsSelected) setOpen(true);
  }, [containsSelected]);

  // 处理中的实时计时。
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    setElapsed(0);
    const startedAt = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [isActive]);

  const lastItem = items[items.length - 1];
  const thinkingNow =
    isActive && lastItem.kind === "thinking" && lastItem.part.state === "streaming";
  const tail = isActive && !open && lastItem ? activityItemSummary(lastItem) : "";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/activity w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
        <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
        {isActive ? (
          <Shimmer as="span" duration={1.6}>
            {`${thinkingNow ? "思考中" : "处理中"}${elapsed > 0 ? ` ${elapsed}s` : ""}`}
          </Shimmer>
        ) : (
          <span className="shrink-0">已处理 · {items.length} 个步骤</span>
        )}
        {tail ? (
          <span className="min-w-0 flex-1 truncate" aria-hidden>
            {tail}
          </span>
        ) : null}
        <ChevronRightIcon className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]/activity:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 outline-none data-[state=closed]:hidden">
        {items.map((item, index) =>
          item.kind === "tool" ? (
            <ToolLine
              key={item.part.toolCallId}
              part={item.part}
              active={selectedToolId === item.part.toolCallId}
              onToolSelect={onToolSelect}
            />
          ) : (
            <ThinkingLine
              key={`thinking-${index}`}
              part={item.part}
              streaming={isActive && index === items.length - 1 && item.part.state === "streaming"}
            />
          ),
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});

function activityItemSummary(item: ActivityItem): string {
  if (item.kind === "thinking") {
    return lastThinkingLine(item.part.text ?? "");
  }
  const display = describeTool(item.part);
  const running = RUNNING_STATES.has(item.part.state);
  const verb = running ? display.runningVerb : display.verb;
  return display.summary ? `${verb} ${display.summary}` : verb;
}

function FilePartView({ part }: { part: FileUIPart }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  if (part.mediaType.startsWith("image/")) {
    return (
      <>
        <button
          type="button"
          title="点击预览"
          className="block cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setPreviewOpen(true)}
        >
          <img
            src={part.url}
            alt={part.filename ?? "附件"}
            className="max-h-40 rounded-md border"
          />
        </button>
        <ImageLightbox
          src={part.url}
          filename={part.filename}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      </>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
      <PaperclipIcon className="size-3" />
      {part.filename ?? part.mediaType}
    </span>
  );
}

type DataPart = ChatUIMessage["parts"][number];

function DataPartView({ part }: { part: DataPart }): ReactNode {
  switch (part.type) {
    // data-oh:subagent.* 在 collapseSubagentParts 里已折叠为 DelegationCard。
    case "data-oh:compaction.done":
      return (
        <SystemNote icon={<SquareStackIcon className="size-3.5" />}>
          上下文已压缩（移除 {part.data.messagesRemoved} 条消息）
        </SystemNote>
      );
    case "data-oh:retry":
      return (
        <SystemNote icon={<RefreshCwIcon className="size-3.5" />}>
          正在重试（第 {part.data.attempt} 次）：{part.data.reason}
        </SystemNote>
      );
    case "data-oh:preview.open":
      return (
        <SystemNote icon={<GlobeIcon className="size-3.5" />}>
          {part.data.kind === "server" ? "开发服务器已就绪" : "页面已生成"}
          {part.data.label ? `（${part.data.label}）` : ""}，已在浏览器面板中打开
        </SystemNote>
      );
    default:
      return null;
  }
}

function SystemNote({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/** 定时任务回合的来源徽标：主题色胶囊 + 时钟图标 + 任务名/触发时间，
 * 代替消息里原始的 <cron-context> 元数据块。 */
function CronOriginBadge({ context }: { context: CronContextInfo }) {
  const startedAt = context.startedAt ? new Date(context.startedAt) : undefined;
  const timeLabel = startedAt && !Number.isNaN(startedAt.getTime())
    ? startedAt.toLocaleString()
    : undefined;
  return (
    <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
      <CalendarClockIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">定时任务{context.cronName ? ` · ${context.cronName}` : ""}</span>
      {timeLabel ? (
        <span className="shrink-0 font-normal text-primary/70">{timeLabel}</span>
      ) : null}
    </span>
  );
}

/** Historical messages keep their object identity across streaming updates and
 * polls, so this comparator makes per-chunk re-renders skip every message
 * except the one actively streaming. Long conversations stay interactive. */
export const MessageView = memo(
  MessageViewBase,
  (prev, next) =>
    prev.message === next.message &&
    prev.isStreaming === next.isStreaming &&
    prev.selectedToolId === next.selectedToolId &&
    prev.onToolSelect === next.onToolSelect,
);
MessageView.displayName = "MessageView";
