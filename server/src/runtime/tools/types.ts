import type { ToolAction } from "@mastra/core/tools";
import type { PermissionMode } from "../types.js";

export type RuntimeTool = ToolAction<any, any, any, any, any>;

export type ToolRisk = "low" | "medium" | "high";

export interface ToolPolicy {
  enabled: boolean;
  requireApproval: boolean;
}

/** Tool name → policy. Deliberately open-ended: providers that appear at
 * runtime (MCP servers, knowledge bases) contribute names outside the static
 * descriptor list, and stale project grants must survive provider restarts. */
export type ToolPermissionMap = Record<string, ToolPolicy>;

export type ApprovalDecision =
  | { kind: "approved"; approvalId?: string }
  | { kind: "rejected"; reason?: string }
  | { kind: "timeout" }
  | { kind: "aborted" };

export interface ApprovalBridge {
  request(toolName: string, input: string): Promise<ApprovalDecision>;
}

/** One multiple-choice question the model wants the user to answer. */
export interface AskUserQuestion {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

/**
 * Bridge that pauses the askUser tool until the user answers through the
 * run's pending ask prompt. `null` entries mean the user skipped/declined
 * that question.
 */
export interface AskUserBridge {
  ask(questions: AskUserQuestion[]): Promise<Array<string[] | null>>;
}

/** ExitPlanMode 的用户裁决：approve → auto_edit，approve_full → full。 */
export type PlanDecision =
  | { action: "approve" }
  | { action: "approve_full" }
  | { action: "reject"; feedback?: string };

/**
 * Bridge that pauses the ExitPlanMode tool until the user decides on the
 * plan through the run's pending plan prompt. Null means the run was
 * stopped (treated as a rejection without feedback).
 */
export interface PlanApprovalBridge {
  request(plan: string): Promise<PlanDecision | null>;
}

/**
 * Plan 模式的执行期门控：主智能体与所有委派子智能体共享同一个对象，
 * ExitPlanMode 获批后置 approved，门控即刻对整个运行放开。
 */
export interface PlanGate {
  approved: boolean;
  escalatedMode?: PermissionMode;
}

/** One background delegation started by the Delegate tool. */
export interface DelegationRecord {
  delegationId: string;
  agentName: string;
  status: "running" | "completed" | "failed" | "aborted" | "stopped";
  startedAt: number;
  completedAt?: number;
  report: string;
  steps?: number;
  turns?: number;
  error?: string;
}

/**
 * Bridge injected by agent-runtime: the Delegate* tools marshal arguments,
 * the hub (which owns models and the run's abort signal) does the spawning.
 */
export interface DelegationBridge {
  start(agent: string, task: string, description?: string): Promise<
    | { ok: true; delegationId: string }
    | { ok: false; error: string }
  >;
  wait(input: {
    delegationIds?: string[];
    mode?: "all" | "any";
    minCompleted?: number;
    timeoutSeconds?: number;
  }): Promise<{ delegations: DelegationRecord[]; note?: string; unknownIds?: string[] }>;
  list(): DelegationRecord[];
  stop(delegationIds?: string[]): number;
  catalog(): Array<{ name: string; description: string; tools: string[] }>;
}

export type { PermissionMode };

/** One background shell task started by bash(runInBackground=true). */
export interface BackgroundTaskRecord {
  taskId: string;
  conversationId: string;
  command: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** 进程退出码；spawn 失败/超时强杀时缺省。 */
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  stdoutTail: string;
  stderrTail: string;
  error?: string;
}

/**
 * Bridge injected by agent-runtime: the bashTask* tools marshal arguments,
 * the hub (which owns the process registry) does the spawning. 任务跨回合
 * 存活（注册表模块级），回合结束只解绑通知流，进程继续跑完。
 */
export interface BackgroundTaskBridge {
  start(input: {
    command: string;
    cwd: string;
    conversationId: string;
  }): Promise<{ ok: true; taskId: string } | { ok: false; error: string }>;
  output(input: {
    taskId?: string;
    conversationId: string;
    block?: boolean;
    timeoutSeconds?: number;
  }): Promise<
    | { ok: true; task: BackgroundTaskRecord; durationMs: number; note?: string }
    | { ok: false; error: string }
  >;
  list(conversationId: string): BackgroundTaskRecord[];
  stop(taskIds?: string[], conversationId?: string): number;
}
