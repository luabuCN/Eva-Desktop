import { prisma } from "../db.js";
import { sessionRepository } from "../repositories/session-repository.js";
import type { ChatUIMessage } from "../chat-types.js";
import type { ModelSelection } from "../providers/provider-service.js";
import {
  parseToolPermissionMap,
  type ApprovalDecision,
  type AskUserBridge,
  type AskUserQuestion,
  type PlanApprovalBridge,
  type PlanDecision,
} from "./tools/index.js";
import { isCommandAllowed } from "./tools/command-rules.js";

export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_approval"] as const;

interface StartRunInput {
  conversationId: string;
  messages: ChatUIMessage[];
  projectId?: string;
  agentId?: string;
  thinkingMode: string;
  permissionMode: string;
  selection?: ModelSelection;
}

interface ActiveRunHandle {
  abort(): void;
  approvals: InteractiveApprovalBridge;
  asks: AskUserBridge;
  plans: InteractivePlanBridge;
}

function messageTitle(messages: ChatUIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const title = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
    if (title) return title.slice(0, 80);
  }
  return undefined;
}

class InteractiveApprovalBridge {
  private static readonly TIMEOUT_MS = 5 * 60 * 1_000;

  /** Tool names the user chose to always allow; skips new approval records for the rest of the run. */
  private readonly alwaysAllowed = new Set<string>();

  constructor(
    private readonly runId: string,
    private readonly signal?: AbortSignal,
    private readonly projectId?: string,
  ) {}

  allowAlways(toolName: string) {
    this.alwaysAllowed.add(toolName);
  }

  async request(toolName: string, input: string): Promise<ApprovalDecision> {
    if (this.alwaysAllowed.has(toolName)) {
      return { kind: "approved" };
    }

    // 命令级放行：bash 的审批请求先过 allowlist（内置只读表 + 用户规则），
    // 命中的免卡直接执行——弹卡的是真正需要看的命令。
    if (toolName === "bash") {
      try {
        const parsed: unknown = JSON.parse(input);
        const command =
          parsed && typeof parsed === "object" && typeof (parsed as { command?: unknown }).command === "string"
            ? (parsed as { command: string }).command
            : "";
        if (command && (await isCommandAllowed(command, this.projectId))) {
          return { kind: "approved" };
        }
      } catch {
        // 输入不是合法 JSON 时照常弹卡。
      }
    }

    const approval = await prisma.toolApproval.create({
      data: { runId: this.runId, toolName, input },
    });
    await runService.updateStatus(this.runId, "waiting_approval");

    const deadline = Date.now() + InteractiveApprovalBridge.TIMEOUT_MS;
    while (Date.now() < deadline && !this.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const decision = await prisma.toolApproval.findUnique({ where: { id: approval.id } });
      if (!decision) break;
      if (decision.status === "approved") {
        await runService.updateStatus(this.runId, "running");
        return { kind: "approved", approvalId: decision.id };
      }
      if (decision.status === "rejected") {
        await runService.updateStatus(this.runId, "running");
        return { kind: "rejected", reason: decision.decisionBy ? `by ${decision.decisionBy}` : undefined };
      }
    }

    if (this.signal?.aborted) {
      await prisma.toolApproval.update({
        where: { id: approval.id },
        data: { status: "cancelled", decidedAt: new Date() },
      });
      return { kind: "aborted" };
    }

    await prisma.toolApproval.update({
      where: { id: approval.id },
      data: { status: "timeout", decidedAt: new Date() },
    });
    await runService.updateStatus(this.runId, "running");
    return { kind: "timeout" };
  }
}

/**
 * askUser 工具的交互桥：与审批同一套路（落一行 pending 记录 + 500ms 轮询），
 * 但没有有效期——卡片会一直挂着，直到用户提交/跳过、或运行被中止。
 * 中止时按“全部跳过”收尾（null 数组），让工具调用体面地结束而不是悬挂。
 */
class InteractiveAskBridge implements AskUserBridge {
  constructor(
    private readonly runId: string,
    private readonly signal?: AbortSignal,
  ) {}

