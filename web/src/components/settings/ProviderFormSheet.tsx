import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  createProvider,
  fetchRemoteModels,
  updateProvider,
  type ProviderInfo,
  type ProviderInput,
  type ProviderTypeInfo,
} from "@/api";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
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
import { ProviderIcon } from "@/components/ProviderIcon";

interface ProviderFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ProviderInfo | null;
  types: ProviderTypeInfo[];
  onSaved: () => void;
}

export function ProviderFormSheet({
  open,
  onOpenChange,
  initial,
  types,
  onSaved,
}: ProviderFormSheetProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setType(initial?.type ?? "");
    setIsActive(initial?.isActive ?? true);
    setApiBase(initial?.apiBase ?? "");
    setApiKey("");
    setError(undefined);
  }, [open, initial]);

  function selectType(next: string) {
    const previousDefault = types.find((entry) => entry.id === type)?.api;
    const entry = types.find((candidate) => candidate.id === next);
    setType(next);
    if (entry) {
      if (!apiBase.trim() || (previousDefault && apiBase.trim() === previousDefault)) {
        setApiBase(entry.api ?? "");
      }
      if (!name.trim() && !initial) setName(entry.name);
    }
  }

  async function save() {
    if (!name.trim() || !type || !apiBase.trim()) {
      setError("名称、类型与 API Base URL 为必填项");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      let models = initial?.models ?? [];
      if (!initial && models.length === 0) {
        // Best-effort auto pull so a fresh provider arrives with its catalog.
        try {
          models = await fetchRemoteModels(apiBase, apiKey || null);
        } catch {
          models = [];
        }
      }
      const payload: Omit<ProviderInput, "apiKey"> & {
        apiKey?: ProviderInput["apiKey"];
      } = {
        name: name.trim(),
        type,
        apiBase: apiBase.trim(),
        isActive,
        models,
      };
      // Omitting apiKey preserves the stored secret; only create/edit with
      // a non-empty value changes it.
      if (!initial || apiKey.trim()) payload.apiKey = apiKey.trim();
      if (initial) {
        await updateProvider(initial.id, payload);
      } else {
        await createProvider(payload);
      }
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑供应商" : "添加供应商"}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-name">名称</FieldLabel>
              <Input
                id="provider-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 OpenAI-US"
              />
            </Field>

            {!initial && (
              <Field>
                <FieldLabel>类型</FieldLabel>
                <Select value={type} onValueChange={selectType}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择类型" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {types.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        <span className="flex items-center gap-2">
                          <ProviderIcon type={entry.id} size={16} />
                          {entry.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            <Field orientation="horizontal">
              <FieldLabel>启用</FieldLabel>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-api-base">API Base URL</FieldLabel>
              <Input
                id="provider-api-base"
                value={apiBase}
                onChange={(event) => setApiBase(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-api-key">API Key</FieldLabel>
              <Input
                id="provider-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={initial?.hasApiKey ? "已配置，留空保持不变" : "sk-..."}
              />
              <FieldDescription>密钥仅保存在本地配置中。</FieldDescription>
            </Field>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </FieldGroup>
        </div>

        <DialogFooter className="mt-0 gap-2">
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
