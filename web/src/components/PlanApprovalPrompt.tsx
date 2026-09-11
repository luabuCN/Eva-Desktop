import { useState } from "react";
import { ClipboardCheckIcon, InfoIcon } from "lucide-react";
import type { PlanApprovalInfo, PlanApprovalAction } from "@/api";
import { MessageResponse } from "@/components/ai-elements/message";

export interface PlanApprovalPromptProps {
  plan: PlanApprovalInfo;
  onSubmit: (action: PlanApprovalAction, feedback?: string) => void;
}

/** ExitPlanMode 工具的计划审批卡：markdown 计划 + 三种裁决。
 * 批准（自动编辑）/ 批准并完全访问 / 驳回（可附反馈，模型修订后重新呈交）。 */
export function PlanApprovalPrompt({ plan, onSubmit }: PlanApprovalPromptProps) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = (action: PlanApprovalAction, text?: string) => {
    if (submitting) return;
    setSubmitting(true);
    onSubmit(action, text);
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 px-4 py-3 text-sm font-medium">
        <ClipboardCheckIcon className="size-4 shrink-0 text-primary" />
        <span>计划待审批</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
          批准后本回合继续执行
        </span>
      </div>

      <div className="max-h-80 overflow-y-auto border-y px-4 py-3 text-sm">
        <MessageResponse mode="static">{plan.plan}</MessageResponse>
      </div>

      {rejecting ? (
        <div className="px-4 pt-3">
          <textarea
            className="max-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="告诉模型哪里需要改…（可留空）"
            autoFocus
            rows={2}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            disabled={submitting}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3 pt-2">
        {rejecting ? (
          <>
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={submitting}
              onClick={() => setRejecting(false)}
            >
              返回
            </button>
            <button
              type="button"
              className="rounded-lg border border-destructive/50 px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              disabled={submitting}
              onClick={() => submit("reject", feedback.trim() || undefined)}
            >
              驳回计划
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={submitting}
              onClick={() => setRejecting(true)}
            >
              驳回…
            </button>
            <button
              type="button"
              className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
              disabled={submitting}
              onClick={() => submit("approve_full")}
            >
              批准 · 完全访问
            </button>
            <button
              type="button"
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              disabled={submitting}
              onClick={() => submit("approve")}
            >
              批准并开始
            </button>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t px-3.5 py-1.5 text-xs text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0" />
        <span>
          「批准并开始」按自动编辑模式继续（命令仍需确认）；「完全访问」本回合不再询问
        </span>
      </div>
    </div>
  );
}
