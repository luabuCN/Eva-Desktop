import { Cron } from "croner";
import { prisma } from "../db.js";
import type { ChatUIMessage } from "../chat-types.js";
import { agentRuntime } from "./agent-runtime.js";
import { isValidCronPattern, nextRunFor } from "./cron-utils.js";
import { ACTIVE_RUN_STATUSES, runService } from "./run-service.js";
import type { PermissionMode } from "./types.js";

export { isValidCronPattern } from "./cron-utils.js";

/** 单个任务保留的执行历史条数（内嵌 JSON，越界截尾）。 */
const RUN_HISTORY_LIMIT = 50;
/** 轮询运行终态的兜底上限：超过后按失败收尾，避免僵尸 running 记录。 */
const RUN_WATCH_TIMEOUT_MS = 30 * 60 * 1_000;
const RUN_POLL_INTERVAL_MS = 2_000;

export interface CronRunRecord {
  startedAt: string;
  endedAt?: string;
  conversationId?: string;
  runId?: string;
  status: "running" | "success" | "failed";
  error?: string;
  trigger?: "schedule" | "manual";
}

export interface CronJobInput {
  name: string;
  prompt: string;
  cron: string;
  description?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  permissionMode: PermissionMode;
  isActive: boolean;
  reuseThread: boolean;
}

function parseRunHistory(raw: string): CronRunRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CronRunRecord[]) : [];
  } catch {
    return [];
  }
}

function appendRunHistory(history: CronRunRecord[], record: CronRunRecord): CronRunRecord[] {
  const next = [...history, record];
  return next.length > RUN_HISTORY_LIMIT
    ? next.slice(next.length - RUN_HISTORY_LIMIT)
    : next;
}

function replaceLastRun(history: CronRunRecord[], record: CronRunRecord): CronRunRecord[] {
  const list = [...history];
  if (list.length === 0) return [record];
  list[list.length - 1] = record;
  return list;
}

function truncateError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/**
 * 定时任务服务：croner 按本机时区调度，到点把任务的提示词（附 cron 上下文
 * 前缀）作为一次普通的 agent 运行发起。运行与 HTTP 客户端解耦（见
 * agent-runtime 的后台泵），因此关窗/无人值守时照常执行，产物是普通会话，
 * 用户可随时打开查看或续接。
 */
class CronService {
  private readonly scheduledJobs = new Map<string, Cron>();
  private readonly runningJobs = new Set<string>();

  /** sidecar 启动时恢复所有启用中的任务调度。 */
  async init() {
    const activeJobs = await prisma.cronJob.findMany({ where: { isActive: true } });
    for (const job of activeJobs) this.startJob(job);
    if (activeJobs.length > 0) {
      console.log(`[cron] restored ${activeJobs.length} active job(s)`);
    }
  }

  private startJob(job: { id: string; cron: string; name: string }) {
    this.stopJob(job.id);
    try {
      const scheduled = new Cron(job.cron, async () => {
        await this.executeCron(job.id, "schedule");
      });
      this.scheduledJobs.set(job.id, scheduled);
    } catch (error) {
      console.error(`[cron] failed to schedule "${job.name}": ${truncateError(error)}`);
    }
  }

  private stopJob(id: string) {
    this.scheduledJobs.get(id)?.stop();
    this.scheduledJobs.delete(id);
  }

  isRunning(id: string) {
    return this.runningJobs.has(id);
  }

  async list() {
    const jobs = await prisma.cronJob.findMany({ orderBy: { createdAt: "asc" } });
    return jobs.map(serializeJob);
  }

  async create(input: CronJobInput) {
    const job = await prisma.cronJob.create({ data: input });
    if (job.isActive) this.startJob(job);
    return serializeJob(job);
  }

  async update(id: string, input: Partial<CronJobInput>) {
    const job = await prisma.cronJob.update({ where: { id }, data: input });
    // 调度总是重建：cron 表达式或开关任何一项变化都需要重注册。
    this.stopJob(id);
    if (job.isActive) this.startJob(job);
    return serializeJob(job);
  }

  async remove(id: string) {
    this.stopJob(id);
    await prisma.cronJob.delete({ where: { id } });
  }

  /** 手动「立即运行」：不等待执行完成，立即返回是否已受理。 */
  async runNow(id: string): Promise<{ started: boolean; alreadyRunning: boolean }> {
    if (this.runningJobs.has(id)) {
      return { started: false, alreadyRunning: true };
    }
    const job = await prisma.cronJob.findUnique({ where: { id } });
    if (!job) throw new Error("定时任务不存在");
    void this.executeCron(id, "manual").catch((error) => {
      console.error(`[cron] runNow failed: ${truncateError(error)}`);
    });
    return { started: true, alreadyRunning: false };
  }

