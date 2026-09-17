import { spawn } from "node:child_process";
import { shellInvocation } from "../safe-fs.js";
import type { BackgroundTaskBridge, BackgroundTaskRecord } from "./tools/index.js";

/** Live notice streamed to the chat as a data-oh:bgtask.* part. */
export type BackgroundTaskNotice =
  | { kind: "start"; taskId: string; command: string }
  | { kind: "progress"; taskId: string; command: string; tail: string }
  | {
      kind: "done";
      taskId: string;
      command: string;
      status: "completed" | "failed" | "stopped";
      exitCode?: number;
      durationMs: number;
    }
  | { kind: "error"; taskId: string; command: string; error: string };

/**
 * bash(runInBackground=true) 的后端：命令转后台进程，工具立即返回 taskId，
 * 主循环不等它结束（依赖安装/构建类长命令因此不再阻塞整个回合）。
 *
 * 与 DelegationHub 同构但跨回合：注册表是模块级的，回合结束只解绑通知流，
 * 进程继续跑完，下一回合可用 bashTaskOutput 查到最终结果（用户已确认该
 * 语义，与 dev-server 后台存活一致）。
 *
 * 进程不 detached：child 由常驻服务进程持有引用，exit 事件直接可收、
 * 输出直接 pipe 进尾部缓冲，不需要 dev-server 那套日志文件轮询。
 */

const MAX_CONCURRENT_RUNNING = 5;
const MAX_RETAINED_TASKS = 50;
const MAX_LIFETIME_MS = 30 * 60_000;
const PROGRESS_THROTTLE_MS = 2_000;
const WAIT_KEEPALIVE_MS = 5_000;
/** 尾部环形缓冲上限：安装日志动辄几十 MB，只留尾部防内存膨胀。 */
const TAIL_CHARS = 64_000;
/** 回给模型的输出上限（与 dev-server 的 stdout/stderr 截断一致）。 */
const RESULT_STDOUT_CHARS = 8_000;
const RESULT_STDERR_CHARS = 4_000;

interface MutableRecord extends BackgroundTaskRecord {
  child: ReturnType<typeof spawn>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  /** 后台强杀标记：close 事件据此区分 stopped 与 completed。 */
  stopRequested: boolean;
  lifetimeTimer: NodeJS.Timeout;
  lastProgressAt: number;
}