  async ask(questions: AskUserQuestion[]): Promise<Array<string[] | null>> {
    const skipped = questions.map(() => null);
    const prompt = await prisma.askUserPrompt.create({
      data: { runId: this.runId, questions: JSON.stringify(questions) },
    });
    await runService.updateStatus(this.runId, "waiting_approval");

    while (!this.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const row = await prisma.askUserPrompt.findUnique({ where: { id: prompt.id } });
      if (!row) break;
      if (row.status === "answered" && row.answers) {
        await runService.updateStatus(this.runId, "running");
        try {
          const parsed: unknown = JSON.parse(row.answers);
          if (Array.isArray(parsed) && parsed.length === questions.length) {
            return parsed as Array<string[] | null>;
          }
        } catch {
          // Malformed answers fall through to the skipped result below.
        }
        break;
      }
      if (row.status === "cancelled") {
        await runService.updateStatus(this.runId, "running");
        return skipped;
      }
    }

    await prisma.askUserPrompt.update({
      where: { id: prompt.id },
      data: { status: "cancelled" },
    }).catch(() => undefined);
    // 运行已被中止时不再改状态，收尾交给 finish(..., "aborted")。
    if (!this.signal?.aborted) {
      await runService.updateStatus(this.runId, "running");
    }
    return skipped;
  }
}

/**
 * ExitPlanMode 工具的裁决桥：与 askUser 同套路（落一行 pending 记录 +
 * 500ms 轮询），同样不设有效期——用户不决定就等着，卡片跨刷新/后台运行
 * 都在。中止时按「未裁决」收尾（返回 null，工具按拒绝处理）。
 */
class InteractivePlanBridge implements PlanApprovalBridge {
  constructor(
    private readonly runId: string,
    private readonly signal?: AbortSignal,
  ) {}

  async request(plan: string): Promise<PlanDecision | null> {
    const prompt = await prisma.planApprovalPrompt.create({
      data: { runId: this.runId, plan },
    });
    await runService.updateStatus(this.runId, "waiting_approval");

    while (!this.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const row = await prisma.planApprovalPrompt.findUnique({ where: { id: prompt.id } });
      if (!row) break;
      if (row.status === "approved" && (row.action === "approve" || row.action === "approve_full")) {
        await runService.updateStatus(this.runId, "running");
        return { action: row.action };
      }
      if (row.status === "rejected") {
        await runService.updateStatus(this.runId, "running");
        return { action: "reject", feedback: row.feedback ?? undefined };
      }
    }

    await prisma.planApprovalPrompt.update({
      where: { id: prompt.id },
      data: { status: "cancelled" },
    }).catch(() => undefined);
    // 运行已被中止时不再改状态，收尾交给 finish(..., "aborted")。
    if (!this.signal?.aborted) {
      await runService.updateStatus(this.runId, "running");
    }
    return null;
  }
}

class ThreadRunService {
  private readonly activeRuns = new Map<string, ActiveRunHandle>();

