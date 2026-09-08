import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import {
  deleteProject,
  listAgents,
  listProjects,
  listProviders,
  updateProject,
  type AgentInfo,
  type ProjectInfo,
  type ProviderInfo,
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
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ProjectForm } from "./ProjectForm";

interface ProjectsSectionProps {
  onChanged?: () => void;
}

export function ProjectsSection({ onChanged }: ProjectsSectionProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectInfo | null>(null);
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextProjects, nextAgents, nextProviders] = await Promise.all([
        listProjects(),
        listAgents(),
        listProviders(),
      ]);
      setProjects(nextProjects);
      setAgents(nextAgents);
      setProviders(nextProviders);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载项目失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openForm(project: ProjectInfo | null) {
    setEditing(project);
    setError(undefined);
    setFormOpen(true);
  }

  async function toggleActive(project: ProjectInfo, nextActive: boolean) {
    setProjects((current) =>
      current.map((entry) => (entry.id === project.id ? { ...entry, isActive: nextActive } : entry)),
    );
    try {
      await updateProject(project.id, { isActive: nextActive });
      onChanged?.();
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
      await deleteProject(target.id);
      await refresh();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-4">
        <div className="text-base font-semibold">项目</div>
        <Button onClick={() => openForm(null)}>
          <Plus size={14} />
          添加
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
            {projects
              .filter((project) => !project.archivedAt)
              .map((project) => {
              const agent = agents.find((entry) => entry.id === project.defaultAgentId);
              const provider = providers.find((entry) => entry.id === project.defaultProviderId);
              const model = provider?.models.find((entry) => entry.id === project.defaultModelId);
              return (
                <Item variant="outline" key={project.id}>
                  <ItemContent>
                    <ItemTitle>
                      <FolderOpen size={16} />
                      <span>{project.name}</span>
                    </ItemTitle>
                    <p className="truncate text-xs text-muted-foreground">{project.rootPath}</p>
                    <p className="text-xs text-muted-foreground">
                      {agent ? `Agent ${agent.name}` : "未设置默认 Agent"}
                      {model ? ` · ${provider?.name} / ${model.name}` : ""}
                    </p>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      checked={project.isActive}
                      onCheckedChange={(checked) => void toggleActive(project, !!checked)}
                    />
                    <Button variant="outline" size="icon-sm" title="编辑" onClick={() => openForm(project)}>
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon-sm"
                      title="删除"
                      onClick={() => setDeleting(project)}
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

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑项目" : "添加项目"}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {formOpen ? (
              <ProjectForm
                key={editing?.id ?? "new"}
                editing={editing}
                onSaved={() => {
                  setFormOpen(false);
                  void refresh();
                  onChanged?.();
                }}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除项目「{deleting?.name ?? ""}」？会话与运行记录会保留，但项目关联会被清空。
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
