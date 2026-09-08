import { useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  Brain,
  ImageIcon,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Video,
  Wrench,
} from "lucide-react";

import {
  fetchSavedProviderModels,
  updateProvider,
  type ProviderInfo,
  type ProviderModel,
} from "@/api";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
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

type ModelModalities = { input: string[]; output: string[] };
type ModelEditorMode = "create" | "edit";
type ModelEditorState = {
  id: string;
  name: string;
  modalities: ModelModalities;
  tool_call: boolean;
  contextLimit?: number;
};

const INPUT_MODALITY_OPTIONS: ModelModalities["input"] = ["text", "image", "audio", "video"];
const MODALITY_LABELS: Record<string, string> = {
  text: "文本",
  image: "图像",
  audio: "音频",
  video: "视频",
};
const CONTEXT_LIMIT_OPTIONS = [6000, 32000, 65536, 128000, 256000, 1000000];
const EMPTY_CONTEXT_LIMIT_VALUE = "__unset__";

const normalizeModalities = (modalities?: ProviderModel["modalities"]): ModelModalities => ({
  input: Array.from(new Set(modalities?.input?.length ? ["text", ...modalities.input] : ["text"])),
  output: Array.from(new Set(modalities?.output ?? ["text"])),
});

const toggleModalityValue = (
  modalities: ProviderModel["modalities"],
  modality: string,
): ModelModalities => {
  const nextModalities = normalizeModalities(modalities);
  if (modality === "text") return nextModalities;
  const nextValues = new Set(nextModalities.input);
  if (nextValues.has(modality)) {
    nextValues.delete(modality);
  } else {
    nextValues.add(modality);
  }
  return normalizeModalities({ ...nextModalities, input: Array.from(nextValues) });
};

const getContextLimitOptions = (currentValue?: number) => {
  const values = new Set(CONTEXT_LIMIT_OPTIONS);
  if (currentValue !== undefined) values.add(currentValue);
  return Array.from(values).sort((a, b) => a - b);
};

const formatContextLimitLabel = (value: number) => {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  return `${value}`;
};

const createModelEditorState = (model?: ProviderModel): ModelEditorState => ({
  id: model?.id ?? "",
  name: model?.name ?? "",
  modalities: normalizeModalities(model?.modalities),
  tool_call: !!model?.tool_call,
  contextLimit: model?.limit?.context,
});

interface ModelsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderInfo | null;
  onSaved: () => void;
}

