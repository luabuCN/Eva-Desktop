import { useCallback, useEffect, useState } from "react";
import { Bot, Copy, Loader2, Pencil, Plus, Settings2, Trash2 } from "lucide-react";

import {
  deleteSubAgent,
  listProviders,
  listSubAgents,
  updateSubAgent,
  type ProviderInfo,
  type SubAgentDefinitionInfo,
} from "@/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { SubAgentFormSheet } from "./SubAgentFormSheet";

/** 委派式子智能体管理（Delegate 工具的目录）：内置四条 + 自定义。 */
export function SubAgentsSection() {
  const [subagents, setSubagents] = useState<SubAgentDefinitionInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SubAgentDefinitionInfo | null>(null);
  const [copying, setCopying] = useState<SubAgentDefinitionInfo | null>(null);
  const [deleting, setDeleting] = useState<SubAgentDefinitionInfo | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSubagents, nextProviders] = await Promise.all([listSubAgents(), listProviders()]);
      setSubagents(nextSubagents);
      setProviders(nextProviders);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载子智能体失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleActive(entry: SubAgentDefinitionInfo, isActive: boolean) {
    setSubagents((current) =>
      current.map((item) => (item.id === entry.id ? { ...item, isActive } : item)),
    );
    try {
      await updateSubAgent(entry.id, { isActive });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新失败");
      void refresh();
    }
  }

  async function remove() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      await deleteSubAgent(target.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-4">
        <div>
          <div className="text-base font-semibold">子智能体</div>
          <p className="text-xs text-muted-foreground">
            主 Agent 通过 Delegate 工具在后台委派任务；只有子智能体的最终报告会回到对话。
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setCopying(null);
            setFormOpen(true);
          }}
        >
          <Plus size={14} />
          创建
        </Button>
      </div>
      {error ? <p className="px-4 text-xs text-destructive">{error}</p> : null}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            加载中...
          </p>
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {subagents.map((entry) => {
              const provider = providers.find((item) => item.id === entry.providerId);
              const model = provider?.models.find((item) => item.id === entry.modelId);
              return (
                <Item variant="outline" key={entry.id}>
                  <ItemContent>
                    <ItemTitle>
                      <Bot size={16} />
                      <span className="font-mono">{entry.name}</span>
                      {entry.isBuiltIn ? <Badge variant="secondary">内置</Badge> : null}
                      {!entry.isActive ? <Badge variant="outline">停用</Badge> : null}
                    </ItemTitle>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
                    <p className="text-xs text-muted-foreground">
                      工具：{entry.tools.join(" / ")}
                      {model ? ` · 固定 ${provider?.name} / ${model.name}` : ""}
                      {entry.imageProviderId && entry.imageModelId
                        ? ` · 生图 ${
                            providers.find((item) => item.id === entry.imageProviderId)?.name ??
                            entry.imageProviderId
                          } / ${entry.imageModelId}`
                        : ""}
                      {entry.maxTurns ? ` · 上限 ${entry.maxTurns} 轮` : ""}
                    </p>
                  </ItemContent>
                    <ItemActions>
                    <Switch
                      checked={entry.isActive}
                      onCheckedChange={(checked) => void toggleActive(entry, !!checked)}
                    />
                    {entry.isBuiltIn ? (
                      <Button
                        variant="outline"
                        size="icon-sm"
                        title="配置运行项（启用 / 图片生成模型）"
                        onClick={() => {
                          setEditing(entry);
                          setCopying(null);
                          setFormOpen(true);
                        }}
                      >
                        <Settings2 size={14} />
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="icon-sm"
                      title={entry.isBuiltIn ? "复制为自定义版本" : "编辑"}
                      onClick={() => {
                        if (entry.isBuiltIn) {
                          setCopying(entry);
                          setEditing(null);
                        } else {
                          setEditing(entry);
                          setCopying(null);
                        }
                        setFormOpen(true);
                      }}
                    >
                      {entry.isBuiltIn ? <Copy size={14} /> : <Pencil size={14} />}
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon-sm"
                      title={entry.isBuiltIn ? "内置子智能体不能删除" : "删除"}
                      disabled={entry.isBuiltIn}
                      onClick={() => setDeleting(entry)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </div>
        )}
      </ScrollArea>

      <SubAgentFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing ?? copying}
        copyOf={copying !== null}
        providers={providers}
        onSaved={() => void refresh()}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除子智能体「{deleting?.name ?? ""}」？主 Agent 将不能再委派任务给它。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void remove()}
            >
              <Trash2 size={14} />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