  async start(input: StartRunInput) {
    // Persist the user's current input before streaming so a browser reload or
    // disconnect cannot lose the turn that initiated the run.
    if (!input.messages || input.messages.length === 0) {
      throw new Error("A chat run requires at least one message.");
    }
    await sessionRepository.saveUIMessages(
      input.conversationId,
      input.messages,
      messageTitle(input.messages),
    );
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: input.projectId ? { projectId: input.projectId } : {},
    });

    return prisma.threadRun.create({
      data: {
        conversationId: input.conversationId,
        projectId: input.projectId ?? null,
        thinkingMode: input.thinkingMode,
        permissionMode: input.permissionMode,
        agentId: input.agentId ?? null,
        providerId: input.selection?.providerId ?? null,
        modelId: input.selection?.modelId ?? null,
        status: "running",
        startedAt: new Date(),
      },
    });
  }

  /**
   * 为运行建立独立的中止控制器。外部信号（HTTP 请求断开）不再传入：
   * 运行与客户端连接解耦，切换会话/刷新页面只断开视图，运行转入后台；
   * 只有显式调用 abort()（停止按钮 → POST /api/runs/conversations/:id/abort）
   * 才会真正中止。
   */
  registerAbortSource(runId: string, projectId?: string) {
    const controller = new AbortController();
    const approvals = new InteractiveApprovalBridge(runId, controller.signal, projectId);
    const asks = new InteractiveAskBridge(runId, controller.signal);
    const plans = new InteractivePlanBridge(runId, controller.signal);
    const handle: ActiveRunHandle = {
      abort: () => controller.abort(),
      approvals,
      asks,
      plans,
    };
    this.activeRuns.set(runId, handle);

    return {
      signal: controller.signal,
      approvals,
      asks,
      plans,
      cleanup: () => {
        this.activeRuns.delete(runId);
      },
    };
  }

  /**
   * "Always allow" for one tool: suppress further prompts in the current run and,
   * when the run belongs to a project, persist the grant so later runs skip asking too.
   */
  async allowAlways(runId: string, toolName: string) {
    this.activeRuns.get(runId)?.approvals.allowAlways(toolName);

    const run = await prisma.threadRun.findUnique({
      where: { id: runId },
      select: { projectId: true },
    });
    if (!run?.projectId) return;

    const project = await prisma.project.findUnique({
      where: { id: run.projectId },
      select: { toolPermissions: true },
    });
    const permissions = parseToolPermissionMap(project?.toolPermissions);
    permissions[toolName] = { enabled: true, requireApproval: false };
    await prisma.project.update({
      where: { id: run.projectId },
      data: { toolPermissions: JSON.stringify(permissions) },
    });
  }

  async appendTransition(runId: string, eventType: string, payload: unknown) {
    const transitionTypes = new Set([
      "start", "start-step", "finish-step", "finish", "abort", "error",
      "reasoning-start", "reasoning-end",
      "tool-input-available", "tool-input-error",
      "tool-approval-request",
      "tool-output-available", "tool-output-error",
      "tool-output-denied",
    ]);
    if (!transitionTypes.has(eventType)) return;

    const aggregate = await prisma.runEvent.aggregate({
      where: { runId },
      _max: { sequence: true },
    });
    const sequence = (aggregate._max.sequence ?? -1) + 1;
    await prisma.runEvent.create({
      data: { runId, sequence, eventType, payload: JSON.stringify(payload) },
    });
  }

  async saveStep(conversationId: string, messages: ChatUIMessage[], title?: string) {
    await sessionRepository.saveUIMessages(conversationId, messages, title);
  }

  async finish(runId: string, status: "completed" | "failed" | "aborted", error?: string) {
    const existing = await prisma.threadRun.findUnique({ where: { id: runId } });
    if (!existing || !ACTIVE_RUN_STATUSES.includes(existing.status as typeof ACTIVE_RUN_STATUSES[number])) {
      return;
    }

    await prisma.threadRun.update({
      where: { id: runId },
      data: {
        status,
        error: error?.slice(0, 2_000),
        completedAt: new Date(),
      },
    });
  }

  async updateStatus(runId: string, status: "running" | "waiting_approval") {
    await prisma.threadRun.update({
      where: { id: runId },
      data: { status },
    });
  }

  abort(runId: string) {
    return this.activeRuns.get(runId)?.abort();
  }

  /** 会话当前是否有进行中的运行（queued/running/waiting_approval）。 */
  activeRun(conversationId: string) {
    return prisma.threadRun.findFirst({
      where: { conversationId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      orderBy: { createdAt: "desc" },
    });
  }

  listForConversation(conversationId: string) {
    return prisma.threadRun.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        approvals: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        asks: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        plans: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });
  }

  find(id: string) {
    return prisma.threadRun.findUnique({
      where: { id },
      include: {
        approvals: { orderBy: { createdAt: "desc" }, take: 50 },
        asks: { orderBy: { createdAt: "desc" }, take: 50 },
        plans: { orderBy: { createdAt: "desc" }, take: 50 },
        events: { orderBy: { sequence: "asc" }, take: 200 },
      },
    });
  }
}

export const runService = new ThreadRunService();
