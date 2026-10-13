import { useMemo, useState, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  CheckIcon,
  ChevronDownIcon,
  ImageIcon,
  ImagesIcon,
  ProportionsIcon,
  SparklesIcon,
  SwatchBookIcon,
  XIcon,
} from "lucide-react";

import type { ProviderInfo } from "@/api";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  ASPECT_RATIOS,
  IMAGE_COUNTS,
  IMAGE_MODEL_PATTERN,
  IMAGE_STYLES,
  aspectRatioLabel,
  imageCountLabel,
  imageStyleLabel,
  type ImageGenOptions,
} from "@/lib/image-gen";
import { cn } from "@/lib/utils";

/**
 * 图像生成模式的参数行：激活 chip（点 ✕ 退出）+ 模型/比例/风格三个
 * Popover 选择器。视觉与交互复刻 ModelSelector 的 trigger/panel 约定，
 * 整体在 ChatPane 的 PromptInputTools 里替换默认工具组。
 */

interface ImageGenControlsProps {
  providers: ProviderInfo[];
  value: ImageGenOptions;
  onChange: (next: ImageGenOptions) => void;
  onExit: () => void;
}

const triggerClass =
  "flex h-7 max-w-48 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground";

const panelClass =
  "z-50 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md outline-none";

export function ImageGenControls({ providers, value, onChange, onExit }: ImageGenControlsProps) {
  return (
    <>
      {/* 激活态 chip：点击退出图像生成模式，回到默认对话工具组。 */}
      <button
        type="button"
        onClick={onExit}
        title="退出图像生成"
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 text-xs text-primary transition-colors hover:bg-primary/10"
      >
        <ImageIcon className="size-3.5 shrink-0" />
        图像生成
        <XIcon className="size-3 shrink-0" />
      </button>
      <ImageModelPicker
        providers={providers}
        value={value}
        onChange={onChange}
      />
      <RatioPicker value={value} onChange={onChange} />
      <StylePicker value={value} onChange={onChange} />
      <CountPicker value={value} onChange={onChange} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 模型：「自动」+ 启用 Provider 中命名匹配图片特征的启用模型
// ---------------------------------------------------------------------------

function ImageModelPicker({
  providers,
  value,
  onChange,
}: Omit<ImageGenControlsProps, "onExit">) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(
    () =>
      providers
        .filter((provider) => provider.isActive)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) => model.enabled && IMAGE_MODEL_PATTERN.test(model.id),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [providers],
  );

  const effective = value.model
    ? groups
        .find((group) => group.provider.id === value.model?.providerId)
        ?.models.find((model) => model.id === value.model?.modelId)
    : undefined;
  const label = value.model ? (effective?.name ?? value.model.modelId) : "自动";

  const select = (model: ImageGenOptions["model"]) => {
    onChange({ ...value, model });
    setOpen(false);
  };

  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <SparklesIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 text-muted-foreground/70">模型</span>
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </>
      }
      triggerTitle="图片模型"
      panelWidth="w-72"
    >
      <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
        <PickerRow selected={value.model === null} onClick={() => select(null)}>
          <span className="min-w-0 flex-1 truncate">自动</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">按命名特征发现</span>
        </PickerRow>
        {groups.map((group) => (
          <div key={group.provider.id}>
            <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
              {group.provider.name}
            </p>
            {group.models.map((model) => (
              <PickerRow
                key={`${group.provider.id}/${model.id}`}
                selected={
                  value.model?.providerId === group.provider.id &&
                  value.model?.modelId === model.id
                }
                onClick={() => select({ providerId: group.provider.id, modelId: model.id })}
              >
                <ProviderIcon type={group.provider.type} size={14} />
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
              </PickerRow>
            ))}
          </div>
        ))}
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            未发现图片模型。请到「设置 → 供应商」中启用 seedream / gpt-image / qwen-image 等图片模型。
          </p>
        ) : null}
      </div>
    </PickerShell>
  );
}

