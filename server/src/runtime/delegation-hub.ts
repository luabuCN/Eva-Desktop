import { Agent } from "@mastra/core/agent";
import { toAISdkStream } from "@mastra/ai-sdk";
import type { ModelSelection } from "../providers/provider-service.js";
import type { ReasoningEffort, ThinkingMode } from "./types.js";
import { createModel } from "./model.js";
import type { SubAgentDefinitionInfo } from "./subagents.js";
import { toolProviderRegistry, type RunContext } from "./tools/index.js";
import type { DelegationBridge, DelegationRecord } from "./tools/index.js";

/** Live notice streamed to the chat as a data-oh:subagent.* part. */
export type DelegationNotice =
  | { kind: "start"; delegationId: string; agentName: string; task: string }
  | {
      kind: "progress";
      delegationId: string;
      agentName: string;
      steps: number;
      currentTool?: string;
    }
  | {
      kind: "done";
      delegationId: string;
      agentName: string;
      status: "completed" | "aborted" | "stopped";
      durationMs: number;
      steps: number;
    }
  | { kind: "error"; delegationId: string; agentName: string; error: string };

/**
 * Per-run delegation hub (PI-Desktop ADR 0089): Delegate starts a subagent in
 * the background and returns immediately; DelegateWait converges later. The
 * hub owns the delegation registry, the spawn path (models + derived tool
 * sets) and the abort wiring; the Delegate* tools only marshal arguments.
 *
 * Two boundaries, same as PI:
 * - Only the delegate's final report re-enters the main context, capped.
 * - A delegate's termination never ends the parent turn: every outcome
 *   settles into its record, and run abort stops every running delegate.
 */

const MAX_CONCURRENT_DELEGATIONS = 10;
const MAX_RETAINED_DELEGATIONS = 100;
const MAX_REPORT_CHARS = 12_000;
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 900;
const MAX_WAIT_RESULT_CHARS = 50_000;

/** Workspace tools that make a delegate write-capable. */
const MUTATING_TOOL_NAMES = new Set(["bash", "writeFile", "editFile", "mkdir"]);

type MutableRecord = DelegationRecord & {
  steps: number;
  completion: Promise<void>;
  resolveCompletion: () => void;
  abort: () => void;
  stopRequested: boolean;
};

function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_REPORT_CHARS) return text;
  const marker = "\n\n[delegate report truncated]\n\n";
  const available = MAX_REPORT_CHARS - marker.length;
  return `${text.slice(0, Math.ceil(available / 2))}${marker}${text.slice(-Math.floor(available / 2))}`;
}

