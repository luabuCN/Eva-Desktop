import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  createAgent,
  updateAgent,
  type AgentInfo,
  type ProviderInfo,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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

const NONE_MODEL = "__none__";

interface AgentFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: AgentInfo | null;
  providers: ProviderInfo[];
  onSaved: () => void;
}

export function AgentFormSheet({
  open,
  onOpenChange,
  initial,
  providers,
  onSaved,
}: AgentFormSheetProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setInstructions(initial?.instructions ?? "");
    setIsActive(initial?.isActive ?? true);
    setProviderId(initial?.defaultProviderId ?? "");
    setModelId(initial?.defaultModelId ?? "");
    setError(undefined);
  }, [initial, open]);

  const activeProviders = providers.filter((provider) => provider.isActive);
  const selectedProvider = activeProviders.find((provider) => provider.id === providerId);

  function selectProvider(next: string) {
    setProviderId(next === NONE_MODEL ? "" : next);
    setModelId("");
  }

  async function save() {
    if (!name.trim() || !description.trim() || !instructions.trim()) {
      setError("名称、描述和指令为必填项");
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        isActive,
        // 旧版 Mastra 网络子 Agent 已被“设置 → 子智能体”的委派系统取代；
        // 编辑时原样回传已存值，避免误清历史数据。
        subAgents: initial?.subAgents ?? [],
        defaultProviderId: providerId || null,
        defaultModelId: providerId ? modelId || null : null,
      };
      if (initial) await updateAgent(initial.id, payload);
      else await createAgent(payload);
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
          <DialogTitle>{initial ? "编辑 Agent" : "创建 Agent"}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">名称</FieldLabel>
              <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-description">描述</FieldLabel>
              <Input
                id="agent-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">系统指令</FieldLabel>
              <Textarea
                id="agent-instructions"
                className="min-h-40"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>默认模型</FieldLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select value={providerId || NONE_MODEL} onValueChange={selectProvider}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_MODEL}>跟随项目或全局</SelectItem>
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
                  disabled={!providerId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NONE_MODEL}>跟随项目或全局</SelectItem>
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
