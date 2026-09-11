import { useEffect, useMemo, useRef, useState } from "react";
import {
  FilePenIcon,
  FilePlus2Icon,
  FolderPlusIcon,
  InfoIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ApprovalAction, ApprovalInfo, RunInfo } from "@/api";
import { cn } from "@/lib/utils";

interface ApprovalDetail {
  lead: string;
  target?: string;
  command?: string;
  note?: string;
  previews?: Array<{ label: string; text: string }>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function describeApproval(approval: ApprovalInfo): ApprovalDetail {
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(approval.input);
    if (parsed && typeof parsed === "object") {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to showing the raw input as the command.
  }

  switch (approval.toolName) {
    case "bash": {
      const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
      return {
        lead: "想要运行命令",
        command: asText(input.command) ?? approval.input,
        note: timeout ? `超时 ${Math.round(timeout / 1000)} 秒` : undefined,
      };
    }
    case "writeFile": {
      const byteCount = typeof input.byteCount === "number" ? input.byteCount : undefined;
      const preview = asText(input.contentPreview);
      return {
        lead: "想要写入文件",
        target: asText(input.filePath),
        note: byteCount !== undefined ? formatBytes(byteCount) : undefined,
        previews: preview ? [{ label: "内容预览", text: preview }] : undefined,
      };
    }
    case "editFile": {
      const expected = typeof input.expectedReplacements === "number" ? input.expectedReplacements : undefined;
      const previews = [
        { label: "原内容", text: asText(input.oldStringPreview) },
        { label: "新内容", text: asText(input.newStringPreview) },
      ].filter((entry): entry is { label: string; text: string } => Boolean(entry.text));
      return {
        lead: "想要编辑文件",
        target: asText(input.filePath),
        note: expected !== undefined && expected > 1 ? `${expected} 处替换` : undefined,
        previews: previews.length > 0 ? previews : undefined,
      };
    }
    case "mkdir":
      return { lead: "想要创建目录", target: asText(input.dirPath) };
    default:
      return { lead: "想要执行操作", command: approval.input };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ToolIcon({ toolName }: { toolName: string }) {
  switch (toolName) {
    case "bash":
      return <TerminalIcon className="size-3.5 shrink-0" />;
    case "writeFile":
      return <FilePlus2Icon className="size-3.5 shrink-0" />;
    case "editFile":
      return <FilePenIcon className="size-3.5 shrink-0" />;
    case "mkdir":
      return <FolderPlusIcon className="size-3.5 shrink-0" />;
    default:
      return <WrenchIcon className="size-3.5 shrink-0" />;
  }
}

export interface ApprovalPromptProps {
  run: RunInfo;
  approval: ApprovalInfo;
  /** 待确认项中排在这条之后的数量 */
  remainingCount: number;
  onDecision: (action: ApprovalAction) => void;
}

export function ApprovalPrompt({ run, approval, remainingCount, onDecision }: ApprovalPromptProps) {
  const detail = useMemo(() => describeApproval(approval), [approval]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const options: Array<{ action: ApprovalAction; label: string; hint: string }> = [
    { action: "approve", label: "允许", hint: "仅允许这一次" },
    approval.toolName === "bash"
      ? {
          action: "approve_command_always",
          label: "始终允许此类命令",
          hint: run.projectId
            ? "按命令开头建本项目放行规则"
            : "按命令开头建全局放行规则",
        }
      : {
          action: "approve_always",
          label: "始终允许",
          hint: run.projectId ? "本项目后续相同操作不再询问" : "本次任务后续相同操作不再询问",
        },
    { action: "reject", label: "拒绝", hint: "这次先拒绝" },
  ];

  useEffect(() => {
    setSelectedIndex(0);
    listRef.current?.focus();
  }, [approval.id]);

  const confirm = (index: number) => onDecision(options[index].action);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) => (current + delta + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      confirm(selectedIndex);
      return;
    }
    const numeric = Number.parseInt(event.key, 10);
    if (numeric >= 1 && numeric <= options.length) {
      event.preventDefault();
      confirm(numeric - 1);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 px-4 pt-3 text-sm font-medium">
        <ShieldAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>需要权限</span>
        {remainingCount > 0 ? (
          <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
            还有 {remainingCount} 项待确认
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 pt-2 text-sm text-muted-foreground">
        <span>等待确认</span>
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <ToolIcon toolName={approval.toolName} />
          {approval.toolName}
        </span>
        <span>{detail.lead}</span>
        {detail.note ? <span className="text-xs">（{detail.note}）</span> : null}
      </div>

      {detail.command ? (
        <pre className="mx-4 mt-2 max-h-32 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
          {detail.command}
        </pre>
      ) : null}
      {detail.target ? (
        <div className="mx-4 mt-2 rounded-md bg-muted/60 px-3 py-2 font-mono text-xs break-all">
          {detail.target}
        </div>
      ) : null}
      {detail.previews?.length ? (
        <details className="mx-4 mt-2 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            查看内容预览
          </summary>
          {detail.previews.map((preview) => (
            <div key={preview.label} className="mt-1.5">
              <div className="mb-1 text-muted-foreground">{preview.label}</div>
              <pre className="max-h-28 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono leading-relaxed whitespace-pre-wrap break-all">
                {preview.text}
              </pre>
            </div>
          ))}
        </details>
      ) : null}

      <div
        ref={listRef}
        role="listbox"
        aria-label="权限选项"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="mt-2 p-1.5 outline-none"
      >
        {options.map((option, index) => (
          <button
            key={option.action}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onClick={() => confirm(index)}
            onMouseEnter={() => setSelectedIndex(index)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              index === selectedIndex ? "bg-accent text-accent-foreground" : "text-foreground",
            )}
          >
            <span className="w-3 shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
            <span className="shrink-0 font-medium">{option.label}</span>
            <span className="min-w-0 truncate text-muted-foreground">{option.hint}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 border-t px-3.5 py-1.5 text-xs text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0" />
        <span>使用 ↑ ↓ 或数字键选择，回车确认</span>
      </div>
    </div>
  );
}
