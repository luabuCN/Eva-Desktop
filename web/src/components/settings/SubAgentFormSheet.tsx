import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  createSubAgent,
  updateSubAgent,
  type ProviderInfo,
  type SubAgentDefinitionInfo,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const NONE_MODEL = "__none__";

/** Delegatable tool names (kept in sync with the server provider registry). */
const TOOL_CHOICES = [
  "readFile",
  "listFiles",
  "glob",
  "grep",
  "bash",
  "writeFile",
  "editFile",
  "mkdir",
  "generateImage",
] as const;

/** 图片模型家族命名特征，与服务端 image-provider 的自动发现保持一致。 */
const IMAGE_MODEL_PATTERN =
  /(gpt-image|dall-e|cogview|seedream|seededit|qwen-image|hunyuan-image|flux|stable-diffusion|\bsd3\b|wanx|jimeng|image-generation)/i;

interface SubAgentFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建；传入定义 = 编辑或“复制”（复制时 copyOf 置 true）。 */
  initial: SubAgentDefinitionInfo | null;
  copyOf?: boolean;
  providers: ProviderInfo[];
  onSaved: () => void;
}

export function SubAgentFormSheet({
  open,
  onOpenChange,
  initial,
  copyOf = false,
  providers,
  onSaved,
}: SubAgentFormSheetProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [maxTurns, setMaxTurns] = useState("80");
  const [isActive, setIsActive] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [imageProviderId, setImageProviderId] = useState("");
  const [imageModelId, setImageModelId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName(copyOf ? `${initial?.name ?? ""}-copy` : initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setPrompt(initial?.prompt ?? "");
    setTools(initial?.tools?.length ? initial.tools : ["readFile", "glob", "grep"]);
    setMaxTurns(String(initial?.maxTurns ?? 80));
    setIsActive(initial?.isActive ?? true);
    setProviderId(copyOf ? "" : initial?.providerId ?? "");
    setModelId(copyOf ? "" : initial?.modelId ?? "");
    setImageProviderId(copyOf ? "" : initial?.imageProviderId ?? "");
    setImageModelId(copyOf ? "" : initial?.imageModelId ?? "");
    setError(undefined);
  }, [initial, copyOf, open]);

  const activeProviders = providers.filter((provider) => provider.isActive);
  const selectedProvider = activeProviders.find((provider) => provider.id === providerId);
  const selectedImageProvider = activeProviders.find(
    (provider) => provider.id === imageProviderId,
  );
  /** 内置定义的受限编辑：角色字段锁定，仅开放运行配置（启用/图片模型）。 */
  const builtin = !!initial?.isBuiltIn && !copyOf;

  function toggleTool(tool: string) {
    if (builtin) return;
    setTools((current) =>
      current.includes(tool) ? current.filter((entry) => entry !== tool) : [...current, tool],
    );
  }

  async function save() {
    if (!builtin && (!name.trim() || !description.trim() || !prompt.trim())) {
      setError("名称、描述和系统提示词为必填项");
      return;
    }
    if (!builtin && tools.length === 0) {
      setError("至少选择一个工具");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const parsedTurns = Number.parseInt(maxTurns, 10);
      const imagePin = {
        imageProviderId: imageProviderId || null,
        imageModelId: imageProviderId ? imageModelId || null : null,
      };
      const payload = builtin
        ? { isActive, ...imagePin }
        : {
            name: name.trim(),
            description: description.trim(),
            prompt: prompt.trim(),
            tools,
            maxTurns: Number.isFinite(parsedTurns) && parsedTurns > 0 ? parsedTurns : null,
            isActive,
            providerId: providerId || null,
            modelId: providerId ? modelId || null : null,
            ...imagePin,
          };
      if (initial && !copyOf) await updateSubAgent(initial.id, payload);
      else await createSubAgent(payload);
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {builtin
              ? `配置内置子智能体 ${initial?.name}`
              : initial && !copyOf
                ? `编辑子智能体 ${initial.name}`
                : copyOf
                  ? "复制为自定义子智能体"
                  : "创建子智能体"}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="subagent-name">名称</FieldLabel>
              <Input
                id="subagent-name"
                value={name}
                disabled={builtin}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 translator、doc-writer"
              />
              <FieldDescription>模型在 Delegate 工具里用它指定委派目标；字母、数字、下划线、短横线。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="subagent-description">何时委派给它（描述）</FieldLabel>
              <Textarea
                id="subagent-description"
                className="min-h-16"
                value={description}
                disabled={builtin}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="一句话说明这个子智能体擅长什么、主 Agent 应在什么情况下委派。"
              />
              <FieldDescription>这是主 Agent 决定是否委派的唯一依据，写具体一些。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>可用工具</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {TOOL_CHOICES.map((tool) => {
                  const selected = tools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                        selected
                          ? "border-primary/60 bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent",
                        builtin && "cursor-not-allowed opacity-60",
                      )}
                      disabled={builtin}
                    >
                      {selected ? "✓ " : ""}
                      {tool}
                    </button>
                  );
                })}
              </div>
              <FieldDescription>
                未声明工具的子智能体是只读的；bash / writeFile / editFile / mkdir 会让它可写（父 Agent 只读时除外）。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="subagent-prompt">系统提示词</FieldLabel>
              <Textarea
                id="subagent-prompt"
                className="min-h-48 font-mono text-xs"
                value={prompt}
                disabled={builtin}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="这个子智能体的角色指令：职责、约束、以及最终报告的格式。"
              />
              <FieldDescription>
                它看不到当前对话，也不能再委派或向用户提问；只有最终报告会回到主 Agent。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>固定模型</FieldLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select
                  value={providerId || NONE_MODEL}
                  disabled={builtin}
                  onValueChange={(next) => {
                    setProviderId(next === NONE_MODEL ? "" : next);
                    setModelId("");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_MODEL}>跟随会话模型</SelectItem>
                    {activeProviders.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={modelId || NONE_MODEL}
                  onValueChange={(next) => setModelId(next === NONE_MODEL ? "" : next)}
                  disabled={builtin || !providerId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NONE_MODEL}>跟随会话模型</SelectItem>
                    <SelectGroup>
                      {(selectedProvider?.models ?? [])
                        .filter((model) => model.enabled)
                        .map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <FieldDescription>可为简单任务固定便宜/快速的模型，把贵模型留给复杂分析。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>图片生成模型</FieldLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select
                  value={imageProviderId || NONE_MODEL}
                  onValueChange={(next) => {
                    setImageProviderId(next === NONE_MODEL ? "" : next);
                    setImageModelId("");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_MODEL}>自动发现</SelectItem>
                    {activeProviders.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={imageModelId || NONE_MODEL}
                  onValueChange={(next) => setImageModelId(next === NONE_MODEL ? "" : next)}
                  disabled={!imageProviderId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NONE_MODEL}>自动发现</SelectItem>
                    <SelectGroup>
                      {(selectedImageProvider?.models ?? [])
                        .filter((model) => model.enabled)
                        .sort(
                          (a, b) =>
                            Number(IMAGE_MODEL_PATTERN.test(b.id)) -
                            Number(IMAGE_MODEL_PATTERN.test(a.id)),
                        )
                        .map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                            {IMAGE_MODEL_PATTERN.test(model.id) ? "（图片）" : ""}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <FieldDescription>
                仅在工具白名单含 generateImage 时生效：固定后该子智能体的生图默认走此模型（调用参数可临时覆盖）；不固定则按命名特征自动发现。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="subagent-maxturns">轮次上限</FieldLabel>
              <Input
                id="subagent-maxturns"
                type="number"
                min={1}
                max={200}
                value={maxTurns}
                disabled={builtin}
                onChange={(event) => setMaxTurns(event.target.value)}
              />
              <FieldDescription>超过后以 truncated 状态返回最后报告；留空或 0 视为不限。</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>启用</FieldLabel>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </Field>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </FieldGroup>
        </div>

        <DialogFooter className="mt-0 gap-2">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
