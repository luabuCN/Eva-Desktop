import { UNKNOWN_TOOL_POLICY } from "./policies.js";
import type {
  ApprovalBridge,
  AskUserBridge,
  BackgroundTaskBridge,
  DelegationBridge,
  PermissionMode,
  PlanApprovalBridge,
  PlanGate,
  ToolPermissionMap,
  ToolPolicy,
} from "./types.js";

/** 面板预览通知：工具执行后希望在内置浏览器中打开的地址。 */
export interface PreviewNotification {
  url: string;
  kind: "file" | "server";
  label?: string;
}

export interface RunContextInit {
  conversationId: string;
  runId?: string;
  projectId?: string;
  /** Filesystem root every workspace tool resolves paths against. */
  workspacePath: string;
  agentId?: string;
  permissionMode: PermissionMode;
  readOnly: boolean;
  /** Raw project grants, kept so sub-agent contexts can re-resolve policies. */
  permissionOverrides: ToolPermissionMap;
  disabledTools: ReadonlySet<string>;
  /** Resolved policies for this run; computed via ToolProviderRegistry.policiesFor. */
  toolPolicies: ToolPermissionMap;
  approvals?: ApprovalBridge;
  /** askUser 工具的交互桥；子智能体上下文不带（派生时置空），避免后台任务阻塞在用户输入上。 */
  askUser?: AskUserBridge;
  /** ExitPlanMode 工具的裁决桥；仅 plan 模式的主智能体上下文携带。 */
  planApprovals?: PlanApprovalBridge;
  /** plan 模式门控：整个运行（含委派）共享，ExitPlanMode 获批后放开。 */
  planGate?: PlanGate;
  /** 计划获批后把整个运行的工具策略重解析为升级后的权限模式。 */
  escalateFromPlan?: (mode: PermissionMode) => void;
  /** Delegate 工具的委派桥；子智能体上下文不带，委派不能再生委派。 */
  delegate?: DelegationBridge;
  /** bash(runInBackground=true) 的后台任务桥；注册表跨回合存活，子智能体
   * 上下文经派生展开继承（子代理也能查询/等待后台任务）。 */
  backgroundTasks?: BackgroundTaskBridge;
  signal?: AbortSignal;
  /** True for derived sub-agent contexts (no per-conversation task tools). */
  subAgent?: boolean;
  /** 向当前聊天流推送 data-oh:preview.open 数据部件。由 agent-runtime 在
   * 流式执行回调里注入；工具用它请求前端在内置浏览器面板中打开预览。 */
  notifyPreview?: (data: PreviewNotification) => void;
}

/**
 * Per-run state bag handed to every tool provider (aime-chat's RequestContext
 * equivalent). One object per run; sub-agents derive their own copy with a
 * different readOnly posture through ToolProviderRegistry.deriveContext.
 */
export interface RunContext extends RunContextInit {
  policyFor(name: string): ToolPolicy;
}

export function createRunContext(init: RunContextInit): RunContext {
  return {
    ...init,
    policyFor: (name) => init.toolPolicies[name] ?? UNKNOWN_TOOL_POLICY,
  };
}
