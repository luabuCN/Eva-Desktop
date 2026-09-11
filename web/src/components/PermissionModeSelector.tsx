import {
  CheckIcon,
  CircleAlertIcon,
  HandIcon,
  ListTodoIcon,
  SquarePenIcon,
  type LucideIcon,
} from "lucide-react";
import { type PermissionMode } from "@/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";

const MODES: Record<
  PermissionMode,
  { label: string; hint: string; icon: LucideIcon }
> = {
  plan: {
    label: "计划模式",
    hint: "先调研出计划，批准后再动手",
    icon: ListTodoIcon,
  },
  confirm: { label: "变更前确认", hint: "改动前先问我", icon: HandIcon },
  auto_edit: {
    label: "自动编辑",
    hint: "自动编辑文件，命令仍需确认",
    icon: SquarePenIcon,
  },
  full: { label: "完全访问", hint: "自动执行，不再询问", icon: CircleAlertIcon },
};

const MODE_ORDER: PermissionMode[] = ["plan", "confirm", "auto_edit", "full"];

export interface PermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

export function PermissionModeSelector({
  value,
  onChange,
  disabled,
}: PermissionModeSelectorProps) {
  const current = MODES[value];
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          disabled={disabled}
          tooltip="权限模式：决定哪些操作需要确认"
          variant={value === "auto_edit" || value === "plan" ? "secondary" : "ghost"}
          className={cn(value === "full" && "text-primary hover:text-primary")}
        >
          <CurrentIcon className="size-4" />
          <span>{current.label}</span>
        </PromptInputButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {MODE_ORDER.map((mode) => {
          const entry = MODES[mode];
          const Icon = entry.icon;
          return (
            <DropdownMenuItem
              key={mode}
              onSelect={() => onChange(mode)}
              className={cn(
                "gap-2.5",
                mode === value && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{entry.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {entry.hint}
                </span>
              </span>
              {mode === value ? (
                <CheckIcon className="ml-auto size-4 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
