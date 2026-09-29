import { useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  BrainCircuitIcon,
  CheckIcon,
  ChevronRightIcon,
  CpuIcon,
  ImageIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";

import {
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  type ModelSelection,
  type ProviderInfo,
  type ReasoningEffort,
} from "@/api";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";

/**
 * The first enabled model of the first active provider — used as the default
 * selection when the user has not picked a model explicitly.
 */
export function defaultModelSelection(providers: ProviderInfo[]): ModelSelection | null {
  for (const provider of providers) {
    if (!provider.isActive) continue;
    const first = provider.models.find((model) => model.enabled);
    if (first) return { providerId: provider.id, modelId: first.id };
  }
  return null;
}

function formatContextLimit(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

interface ModelSelectorProps {
  providers: ProviderInfo[];
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  effort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
}

type MenuView = "menu" | "model" | "effort";

/** PI-Desktop 风格的模型选择器：一个入口弹出「模型 / 推理等级」两行菜单，
 * 各自展开为带返回箭头的二级面板。 */
export function ModelSelector({
  providers,
  value,
  onChange,
  effort,
  onEffortChange,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("menu");
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () =>
      providers
        .filter((provider) => provider.isActive)
        .map((provider) => ({
          provider,
          models: provider.models.filter((model) => model.enabled),
        }))
        .filter((group) => group.models.length > 0),
    [providers],
  );

  const fallback = useMemo(() => defaultModelSelection(providers), [providers]);

  const valueStillValid =
    !!value &&
    groups.some(
      (group) =>
        group.provider.id === value.providerId &&
        group.models.some((model) => model.id === value.modelId),
    );
  const effective = valueStillValid ? value : fallback;

  const effectiveProvider = providers.find(
    (provider) => provider.id === effective?.providerId,
  );
  const effectiveModel = effectiveProvider?.models.find(
    (model) => model.id === effective?.modelId,
  );
  const modelSupportsReasoning = effectiveModel?.reasoning === true;

  const filteredGroups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return groups;
    return groups
      .map((group) => ({
        provider: group.provider,
        models: group.models.filter(
          (model) =>
            model.name.toLowerCase().includes(keyword) ||
            model.id.toLowerCase().includes(keyword) ||
            group.provider.name.toLowerCase().includes(keyword),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  const showView = (next: MenuView) => {
    setView(next);
    if (next === "model") setQuery("");
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("menu");
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="模型与推理等级"
        >
          {effectiveProvider ? (
            <ProviderIcon type={effectiveProvider.type} size={14} />
          ) : (
            <CpuIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{effectiveModel?.name ?? "选择模型"}</span>
          {modelSupportsReasoning && effort !== "off" ? (
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
              {REASONING_EFFORT_LABELS[effort]}
            </span>
          ) : null}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="top"
          sideOffset={8}
          className="z-50 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md outline-none"
        >
          {view === "menu" ? (
            <div className="p-1">
              <MenuRow
                icon={<CpuIcon className="size-4" />}
                label="模型"
                value={effectiveModel?.name ?? "选择模型"}
                onClick={() => showView("model")}
              />
              <MenuRow
                icon={<BrainCircuitIcon className="size-4" />}
                label="推理等级"
                value={
                  modelSupportsReasoning
                    ? REASONING_EFFORT_LABELS[effort]
                    : "不支持"
                }
                onClick={() => showView("effort")}
              />
            </div>
          ) : null}

          {view === "model" ? (
            <div>
              <PanelHeader title="模型" onBack={() => showView("menu")} />
              <div className="border-b p-2">
                <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5">
                  <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索模型"
                    className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
                {filteredGroups.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    无匹配模型
                  </p>
                ) : (
                  filteredGroups.map((group) => (
                    <div key={group.provider.id}>
                      <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                        {group.provider.name}
                      </p>
                      {group.models.map((model) => {
                        const selected =
                          effective?.providerId === group.provider.id &&
                          effective?.modelId === model.id;
                        const contextLabel = formatContextLimit(model.limit?.context);
                        return (
                          <button
                            key={`${group.provider.id}/${model.id}`}
                            type="button"
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                              selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                            )}
                            onClick={() => {
                              onChange({ providerId: group.provider.id, modelId: model.id });
                              setOpen(false);
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">{model.name}</span>
                            {model.modalities?.input?.includes("image") ? (
                              <span className="shrink-0 rounded bg-sky-500/10 px-1 py-px text-[10px] text-sky-600 dark:text-sky-400">
                                视觉
                              </span>
                            ) : null}
                            {model.reasoning ? (
                              <span className="shrink-0 rounded bg-violet-500/10 px-1 py-px text-[10px] text-violet-600 dark:text-violet-400">
                                推理
                              </span>
                            ) : null}
                            {model.tool_call ? (
                              <WrenchIcon className="size-3 shrink-0 text-muted-foreground" />
                            ) : null}
                            {contextLabel ? (
                              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                                {contextLabel}
                              </span>
                            ) : null}
                            {selected ? (
                              <CheckIcon className="size-3.5 shrink-0" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {view === "effort" ? (
            <div>
              <PanelHeader title="推理等级" onBack={() => showView("menu")} />
              <p className="border-b px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {modelSupportsReasoning
                  ? `当前模型 ${effectiveModel?.name ?? ""} 支持推理，选择回答前的思考深度。`
                  : `当前模型 ${effectiveModel?.name ?? ""} 不支持推理。`}
              </p>
              <div className="p-1">
                {modelSupportsReasoning ? (
                  REASONING_EFFORTS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        effort === level
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/60",
                      )}
                      onClick={() => {
                        onEffortChange(level);
                        setOpen(false);
                      }}
                    >
                      <BrainCircuitIcon
                        className={cn(
                          "size-3.5 shrink-0",
                          level === "off" ? "text-muted-foreground" : "text-violet-500",
                        )}
                      />
                      <span className="flex-1">{REASONING_EFFORT_LABELS[level]}</span>
                      {effort === level ? (
                        <CheckIcon className="size-3.5 shrink-0" />
                      ) : null}
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    此模型没有推理能力，可在「模型」中选择带「推理」徽标的模型。
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function MenuRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted/60"
      onClick={onClick}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
        {value}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1.5 border-b px-2 py-2">
      <button
        type="button"
        aria-label="返回"
        className="rounded-md p-1 transition-colors hover:bg-muted/60"
        onClick={onBack}
      >
        <ChevronRightIcon className="size-3.5 rotate-180" />
      </button>
      <span className="text-xs font-medium">{title}</span>
    </div>
  );
}