export function ModelsSheet({ open, onOpenChange, provider, onSaved }: ModelsSheetProps) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<ModelEditorMode>("create");
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<ModelEditorState>(createModelEditorState());

  useEffect(() => {
    if (open) {
      setModels(provider?.models ?? []);
      setSearch("");
      setError(undefined);
      setEditorOpen(false);
      setEditingModelId(null);
    }
  }, [open, provider]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = query
      ? models.filter(
          (model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
        )
      : models;
    return [...list].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const aTime = a.release_date ? new Date(a.release_date).getTime() : 0;
      const bTime = b.release_date ? new Date(b.release_date).getTime() : 0;
      return bTime - aTime;
    });
  }, [models, search]);

  async function persist(next: ProviderModel[]) {
    if (!provider) return;
    setModels(next);
    setError(undefined);
    try {
      await updateProvider(provider.id, { models: next });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存模型失败");
    }
  }

  function toggle(model: ProviderModel) {
    void persist(models.map((entry) => (entry.id === model.id ? { ...entry, enabled: !entry.enabled } : entry)));
  }

  function remove(model: ProviderModel) {
    void persist(models.filter((entry) => entry.id !== model.id));
  }

  function openAdd() {
    setEditorMode("create");
    setEditingModelId(null);
    setEditorState(createModelEditorState());
    setEditorOpen(true);
  }

  function openEdit(model: ProviderModel) {
    setEditorMode("edit");
    setEditingModelId(model.id);
    setEditorState(createModelEditorState(model));
    setEditorOpen(true);
  }

  function saveEditor() {
    const modelId = editorState.id.trim();
    if (!modelId) {
      setError("模型 ID 为必填项");
      return;
    }
    if (editorMode === "create" && models.some((model) => model.id === modelId)) {
      setError("该模型已存在");
      return;
    }
    const modelName = editorState.name.trim() || modelId;
    const nextModalities = normalizeModalities(editorState.modalities);
    const nextLimit =
      editorState.contextLimit !== undefined ? { context: editorState.contextLimit } : undefined;

    if (editorMode === "create") {
      const newModel: ProviderModel = {
        id: modelId,
        name: modelName,
        enabled: true,
        isCustom: true,
        modalities: nextModalities,
        tool_call: editorState.tool_call,
        limit: nextLimit,
      };
      void persist([newModel, ...models]);
    } else {
      if (!editingModelId) return;
      void persist(
        models.map((model) =>
          model.id === editingModelId
            ? {
                ...model,
                name: modelName,
                modalities: nextModalities,
                tool_call: editorState.tool_call,
                limit: nextLimit,
              }
            : model,
        ),
      );
    }
    setEditorOpen(false);
    setEditingModelId(null);
  }

  async function refresh() {
    if (!provider) return;
    setRefreshing(true);
    setError(undefined);
    try {
      const fetched = await fetchSavedProviderModels(provider.id);
      const existingById = new Map(models.map((entry) => [entry.id, entry]));
      const fetchedIds = new Set(fetched.map((entry) => entry.id));
      const manual = models.filter((entry) => !fetchedIds.has(entry.id));
      await persist([
        ...fetched.map((entry) => ({
          ...entry,
          // Keep any enriched info (modalities/limit/...) already stored for this model.
          ...existingById.get(entry.id),
          enabled: existingById.get(entry.id)?.enabled ?? true,
        })),
        ...manual,
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "拉取模型失败");
    } finally {
      setRefreshing(false);
    }
  }

  const normalizedEditorModalities = normalizeModalities(editorState.modalities);
  const contextLimitValue =
    editorState.contextLimit !== undefined ? String(editorState.contextLimit) : EMPTY_CONTEXT_LIMIT_VALUE;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[80vh] max-h-[85vh] flex-col sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>模型管理 · {provider?.name ?? ""}</DialogTitle>
            <div className="flex flex-row gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  placeholder="搜索模型..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupAddon align="inline-end">{filtered.length} 个模型</InputGroupAddon>
              </InputGroup>
              <Button variant="outline" onClick={openAdd}>
                <Plus />
                添加模型
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void refresh()}
                disabled={refreshing}
                title="从 API Base URL 重新拉取"
              >
                <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              </Button>
            </div>
          </DialogHeader>

          {error && (
            <div className="px-4">
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            </div>
          )}

          {refreshing && (
            <p className="flex items-center gap-1 px-4 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> 正在从 {provider?.apiBase} 拉取模型...
            </p>
          )}

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-4">
              {filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无模型，点击「添加模型」手动添加，或从 {provider?.apiBase} 拉取。
                </p>
              ) : (
                filtered.map((model) => {
                  const modalities = normalizeModalities(model.modalities);
                  return (
                    <Item variant="outline" key={model.id}>
                      <ItemContent>
                        <Field className="w-full">
                          <Label className="flex items-center gap-2">
                            {model.name}
                            {model.isCustom && (
                              <Badge variant="secondary" className="text-xs">
                                自定义
                              </Badge>
                            )}
                          </Label>
                          <FieldDescription className="text-sm">{model.id}</FieldDescription>
                          <div className="flex flex-row items-center justify-between">
                            <div className="flex flex-row items-center gap-2">
                              {model.limit?.context && model.limit.context > 0 && (
                                <Badge variant="outline">
                                  {formatContextLimitLabel(model.limit.context)}
                                </Badge>
                              )}
                              {modalities.input.includes("image") && <ImageIcon size={16} />}
                              {modalities.input.includes("audio") && <Mic size={16} />}
                              {modalities.input.includes("video") && <Video size={16} />}
                              {model.reasoning && <Brain size={16} />}
                              {model.tool_call && <Wrench size={16} />}
                            </div>
                            <small className="text-xs text-muted-foreground">{model.release_date}</small>
                          </div>
                        </Field>
                      </ItemContent>
                      <ItemActions>
                        <Button variant="outline" size="sm" onClick={() => openEdit(model)}>
                          <Pencil size={14} />
                          编辑
                        </Button>
                        <Switch checked={model.enabled} onCheckedChange={() => toggle(model)} />
                        {model.isCustom && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => remove(model)}
                            title="移除模型"
                          >
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </ItemActions>
                    </Item>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 添加 / 编辑模型：弹窗 */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editorMode === "create" ? "添加模型" : "编辑模型"}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="model-id">
                  模型 ID <span className="text-destructive">*</span>
                </FieldLabel>
                <Input
                  id="model-id"
                  disabled={editorMode === "edit"}
                  placeholder="例如 gpt-4o-mini"
                  value={editorState.id}
                  onChange={(event) => setEditorState((current) => ({ ...current, id: event.target.value }))}
                />
                {editorMode === "edit" && <FieldDescription>编辑时模型 ID 不可修改。</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel htmlFor="model-name">显示名称</FieldLabel>
                <Input
                  id="model-name"
                  placeholder="可选，默认与模型 ID 相同"
                  value={editorState.name}
                  onChange={(event) => setEditorState((current) => ({ ...current, name: event.target.value }))}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-20 text-xs text-muted-foreground">输入模态</span>
                {INPUT_MODALITY_OPTIONS.map((modality) => {
                  const selected = normalizedEditorModalities.input.includes(modality);
                  const disabled = modality === "text";
                  return (
                    <Badge
                      key={modality}
                      asChild
                      variant={selected ? "default" : "outline"}
                      className={disabled ? "opacity-80" : undefined}
                    >
                      <button
                        type="button"
                        className="cursor-pointer disabled:cursor-not-allowed"
                        disabled={disabled}
                        onClick={() =>
                          setEditorState((current) => ({
                            ...current,
                            modalities: toggleModalityValue(current.modalities, modality),
                          }))
                        }
                      >
                        {MODALITY_LABELS[modality]}
                      </button>
                    </Badge>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground">工具调用</span>
                <Switch
                  checked={editorState.tool_call}
                  onCheckedChange={(checked) =>
                    setEditorState((current) => ({ ...current, tool_call: !!checked }))
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground">上下文长度</span>
                <Select
                  value={contextLimitValue}
                  onValueChange={(value) =>
                    setEditorState((current) => ({
                      ...current,
                      contextLimit: value === EMPTY_CONTEXT_LIMIT_VALUE ? undefined : Number(value),
                    }))
                  }
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="未设置" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY_CONTEXT_LIMIT_VALUE}>未设置</SelectItem>
                    {getContextLimitOptions(editorState.contextLimit).map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {formatContextLimitLabel(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button onClick={saveEditor} disabled={editorMode === "create" && !editorState.id.trim()}>
              {editorMode === "create" ? "添加" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
