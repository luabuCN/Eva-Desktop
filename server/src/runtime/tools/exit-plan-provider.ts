import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RuntimeTool } from "./types.js";

const MAX_PLAN_CHARS = 20_000;

const TOOL_DESCRIPTION =
  "Present your plan and request approval to start implementing. Call it once " +
  "your research is complete: read the relevant files, verified the facts the " +
  "plan relies on, and resolved open questions (use askUser when a decision " +
  "genuinely belongs to the user). The plan is concise markdown: the goal, " +
  "concrete ordered steps, files you will create or edit, commands you will " +
  "run, and how you will verify the result. While the user decides, the run " +
  "pauses. On approval the run switches to the chosen permission mode and you " +
  "continue in the same turn; on rejection you receive feedback — revise the " +
  "plan and present it again, or answer the user's concerns directly.";

const PLAN_REFUSAL_HINT =
  "Plan mode is active: every tool that modifies files, runs commands, or " +
  "mutates state is blocked until the user approves a plan. Finish your " +
  "research with the read-only tools, then present the plan with ExitPlanMode.";

/**
 * Plan 模式的出口（Claude Code 的 ExitPlanMode / aime-chat 的 CreatePlan
 * 悬挂审批同型实现）：落一行 PlanApprovalPrompt pending 记录并轮询，客
 * 户端裁决后返回结果；获批时把整个运行（含已派生的委派上下文）升级到
 * 用户选定的权限模式并放开门控。
 */
export class ExitPlanModeToolProvider implements ToolProvider {
  readonly id = "exit-plan";
  readonly label = "计划工具";

  listTools(): ToolDescriptor[] {
    return [
      {
        name: "ExitPlanMode",
        label: "Exit plan mode",
        description:
          "Present the plan and request user approval to start implementing.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    if (run.subAgent || run.permissionMode !== "plan" || !run.planApprovals) {
      return {};
    }
    const exitPlanMode: RuntimeTool = createTool({
      id: "ExitPlanMode",
      description: TOOL_DESCRIPTION,
      inputSchema: z.object({
        plan: z.string().min(1).max(MAX_PLAN_CHARS),
      }),
      execute: async ({ plan }) => {
        const decision = await run.planApprovals!.request(
          plan.length > MAX_PLAN_CHARS ? plan.slice(0, MAX_PLAN_CHARS) : plan,
        );
        if (!decision) {
          return {
            approved: false,
            feedback: "The run was stopped before the user decided on the plan.",
            hint: PLAN_REFUSAL_HINT,
          };
        }
        if (decision.action === "reject") {
          return {
            approved: false,
            feedback:
              decision.feedback?.trim() ||
              "The user rejected the plan without feedback. Rethink the approach and present a revised plan with ExitPlanMode.",
            hint: PLAN_REFUSAL_HINT,
          };
        }
        const mode = decision.action === "approve_full" ? "full" : "auto_edit";
        run.escalateFromPlan?.(mode);
        if (run.planGate) {
          run.planGate.approved = true;
          run.planGate.escalatedMode = mode;
        }
        return {
          approved: true,
          permissionMode: mode,
          note:
            mode === "full"
              ? "The user approved the plan with full access. Proceed to implement it now, in this turn."
              : "The user approved the plan. Proceed to implement it now, in this turn. File edits run without further prompts; commands still follow the approval policy.",
        };
      },
    });
    return { ExitPlanMode: exitPlanMode };
  }
}
