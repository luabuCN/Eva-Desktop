import { useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import { createProject, type ProjectInfo } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface ProjectSelectorProps {
  projects: ProjectInfo[];
  projectId?: string;
  onSelectProject: (projectId?: string) => void;
  onChanged?: () => void;
}

export function ProjectSelector({
  projects,
  projectId,
  onSelectProject,
  onChanged,
}: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const selected = projects.find((project) => project.id === projectId);

  async function save() {
    if (!name.trim() || !rootPath.trim()) {
      setError("项目名称和本地路径不能为空");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const project = await createProject({ name: name.trim(), rootPath: rootPath.trim() });
      onChanged?.();
      onSelectProject(project.id);
      setName("");
      setRootPath("");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建项目失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) setError(undefined); setOpen(next); }}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex h-7 max-w-40 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="选择项目工作区"
        >
          <FolderOpenIcon className="size-3.5 shrink-0" />
          <span className="truncate">{selected?.name ?? "本地工作区"}</span>
        </button>
      </DialogTrigger>

      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">选择项目</DialogTitle>
        <Command>
          <CommandInput placeholder="搜索项目..." />
          <CommandList>
            <CommandEmpty>{projects.length === 0 ? "暂无已保存的项目" : "无匹配项"}</CommandEmpty>
            <CommandGroup heading="工作区">
              <CommandItem
                value="local workspace sandbox"
                onSelect={() => { onSelectProject(undefined); setOpen(false); }}
                className="justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <span className="text-sm">本地工作区</span>
                  <span className="block truncate text-xs text-muted-foreground">应用数据工作区</span>
                </div>
                {!projectId ? <FolderOpenIcon className="size-4 shrink-0" /> : null}
              </CommandItem>
              {projects.filter((project) => project.isActive).map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.rootPath}`}
                  keywords={[project.name, project.rootPath]}
                  onSelect={() => { onSelectProject(project.id); setOpen(false); }}
                  className="justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{project.rootPath}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>

          <div className="space-y-2 border-t p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" />
              <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="E:\path\to\project" />
            </div>
            {error ? <p className={cn("text-xs text-destructive")}>{error}</p> : null}
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              添加本地项目
            </Button>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