  private async executeCron(id: string, trigger: "schedule" | "manual") {
    const job = await prisma.cronJob.findUnique({ where: { id } });
    if (!job) return;
    if (this.runningJobs.has(id)) {
      console.log(`[cron] skipped (previous run still in progress): ${job.name}`);
      return;
    }
    this.runningJobs.add(id);

    const startedAt = new Date();
    const record: CronRunRecord = { startedAt: startedAt.toISOString(), status: "running", trigger };
    const previousRunAt = job.lastRunAt ?? undefined;
    // 历史在本地维护贯穿整个执行：各阶段的部分更新都基于它，避免读到过期行。
    let history = appendRunHistory(parseRunHistory(job.runHistory), record);

    try {
      await prisma.cronJob.update({
        where: { id },
        data: {
          lastRunAt: startedAt,
          lastRunEndAt: null,
          lastRunStatus: "running",
          lastRunError: null,
          lastRunConversationId: null,
          runHistory: JSON.stringify(history),
        },
      });

      const conversation = await this.resolveConversation(job);
      const conversationId = conversation.id;
      record.conversationId = conversationId;
      history = replaceLastRun(history, record);
      await prisma.cronJob.update({
        where: { id },
        data: {
          lastRunConversationId: conversationId,
          runHistory: JSON.stringify(history),
        },
      });

      const sinceIso = (
        previousRunAt ?? new Date(startedAt.getTime() - 24 * 60 * 60 * 1_000)
      ).toISOString();
      const cronContext = [
        "<cron-context>",
        `cron_id: ${job.id}`,
        `cron_name: ${job.name}`,
        `started_at: ${startedAt.toISOString()}`,
        `previous_run_at: ${previousRunAt?.toISOString() ?? "(none)"}`,
        `ingest_since: ${sinceIso}`,
        "",
        "Notes:",
        "- 本会话由定时任务自动发起，不是用户亲自输入；处理时无需向用户追问确认。",
        "- 这是系统注入的元数据，不要在任何回复中复述或引用本块内容。",
        "- 上一次运行时间见 previous_run_at / ingest_since，增量类工作请以它为界。",
        "</cron-context>",
        "",
      ].join("\n");

      const messages: ChatUIMessage[] = [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: `${cronContext}${job.prompt}` }],
        },
      ];

      const response = await agentRuntime.stream(
        "fast",
        messages,
        { conversationId, projectId: job.projectId ?? undefined },
        undefined,
        job.agentId ?? undefined,
        job.permissionMode as PermissionMode,
      );
      // 客户端分支没人订阅也要排空：tee 的未读分支会无限缓冲，长运行会吃内存。
      void drainResponse(response);

      const outcome = await this.waitForRun(conversationId);
      const endedAt = new Date();
      record.endedAt = endedAt.toISOString();
      record.status = outcome.status;
      record.error = outcome.error;
      history = replaceLastRun(history, record);

      await prisma.cronJob.update({
        where: { id },
        data: {
          lastRunEndAt: endedAt,
          lastRunStatus: outcome.status,
          lastRunError: outcome.error ?? null,
          runHistory: JSON.stringify(history),
        },
      });
      console.log(
        `[cron] ${outcome.status === "success" ? "completed" : "failed"} (${trigger}): ${job.name}`,
      );
    } catch (error) {
      const message = truncateError(error);
      record.endedAt = new Date().toISOString();
      record.status = "failed";
      record.error = message;
      history = replaceLastRun(history, record);
      await prisma.cronJob
        .update({
          where: { id },
          data: {
            lastRunEndAt: new Date(),
            lastRunStatus: "failed",
            lastRunError: message,
            runHistory: JSON.stringify(history),
          },
        })
        .catch(() => undefined);
      console.error(`[cron] failed (${trigger}): ${job.name} — ${message}`);
    } finally {
      this.runningJobs.delete(id);
    }
  }

  /**
   * 会话解析：reuseThread 且上次的会话还存在且空闲时复用（同一任务的多
   * 次执行落在同一会话里，模型能延续上下文）；否则新建标题锁定为任务名
   * 的会话——cron 消息带 <cron-context> 前缀，不锁定的话它会成为会话标题。
   */
  private async resolveConversation(job: {
    reuseThread: boolean;
    lastRunConversationId: string | null;
    name: string;
    projectId: string | null;
  }) {
    if (job.reuseThread && job.lastRunConversationId) {
      const existing = await prisma.conversation.findUnique({
        where: { id: job.lastRunConversationId },
      });
      if (existing && !(await runService.activeRun(existing.id))) {
        return existing;
      }
    }
    return prisma.conversation.create({
      data: {
        id: crypto.randomUUID(),
        title: job.name,
        titleLocked: true,
        projectId: job.projectId,
      },
    });
  }

  /** 轮询会话当前运行直到离开进行中状态；超时按失败兜底。 */
  private async waitForRun(conversationId: string) {
    const deadline = Date.now() + RUN_WATCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = await runService.activeRun(conversationId).catch(() => null);
      if (!run) {
        // 运行刚结束、状态已落库的窗口期；直接取最新一条确认终态。
        const latest = await prisma.threadRun.findFirst({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
        });
        if (!latest || !ACTIVE_RUN_STATUSES.includes(latest.status as never)) {
          return latest?.status === "completed"
            ? { status: "success" as const, error: undefined }
            : {
                status: "failed" as const,
                error: latest?.error ?? `运行状态：${latest?.status ?? "unknown"}`,
              };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
    }
    return { status: "failed" as const, error: "等待运行完成超时" };
  }
}

async function drainResponse(response: Response) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return;
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // 排空失败不影响运行本身（后台泵才是持久化驱动）。
  }
}

/** 行记录 → API 载荷：runHistory 解析为数组、日期转 ISO 字符串。 */
function serializeJob(job: {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  description: string | null;
  projectId: string | null;
  agentId: string | null;
  permissionMode: string;
  isActive: boolean;
  reuseThread: boolean;
  lastRunAt: Date | null;
  lastRunEndAt: Date | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastRunConversationId: string | null;
  runHistory: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...job,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    lastRunEndAt: job.lastRunEndAt?.toISOString() ?? null,
    runHistory: parseRunHistory(job.runHistory),
    isRunning: cronService.isRunning(job.id),
    nextRunAt: job.isActive ? nextRunFor(job.cron) : null,
  };
}

export const cronService = new CronService();
