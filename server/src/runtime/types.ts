export const THINKING_MODES = ["fast", "deep"] as const;

export type ThinkingMode = (typeof THINKING_MODES)[number];

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === "string" && THINKING_MODES.includes(value as ThinkingMode);
}

/** 推理等级：off 关闭思考，low/medium/high 映射到请求体的 reasoning_effort。 */
export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/** 兼容旧客户端：推理等级反推旧的思考模式（off=fast，其余=deep）。 */
export function thinkingModeForEffort(effort: ReasoningEffort): ThinkingMode {
  return effort === "off" ? "fast" : "deep";
}

export const PERMISSION_MODES = ["plan", "confirm", "auto_edit", "full"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode);
}

export interface AgentProfile {
  id: ThinkingMode;
  label: string;
  enableThinking: boolean;
}

export const agentProfiles: Record<ThinkingMode, AgentProfile> = {
  fast: {
    id: "fast",
    label: "Speed thinking",
    enableThinking: false,
  },
  deep: {
    id: "deep",
    label: "Deep thinking",
    enableThinking: true,
  },
};