// ---------------------------------------------------------------------------
// 比例：4×2 网格，图标按真实宽高比绘制（对齐豆包的比例面板）
// ---------------------------------------------------------------------------

function RatioPicker({ value, onChange }: { value: ImageGenOptions; onChange: (next: ImageGenOptions) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <ProportionsIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 text-muted-foreground/70">比例</span>
          <span className="truncate">{aspectRatioLabel(value.ratio)}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </>
      }
      triggerTitle="图片比例"
      panelWidth="w-64"
    >
      <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">比例</p>
      <div className="grid grid-cols-4 gap-1.5 p-2">
        {ASPECT_RATIOS.map((ratio) => {
          const selected = value.ratio === ratio.id;
          return (
            <button
              key={ratio.id}
              type="button"
              onClick={() => {
                onChange({ ...value, ratio: ratio.id });
                setOpen(false);
              }}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md px-1 py-2 text-[11px] transition-colors",
                selected
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <span className="flex h-6 items-center justify-center">
                {ratio.ratio ? (
                  <span
                    className={cn(
                      "rounded-[2px] border",
                      selected ? "border-foreground" : "border-muted-foreground/70",
                    )}
                    style={
                      ratio.ratio >= 1
                        ? { width: 22, height: Math.max(8, Math.round(22 / ratio.ratio)) }
                        : { width: Math.max(8, Math.round(22 * ratio.ratio)), height: 22 }
                    }
                  />
                ) : (
                  <SparklesIcon className="size-4" />
                )}
              </span>
              {ratio.label}
            </button>
          );
        })}
      </div>
    </PickerShell>
  );
}

// ---------------------------------------------------------------------------
// 风格：纵向列表，首项「无」
// ---------------------------------------------------------------------------

function StylePicker({ value, onChange }: { value: ImageGenOptions; onChange: (next: ImageGenOptions) => void }) {
  const [open, setOpen] = useState(false);
  const selected = value.style !== "none";
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <SwatchBookIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 text-muted-foreground/70">风格</span>
          {selected ? <span className="truncate">{imageStyleLabel(value.style)}</span> : null}
          <ChevronDownIcon className="size-3 shrink-0" />
        </>
      }
      triggerTitle="图片风格"
      panelWidth="w-48"
    >
      <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">风格</p>
      <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
        {IMAGE_STYLES.map((style) => (
          <PickerRow
            key={style.id}
            selected={value.style === style.id}
            onClick={() => {
              onChange({ ...value, style: style.id });
              setOpen(false);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{style.label}</span>
          </PickerRow>
        ))}
      </div>
    </PickerShell>
  );
}

// ---------------------------------------------------------------------------
// 张数：自动（按提示词关键词推断，默认 1）+ 1-4 张
// ---------------------------------------------------------------------------

function CountPicker({ value, onChange }: { value: ImageGenOptions; onChange: (next: ImageGenOptions) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <ImagesIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 text-muted-foreground/70">张数</span>
          <span className="truncate">{imageCountLabel(value.count)}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </>
      }
      triggerTitle="生成张数"
      panelWidth="w-40"
    >
      <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">张数（最多 4 张）</p>
      <div className="p-1">
        {IMAGE_COUNTS.map((count) => (
          <PickerRow
            key={count}
            selected={value.count === count}
            onClick={() => {
              onChange({ ...value, count });
              setOpen(false);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{imageCountLabel(count)}</span>
            {count === 0 ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">按提示词推断</span>
            ) : null}
          </PickerRow>
        ))}
      </div>
    </PickerShell>
  );
}

// ---------------------------------------------------------------------------
// 共用壳与行
// ---------------------------------------------------------------------------

function PickerShell({
  open,
  onOpenChange,
  trigger,
  triggerTitle,
  panelWidth,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  triggerTitle: string;
  panelWidth: string;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={triggerClass} title={triggerTitle}>
          {trigger}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          side="top"
          sideOffset={8}
          className={cn(panelClass, panelWidth)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function PickerRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
      onClick={onClick}
    >
      {children}
      {selected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
    </button>
  );
}