function composeDelegatePrompt(definition: SubAgentDefinitionInfo, workspacePath: string): string {
  const toolList = definition.tools.join(", ") || "none";
  const canMutate = definition.tools.some((name) => MUTATING_TOOL_NAMES.has(name));
  const framing = [
    `You are the "${definition.name}" subagent working on one task delegated by the main agent.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    canMutate
      ? "You may change files, but only the ones the task is about; leave everything else untouched."
      : "You have no tools that change files or run mutating commands, so never report an edit you could not have made.",
    "Your final message is the only thing the main agent receives — nothing else you write reaches it. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration.",
    `The workspace root is ${workspacePath}; resolve relative paths against it.`,
  ].join("\n");
  return [framing, definition.prompt].join("\n\n");
}

export class DelegationHub implements DelegationBridge {
  private readonly records = new Map<string, MutableRecord>();

  /** 直播事件出口；由 agent-runtime 在 UI 流 writer 就绪后注入。 */
  notify?: (notice: DelegationNotice) => void;

  constructor(
    private readonly options: {
      definitions: SubAgentDefinitionInfo[];
      workspacePath: string;
      runContext: RunContext;
      mode: ThinkingMode;
      effort?: ReasoningEffort;
      sessionSelection?: ModelSelection;
      signal?: AbortSignal;
    },
  ) {}

  private emit(notice: DelegationNotice): void {
    try {
      this.notify?.(notice);
    } catch {
      // 进度推送失败不影响委派本身。
    }
  }

  catalog() {
    return this.options.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      tools: definition.tools,
    }));
  }

  async start(
    agentName: string,
    task: string,
    description?: string,
  ): Promise<{ ok: true; delegationId: string } | { ok: false; error: string }> {
    const definition = this.options.definitions.find(
      (entry) => entry.name === agentName,
    );
    if (!definition) {
      const names = this.options.definitions.map((entry) => entry.name).join(", ");
      return {
        ok: false,
        error: `Unknown subagent "${agentName}". Available: ${names || "(none configured)"}.`,
      };
    }
    if (!task) {
      return { ok: false, error: `Delegating to ${definition.name} needs a non-empty task brief.` };
    }
    const running = [...this.records.values()].filter((record) => record.status === "running");
    if (running.length >= MAX_CONCURRENT_DELEGATIONS) {
      return {
        ok: false,
        error: `${MAX_CONCURRENT_DELEGATIONS} subagents are already running. Wait with DelegateWait or stop some with DelegateStop first.`,
      };
    }

    const delegationId = crypto.randomUUID();
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    this.options.signal?.addEventListener("abort", onParentAbort, { once: true });
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: MutableRecord = {
      delegationId,
      agentName: definition.name,
      status: "running",
      startedAt: Date.now(),
      report: "",
      steps: 0,
      completion,
      resolveCompletion,
      abort: () => controller.abort(),
      stopRequested: false,
    };
    this.records.set(delegationId, record);
    this.emit({ kind: "start", delegationId, agentName: definition.name, task: task.slice(0, 500) });
    void description; // shown to the user via the tool-call arguments already

    this.spawn(record, definition, task, controller, onParentAbort)
      .catch((error: unknown) => {
        // spawn() settles its own failures; this guard only keeps an
        // unexpected rejection from stranding the record in "running".
        this.settle(record, "failed", "", error instanceof Error ? error.message : "unknown error");
      })
      .finally(() => {
        this.options.signal?.removeEventListener("abort", onParentAbort);
      });

    return { ok: true, delegationId };
  }

  private async spawn(
    record: MutableRecord,
    definition: SubAgentDefinitionInfo,
    task: string,
    controller: AbortController,
    onParentAbort: () => void,
  ): Promise<void> {
    // Model pin: definition pin > session selection. A pin that fails to
    // resolve is an error, not a silent fallback to the session model.
    let report = "";
    let failed: string | undefined;
    try {
      const selection = definition.providerId && definition.modelId
        ? { providerId: definition.providerId, modelId: definition.modelId }
        : this.options.sessionSelection;
      const model = await createModel(this.options.mode, selection, this.options.effort);

      // The delegate never inherits mutation rights from the parent: a
      // read-only main agent stays read-only through delegation too.
      const canMutate =
        !this.options.runContext.readOnly &&
        definition.tools.some((name) => MUTATING_TOOL_NAMES.has(name));
      const delegateContext = toolProviderRegistry.deriveContext(this.options.runContext, {
        readOnly: !canMutate,
      });
      const availableTools = await toolProviderRegistry.createToolSet(delegateContext);
      const tools = Object.fromEntries(
        definition.tools
          .filter((name) => availableTools[name])
          .map((name) => [name, availableTools[name]]),
      );

      const agent = new Agent({
        id: `delegate-${definition.name}-${record.delegationId}`,
        name: definition.name,
        description: definition.description,
        instructions: composeDelegatePrompt(definition, this.options.workspacePath),
        model,
        tools,
        maxRetries: 2,
        defaultOptions: { maxSteps: definition.maxTurns ?? 80 },
      });

      // 流式消费子智能体循环：把每个内部工具调用变成 data-oh:subagent.progress
      // 事件推给前端（PI 式"已处理 N 个步骤"的实时来源），同时累积最终报告文本。
      const mastraStream = await agent.stream(task, {
        abortSignal: controller.signal,
        maxSteps: definition.maxTurns ?? 80,
      });
      const source = toAISdkStream(mastraStream, { from: "agent", version: "v6" });
      const reader = source.getReader();
      let currentTool: string | undefined;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || typeof value !== "object") continue;
        switch (value.type) {
          case "text-delta":
            if (typeof value.delta === "string") report += value.delta;
            break;
          case "tool-input-available":
            currentTool = typeof value.toolName === "string" ? value.toolName : undefined;
            this.emit({
              kind: "progress",
              delegationId: record.delegationId,
              agentName: record.agentName,
              steps: record.steps,
              currentTool,
            });
            break;
          case "tool-output-available":
          case "tool-output-error":
            record.steps += 1;
            currentTool = undefined;
            this.emit({
              kind: "progress",
              delegationId: record.delegationId,
              agentName: record.agentName,
              steps: record.steps,
            });
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.settle(record, record.stopRequested ? "stopped" : "aborted", "", undefined, onParentAbort);
        return;
      }
      failed = error instanceof Error ? error.message : String(error);
    }
    this.settle(record, failed ? "failed" : "completed", report, failed, onParentAbort);
  }

  private settle(
    record: MutableRecord,
    status: DelegationRecord["status"],
    report: string,
    error?: string,
    _onParentAbort?: () => void,
  ): void {
    if (record.status !== "running") return;
    record.status = status;
    record.completedAt = Date.now();
    record.report = boundedReport(report);
    record.error = error?.slice(0, 500);
    record.resolveCompletion();
    const durationMs = record.completedAt - record.startedAt;
    if (status === "failed") {
      this.emit({
        kind: "error",
        delegationId: record.delegationId,
        agentName: record.agentName,
        error: record.error ?? "unknown error",
      });
    } else {
      this.emit({
        kind: "done",
        delegationId: record.delegationId,
        agentName: record.agentName,
        status: status === "stopped" ? "stopped" : status === "aborted" ? "aborted" : "completed",
        durationMs,
        steps: record.steps,
      });
    }
    this.prune();
  }

  private prune(): void {
    const finished = [...this.records.values()]
      .filter((record) => record.status !== "running")
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    const excess = finished.length - MAX_RETAINED_DELEGATIONS;
    for (const record of finished.slice(0, Math.max(0, excess))) {
      this.records.delete(record.delegationId);
    }
  }

  private snapshot(record: MutableRecord): DelegationRecord {
    return {
      delegationId: record.delegationId,
      agentName: record.agentName,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      report: record.report,
      steps: record.steps,
      error: record.error,
    };
  }

  async wait(input: {
    delegationIds?: string[];
    mode?: "all" | "any";
    minCompleted?: number;
    timeoutSeconds?: number;
  }): Promise<{ delegations: DelegationRecord[]; note?: string; unknownIds?: string[] }> {
    const ids = input.delegationIds ?? [];
    const targets = ids.length
      ? ids.map((id) => this.records.get(id)).filter((record): record is MutableRecord => record !== undefined)
      : this.running();
    const unknownIds = ids.filter((id) => !this.records.has(id));
    if (targets.length === 0) {
      return {
        delegations: [],
        note: ids.length
          ? "None of the requested delegation ids exist in this session. Call DelegateList to see them."
          : "No subagents are currently running.",
        unknownIds,
      };
    }

    const mode = input.mode === "any" ? "any" : "all";
    const targetCompleted =
      mode === "all"
        ? targets.length
        : Math.min(Math.max(input.minCompleted ?? 1, 1), targets.length);
    const timeoutSeconds = Math.min(
      Math.max(input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, 1),
      MAX_WAIT_SECONDS,
    );

    const timedOut = await this.waitFor(targets, targetCompleted, timeoutSeconds * 1000);
    const delegations = targets.map((record) => this.snapshot(record));
    const finished = delegations.filter((record) => record.status !== "running").length;
    const note = timedOut
      ? `Still running after ${timeoutSeconds}s: ${finished}/${targets.length} finished. This is not a failure — the delegates keep working. Call DelegateWait again with the remaining delegationIds, or DelegateList to see progress.`
      : mode === "any"
        ? `Converged after ${finished} of ${targets.length} finished.`
        : undefined;
    return {
      delegations: delegations.map((record) => ({
        ...record,
        // Cap the joined result: the wait result is context just like a report.
        report: record.report.slice(0, MAX_WAIT_RESULT_CHARS),
      })),
      note,
      unknownIds: unknownIds.length ? unknownIds : undefined,
    };
  }

  private waitFor(targets: MutableRecord[], targetCompleted: number, timeoutMs: number): Promise<boolean> {
    const settledCount = () => targets.filter((record) => record.status !== "running").length;
    if (settledCount() >= targetCompleted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (timedOut: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(timedOut);
      };
      const check = () => {
        if (settledCount() >= targetCompleted) finish(false);
      };
      for (const record of targets) {
        if (record.status === "running") void record.completion.then(check);
      }
      const timer = setTimeout(() => finish(true), timeoutMs);
    });
  }

  list(): DelegationRecord[] {
    return [...this.records.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((record) => this.snapshot(record));
  }

  stop(delegationIds?: string[]): number {
    const targets = delegationIds?.length
      ? delegationIds
          .map((id) => this.records.get(id))
          .filter((record): record is MutableRecord => record !== undefined && record.status === "running")
      : this.running();
    for (const record of targets) {
      record.stopRequested = true;
      record.abort();
    }
    return targets.length;
  }

  private running(): MutableRecord[] {
    return [...this.records.values()].filter((record) => record.status === "running");
  }

  /** Run teardown: stop everything still running. */
  dispose(): void {
    for (const record of this.running()) record.abort();
  }
}
