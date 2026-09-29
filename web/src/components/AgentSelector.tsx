import { BotIcon, CheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listAgents, type AgentInfo } from "@/api";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface AgentSelectorProps {
  value?: string;
  onChange: (agentId: string) => void;
  className?: string;
}

export function AgentSelector({ value, onChange, className }: AgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const loadAgents = useCallback(() => {
    setLoading(true);
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === value),
    [agents, value],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) loadAgents();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          title="选择 Agent"
          className={cn(
            "inline-flex h-7 max-w-32 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            className,
          )}
        >
          <BotIcon className="size-3.5 shrink-0" />
          <span className="truncate">{selected?.name ?? "Agent"}</span>
        </button>
      </DialogTrigger>

      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogTitle className="sr-only">选择 Agent</DialogTitle>
        <Command>
          <CommandInput placeholder="搜索 Agent..." />
          <CommandList>
            <CommandEmpty>{loading ? "加载中…" : "未找到 Agent"}</CommandEmpty>
            <CommandGroup>
              {agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.id}
                  keywords={[agent.name, agent.description]}
                  onSelect={() => {
                    onChange(agent.id);
                    setOpen(false);
                  }}
                  className="justify-between gap-2 py-2"
                >
                  <div className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="text-sm">{agent.name}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {agent.description}
                    </span>
                  </div>
                  {agent.id === value ? <CheckIcon className="size-4 shrink-0" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