function keepTail(current: string, chunk: string): string {
  const merged = current + chunk;
  return merged.length <= TAIL_CHARS ? merged : merged.slice(-TAIL_CHARS);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(-max)}\n... (showing the last ${max} of ${text.length} chars)`;
}

export class BackgroundTaskHub implements BackgroundTaskBridge {
  /** 模块级注册表：任务跨回合存活，实例（每回合一个）只携带通知流。 */
  private static readonly records = new Map<string, MutableRecord>();

  /** 直播事件出口；由 agent-runtime 在 UI 流 writer 就绪后注入，回合
   * 结束时置空（此后的完成事件静默丢弃，结果仍可经工具查询）。 */
  notify?: (notice: BackgroundTaskNotice) => void;

  private emit(notice: BackgroundTaskNotice): void {
    try {
      this.notify?.(notice);
    } catch {
      // 进程在回合结束后完成时写入已关闭的 writer；推送失败不影响任务。
    }
  }

  async start(input: {
    command: string;
    cwd: string;
    conversationId: string;
  }): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
    const command = input.command.trim();
    if (!command) return { ok: false, error: "Background task needs a non-empty command." };
    const running = [...BackgroundTaskHub.records.values()].filter(
      (record) => record.status === "running",
    );
    if (running.length >= MAX_CONCURRENT_RUNNING) {
      return {
        ok: false,
        error: `${MAX_CONCURRENT_RUNNING} background tasks are already running. Check them with bashTaskOutput or stop some with bashTaskStop first.`,
      };
    }

    const taskId = crypto.randomUUID();
    const shell = shellInvocation(command);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.executable, shell.args, {
        cwd: input.cwd,
        windowsHide: true,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to launch the background command: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: MutableRecord = {
      taskId,
      conversationId: input.conversationId,
      command,
      status: "running",
      startedAt: Date.now(),
      stdoutTail: "",
      stderrTail: "",
      child,
      completion,
      resolveCompletion,
      stopRequested: false,
      // 30 分钟硬上限：防泄漏的兜底，正常安装/构建远用不到。
      lifetimeTimer: setTimeout(() => {
        if (record.status === "running") {
          record.error = `Exceeded the ${Math.round(MAX_LIFETIME_MS / 60_000)}-minute lifetime limit and was killed.`;
          this.kill(record);
        }
      }, MAX_LIFETIME_MS),
      lastProgressAt: 0,
    };
    BackgroundTaskHub.records.set(taskId, record);

    child.stdout?.on("data", (chunk: Buffer) => {
      record.stdoutTail = keepTail(record.stdoutTail, chunk.toString("utf8"));
      this.maybeProgress(record);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      record.stderrTail = keepTail(record.stderrTail, chunk.toString("utf8"));
      this.maybeProgress(record);
    });
    // spawn 失败（可执行不存在、cwd 无效）以 error 事件异步到达。
    child.on("error", (error) => {
      this.settle(record, "failed", undefined, error.message);
    });
    child.on("close", (exitCode) => {
      if (record.stopRequested) {
        this.settle(record, "stopped", exitCode ?? undefined);
      } else if (exitCode === 0) {
        this.settle(record, "completed", 0);
      } else {
        this.settle(record, "failed", exitCode ?? undefined, `exit code ${exitCode ?? "unknown"}`);
      }
    });

    this.emit({ kind: "start", taskId, command: command.slice(0, 200) });
    return { ok: true, taskId };
  }

  /** 输出有增量时节流推送 progress（前端卡片实时滚动的来源）。 */
  private maybeProgress(record: MutableRecord): void {
    if (record.status !== "running") return;
    const now = Date.now();
    if (now - record.lastProgressAt < PROGRESS_THROTTLE_MS) return;
    record.lastProgressAt = now;
    this.emit({
      kind: "progress",
      taskId: record.taskId,
      command: record.command.slice(0, 200),
      tail: (record.stdoutTail + record.stderrTail).slice(-600),
    });
  }

  private settle(
    record: MutableRecord,
    status: BackgroundTaskRecord["status"],
    exitCode?: number,
    error?: string,
  ): void {
    if (record.status !== "running") return;
    record.status = status;
    record.exitCode = exitCode;
    record.completedAt = Date.now();
    record.error = error?.slice(0, 500);
    clearTimeout(record.lifetimeTimer);
    record.resolveCompletion();
    const durationMs = record.completedAt - record.startedAt;
    if (status === "failed" && error && exitCode === undefined) {
      // spawn 层面的失败（起不来）：error 事件而不是退出码。
      this.emit({ kind: "error", taskId: record.taskId, command: record.command.slice(0, 200), error: record.error ?? "unknown error" });
      return;
    }
    this.emit({
      kind: "done",
      taskId: record.taskId,
      command: record.command.slice(0, 200),
      status: status === "running" ? "failed" : status,
      exitCode: record.exitCode,
      durationMs,
    });
    this.prune();
  }

  /** 杀整棵进程树：Windows 上 kill() 只杀直接子进程，pnpm→node 的后代
   * 要用 taskkill /T 才停得干净。 */
  private kill(record: MutableRecord): void {
    record.stopRequested = true;
    if (process.platform === "win32" && record.child.pid) {
      try {
        spawn("taskkill", ["/pid", String(record.child.pid), "/T", "/F"], { windowsHide: true });
        return;
      } catch {
        // taskkill 不可用则退回 kill()
      }
    }
    try {
      record.child.kill();
    } catch {
      // 进程已退出时 kill() 抛错可忽略，close 事件已处理收尾。
    }
  }

  private prune(): void {
    const finished = [...BackgroundTaskHub.records.values()]
      .filter((record) => record.status !== "running")
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const excess = finished.length - MAX_RETAINED_TASKS;
    for (const record of finished.slice(0, Math.max(0, excess))) {
      BackgroundTaskHub.records.delete(record.taskId);
    }
  }

  private snapshot(record: MutableRecord): BackgroundTaskRecord {
    return {
      taskId: record.taskId,
      conversationId: record.conversationId,
      command: record.command,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      stdoutTail: record.stdoutTail,
      stderrTail: record.stderrTail,
      error: record.error,
    };
  }

  private resolveRecord(
    taskId: string | undefined,
    conversationId: string,
  ): MutableRecord | undefined {
    if (taskId) return BackgroundTaskHub.records.get(taskId);
    // 缺省取该会话最近启动的一个任务（最常见：刚启动的安装）。
    const candidates = this.list(conversationId);
    return candidates.length ? BackgroundTaskHub.records.get(candidates.at(-1)!.taskId) : undefined;
  }

  async output(input: {
    taskId?: string;
    conversationId: string;
    block?: boolean;
    timeoutSeconds?: number;
  }): Promise<
    | { ok: true; task: BackgroundTaskRecord; durationMs: number; note?: string }
    | { ok: false; error: string }
  > {
    const record = this.resolveRecord(input.taskId, input.conversationId);
    if (!record) {
      return {
        ok: false,
        error: input.taskId
          ? `No background task with id ${input.taskId}. Call bashTaskList to see them.`
          : "No background tasks have been started in this conversation. Start one with bash(runInBackground=true).",
      };
    }

    let timedOut = false;
    if (input.block && record.status === "running") {
      const timeoutMs = Math.min(Math.max((input.timeoutSeconds ?? 60) * 1000, 1_000), 600_000);
      timedOut = await this.waitFor(record, timeoutMs);
    }

    const snapshot = this.snapshot(record);
    const durationMs = (snapshot.completedAt ?? Date.now()) - snapshot.startedAt;
    const note =
      snapshot.status === "running" && timedOut
        ? `Still running after ${input.timeoutSeconds ?? 60}s — this is not a failure. Call bashTaskOutput again with block=true to keep waiting, or bashTaskList to see all tasks.`
        : snapshot.status === "running"
          ? "Still running. Call bashTaskOutput with block=true to wait for completion."
          : undefined;
    return {
      ok: true,
      task: {
        ...snapshot,
        stdoutTail: truncate(snapshot.stdoutTail.trim(), RESULT_STDOUT_CHARS),
        stderrTail: truncate(snapshot.stderrTail.trim(), RESULT_STDERR_CHARS),
      },
      durationMs,
      note,
    };
  }

  /** 阻塞等待完成；期间周期性推 progress 保活（空闲看门狗默认 240s，别让
   * 长安装把回合误杀），也让前端卡片在等待中持续滚动输出。 */
  private waitFor(record: MutableRecord, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (timedOut: boolean) => {
        if (done) return;
        done = true;
        clearInterval(keepalive);
        clearTimeout(timer);
        resolve(timedOut);
      };
      void record.completion.then(() => finish(false));
      const keepalive = setInterval(() => {
        if (record.status === "running") this.maybeProgress(record);
        if (record.status !== "running") finish(false);
      }, WAIT_KEEPALIVE_MS);
      const timer = setTimeout(() => finish(true), timeoutMs);
    });
  }

  list(conversationId: string): BackgroundTaskRecord[] {
    return [...BackgroundTaskHub.records.values()]
      .filter((record) => record.conversationId === conversationId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((record) => this.snapshot(record));
  }

  stop(taskIds?: string[], conversationId?: string): number {
    const targets = [...BackgroundTaskHub.records.values()].filter(
      (record) =>
        record.status === "running" &&
        (taskIds?.length ? taskIds.includes(record.taskId) : !conversationId || record.conversationId === conversationId),
    );
    for (const record of targets) this.kill(record);
    return targets.length;
  }
}
