import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  History,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import {
  createCronJob,
  deleteCronJob,
  listAgents,
  listCronJobs,
  listProjects,
  runCronJobNow,
  updateCronJob,
  type AgentInfo,
  type CronJobInfo,
  type CronJobInput,
  type CronPermissionMode,
  type CronRunRecordInfo,
  type ProjectInfo,
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SidebarPeekTrigger } from "@/components/SidebarPeekTrigger";
import {
  isTauriWindow,
  windowControlsReserveClass,
} from "@/components/WindowControls";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Cron Builder：预设 ⇄ 五段 cron 表达式互转（分钟/小时/天/周/自定义）
// ---------------------------------------------------------------------------

type CronPreset = "minutes" | "hourly" | "daily" | "weekly" | "custom";

interface CronBuilderState {
  preset: CronPreset;
  minuteInterval: string;
  hourlyMinute: string;
  dailyHour: string;
  dailyMinute: string;
  weeklyDays: string[];
  weeklyHour: string;
  weeklyMinute: string;
  customCron: string;
}

const DAY_OPTIONS = [
  { label: "周一", value: "1" },
  { label: "周二", value: "2" },
  { label: "周三", value: "3" },
  { label: "周四", value: "4" },
  { label: "周五", value: "5" },
  { label: "周六", value: "6" },
  { label: "周日", value: "0" },
] as const;

const DEFAULT_WEEKLY_DAYS = ["1"];
const EMPTY_PROJECT_VALUE = "__none__";
const EMPTY_AGENT_VALUE = "__none__";

const PERMISSION_MODE_OPTIONS: {
  value: CronPermissionMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "confirm",
    label: "每次确认",
    hint: "变更类工具需审批，无人应答时超时拒绝",
  },
  {
    value: "auto_edit",
    label: "自动编辑",
    hint: "文件读写免审批，命令等其余工具仍需确认",
  },
  {
    value: "full",
    label: "完全自动",
    hint: "无人值守推荐：所有工具免审批直接执行",
  },
];

const defaultBuilderState = (): CronBuilderState => ({
  preset: "minutes",
  minuteInterval: "5",
  hourlyMinute: "0",
  dailyHour: "9",
  dailyMinute: "0",
  weeklyDays: [...DEFAULT_WEEKLY_DAYS],
  weeklyHour: "9",
  weeklyMinute: "0",
  customCron: "",
});

const clampNumberString = (value: string, min: number, max: number, fallback: string) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(max, Math.max(min, Math.floor(numeric)));
  return String(clamped);
};

const normalizeCron = (cron: string) => cron.trim().replace(/\s+/g, " ");

/** 轻量客户端校验：五段空白分隔字段（服务端会用 croner 再做严格校验）。 */
const looksLikeCron = (cron: string) => normalizeCron(cron).split(" ").length === 5;

const getCronFromBuilder = (builder: CronBuilderState) => {
  switch (builder.preset) {
    case "minutes": {
      const interval = clampNumberString(builder.minuteInterval, 1, 59, "5");
      return `*/${interval} * * * *`;
    }
    case "hourly": {
      const minute = clampNumberString(builder.hourlyMinute, 0, 59, "0");
      return `${minute} * * * *`;
    }
    case "daily": {
      const hour = clampNumberString(builder.dailyHour, 0, 23, "9");
      const minute = clampNumberString(builder.dailyMinute, 0, 59, "0");
      return `${minute} ${hour} * * *`;
    }
    case "weekly": {
      const hour = clampNumberString(builder.weeklyHour, 0, 23, "9");
      const minute = clampNumberString(builder.weeklyMinute, 0, 59, "0");
      const days = [...builder.weeklyDays].sort((a, b) => Number(a) - Number(b));
      const normalizedDays =
        days.length > 0 ? days.join(",") : DEFAULT_WEEKLY_DAYS.join(",");
      return `${minute} ${hour} * * ${normalizedDays}`;
    }
    case "custom":
    default:
      return normalizeCron(builder.customCron);
  }
};

const describeDays = (days: string[]) => {
  const labels = DAY_OPTIONS.filter((item) => days.includes(item.value)).map(
    (item) => item.label,
  );
  return labels.length > 0 ? labels.join("、") : "周一";
};

const getCronDescription = (builder: CronBuilderState) => {
  switch (builder.preset) {
    case "minutes":
      return `每 ${clampNumberString(builder.minuteInterval, 1, 59, "5")} 分钟执行一次`;
    case "hourly":
      return `每小时的第 ${clampNumberString(builder.hourlyMinute, 0, 59, "0")} 分钟执行`;
    case "daily":
      return `每天 ${clampNumberString(builder.dailyHour, 0, 23, "9").padStart(2, "0")}:${clampNumberString(builder.dailyMinute, 0, 59, "0").padStart(2, "0")} 执行`;
    case "weekly":
      return `每周${describeDays(builder.weeklyDays)} ${clampNumberString(builder.weeklyHour, 0, 23, "9").padStart(2, "0")}:${clampNumberString(builder.weeklyMinute, 0, 59, "0").padStart(2, "0")} 执行`;
    case "custom":
    default:
      return "自定义 cron 表达式";
  }
};

const parseCronToBuilder = (cron: string): CronBuilderState => {
  const normalized = normalizeCron(cron);
  if (!normalized) return defaultBuilderState();

  const parts = normalized.split(" ");
  if (parts.length !== 5) {
    return { ...defaultBuilderState(), preset: "custom", customCron: normalized };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const rest = [dayOfMonth, month, dayOfWeek];

  if (minute.startsWith("*/") && rest.every((field) => field === "*")) {
    return {
      ...defaultBuilderState(),
      preset: "minutes",
      minuteInterval: clampNumberString(minute.slice(2), 1, 59, "5"),
      customCron: normalized,
    };
  }
  if (/^\d+$/.test(minute) && hour === "*" && rest.every((field) => field === "*")) {
    return {
      ...defaultBuilderState(),
      preset: "hourly",
      hourlyMinute: clampNumberString(minute, 0, 59, "0"),
      customCron: normalized,
    };
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      ...defaultBuilderState(),
      preset: "daily",
      dailyHour: clampNumberString(hour, 0, 23, "9"),
      dailyMinute: clampNumberString(minute, 0, 59, "0"),
      customCron: normalized,
    };
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    /^\d+(,\d+)*$/.test(dayOfWeek)
  ) {
    const weeklyDays = dayOfWeek
      .split(",")
      .filter((value) => DAY_OPTIONS.some((item) => item.value === value));
    return {
      ...defaultBuilderState(),
      preset: "weekly",
      weeklyHour: clampNumberString(hour, 0, 23, "9"),
      weeklyMinute: clampNumberString(minute, 0, 59, "0"),
      weeklyDays: weeklyDays.length > 0 ? weeklyDays : [...DEFAULT_WEEKLY_DAYS],
      customCron: normalized,
    };
  }

  return { ...defaultBuilderState(), preset: "custom", customCron: normalized };
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const formatDuration = (start?: string, end?: string) => {
  if (!start) return "-";
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, endMs - startMs);
  if (diff < 1000) return `${diff}ms`;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const formatLastRun = (lastRunAt?: string | null) =>
  lastRunAt ? new Date(lastRunAt).toLocaleString() : "从未执行";

interface CronFormData {
  name: string;
  prompt: string;
  cron: string;
  description: string;
  projectId: string;
  agentId: string;
  permissionMode: CronPermissionMode;
  isActive: boolean;
  reuseThread: boolean;
}

const emptyForm: CronFormData = {
  name: "",
  prompt: "",
  cron: "",
  description: "",
  projectId: "",
  agentId: "",
  permissionMode: "confirm",
  isActive: true,
  reuseThread: false,
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

interface AutomationPageProps {
  onExit: () => void;
  /** 执行历史里「打开对话」：切回聊天视图并定位到对应会话。 */
  onOpenConversation: (conversationId: string) => void;
}

export function AutomationPage({ onExit, onOpenConversation }: AutomationPageProps) {
  const [crons, setCrons] = useState<CronJobInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CronFormData>(emptyForm);
  const [builder, setBuilder] = useState<CronBuilderState>(defaultBuilderState);
  const [saving, setSaving] = useState(false);

  const [deleting, setDeleting] = useState<CronJobInfo | null>(null);
  const [viewingCron, setViewingCron] = useState<CronJobInfo | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());

  const loadCrons = useCallback(async () => {
    try {
      setCrons(await listCronJobs());
      setActionError(undefined);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "加载定时任务失败");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadCrons();
    void listProjects().then(setProjects).catch(() => undefined);
    void listAgents().then(setAgents).catch(() => undefined);
  }, [loadCrons]);

  // 有任务执行中时静默轮询：驱动「上次执行 / 执行历史」与运行状态刷新。
  const anyRunning = crons.some((cron) => cron.isRunning);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => {
      void listCronJobs().then(setCrons).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  // 历史对话框跟随列表刷新，展示最新执行结果。
  useEffect(() => {
    if (!viewingCron) return;
    const fresh = crons.find((item) => item.id === viewingCron.id);
    if (fresh && fresh !== viewingCron) setViewingCron(fresh);
  }, [crons, viewingCron]);

  const projectNameMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const agentNameMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const cronSummary = useMemo(() => getCronDescription(builder), [builder]);

  const syncFormCron = (nextBuilder: CronBuilderState) => {
    setBuilder(nextBuilder);
    setForm((current) => ({ ...current, cron: getCronFromBuilder(nextBuilder) }));
  };

  const openCreateDialog = () => {
    setEditingId(null);
    setForm({ ...emptyForm, cron: getCronFromBuilder(defaultBuilderState()) });
    setBuilder(defaultBuilderState());
    setDialogOpen(true);
  };

  const openEditDialog = (item: CronJobInfo) => {
    setEditingId(item.id);
    setForm({
      name: item.name,
      prompt: item.prompt,
      cron: item.cron,
      description: item.description || "",
      projectId: item.projectId || "",
      agentId: item.agentId || "",
      permissionMode: item.permissionMode,
      isActive: item.isActive,
      reuseThread: item.reuseThread,
    });
    setBuilder(parseCronToBuilder(item.cron));
    setDialogOpen(true);
  };

  const formValid =
    form.name.trim().length > 0 &&
    form.prompt.trim().length > 0 &&
    looksLikeCron(form.cron);

  const handleSave = async () => {
    if (!formValid || saving) return;
    setSaving(true);
    const payload: CronJobInput = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cron: normalizeCron(form.cron),
      description: form.description.trim() || null,
      projectId: form.projectId || null,
      agentId: form.agentId || null,
      permissionMode: form.permissionMode,
      isActive: form.isActive,
      reuseThread: form.reuseThread,
    };
    try {
      if (editingId) {
        await updateCronJob(editingId, payload);
      } else {
        await createCronJob(payload);
      }
      setDialogOpen(false);
      await loadCrons();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "保存定时任务失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteCronJob(deleting.id);
      setViewingCron(null);
      await loadCrons();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "删除定时任务失败");
    } finally {
      setDeleting(null);
    }
  };

  const handleToggleActive = async (item: CronJobInfo) => {
    try {
      await updateCronJob(item.id, { isActive: !item.isActive });
      await loadCrons();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "切换状态失败");
    }
  };

  const handleRunNow = async (item: CronJobInfo) => {
    setRunningIds((prev) => new Set(prev).add(item.id));
    try {
      const result = await runCronJobNow(item.id);
      if (result.alreadyRunning) {
        setActionError(`「${item.name}」已在执行中，请稍候`);
      }
      await loadCrons();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "触发执行失败");
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const renderNumberSelect = (
    value: string,
    onChange: (value: string) => void,
    max: number,
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: max + 1 }, (_, index) => (
          <SelectItem key={index} value={String(index)}>
            {String(index).padStart(2, "0")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const renderRunStatus = (status: CronRunRecordInfo["status"]) => {
    if (status === "success") {
      return (
        <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600">
          成功
        </Badge>
      );
    }
    if (status === "failed") {
      return <Badge variant="destructive">失败</Badge>;
    }
    return <Badge variant="outline">执行中</Badge>;
  };

  const canSave = formValid && !saving;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* 无边框窗口下兼任标题栏：空白处可拖拽窗口，右侧留给自绘窗口按钮。 */}
      <header
        data-tauri-drag-region="deep"
        className={cn(
          "flex h-11 shrink-0 items-center gap-3 border-b px-4 select-none",
          isTauriWindow() && windowControlsReserveClass,
        )}
      >
        <SidebarPeekTrigger />
        <Button variant="ghost" size="icon-sm" onClick={onExit} title="返回">
          <ArrowLeft size={16} />
        </Button>
        <Separator orientation="vertical" className="h-4!" />
        <span className="truncate text-sm text-muted-foreground">自动化</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-medium">定时任务</h1>
              <p className="text-sm text-muted-foreground">
                按计划自动以智能体身份发起对话运行；执行产物是普通会话，可随时打开查看。
              </p>
            </div>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="size-4" />
              添加定时任务
            </Button>
          </div>

          {actionError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="pl-4">名称</TableHead>
                  <TableHead>Cron</TableHead>
                  <TableHead>提示词</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>上次执行</TableHead>
                  <TableHead className="pr-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!loaded ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : crons.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      暂无定时任务，点击右上角「添加定时任务」创建第一个
                    </TableCell>
                  </TableRow>
                ) : (
                  crons.map((item) => {
                    const running = runningIds.has(item.id) || item.isRunning;
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="max-w-[180px] pl-4 font-medium">
                          <div className="flex items-center gap-2">
                            <span className="truncate" title={item.description || undefined}>
                              {item.name}
                            </span>
                            {running ? (
                              <Badge variant="outline" className="text-[10px]">
                                执行中
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="font-mono">
                            {item.cron}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[240px]">
                          <span className="block truncate text-muted-foreground" title={item.prompt}>
                            {item.prompt}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.projectId
                            ? projectNameMap.get(item.projectId) ?? item.projectId
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={item.isActive}
                            onCheckedChange={() => void handleToggleActive(item)}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            {formatLastRun(item.lastRunAt)}
                            {item.lastRunStatus === "failed" ? (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-destructive"
                                title={item.lastRunError ?? "上次执行失败"}
                              />
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="pr-4">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="立即运行"
                              disabled={running}
                              onClick={() => void handleRunNow(item)}
                            >
                              <Play className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="执行历史"
                              onClick={() => setViewingCron(item)}
                            >
                              <History className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="编辑"
                              onClick={() => openEditDialog(item)}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-destructive"
                              title="删除"
                              onClick={() => setDeleting(item)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* 添加 / 编辑对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑定时任务" : "添加定时任务"}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[70vh] gap-4 overflow-y-auto py-1 pr-1">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label>任务名称</Label>
                <Input
                  placeholder="例如：每日工作总结"
                  value={form.name}
                  maxLength={120}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>关联项目</Label>
                <Select
                  value={form.projectId || EMPTY_PROJECT_VALUE}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      projectId: value === EMPTY_PROJECT_VALUE ? "" : value,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY_PROJECT_VALUE}>默认工作区</SelectItem>
                    {projects
                      .filter((project) => !project.archivedAt)
                      .map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Label className="text-sm font-medium">执行计划</Label>
                <Badge variant="outline" className="font-mono">
                  {form.cron || "-"}
                </Badge>
              </div>

              <Tabs
                value={builder.preset}
                onValueChange={(value) =>
                  syncFormCron({
                    ...builder,
                    preset: value as CronPreset,
                    customCron: value === "custom" ? form.cron : builder.customCron,
                  })
                }
                className="gap-4"
              >
                <TabsList className="grid w-full grid-cols-5">
                  <TabsTrigger value="minutes">每隔分钟</TabsTrigger>
                  <TabsTrigger value="hourly">每小时</TabsTrigger>
                  <TabsTrigger value="daily">每天</TabsTrigger>
                  <TabsTrigger value="weekly">每周</TabsTrigger>
                  <TabsTrigger value="custom">自定义</TabsTrigger>
                </TabsList>

                <TabsContent value="minutes" className="space-y-3">
                  <div className="grid gap-2 md:w-56">
                    <Label>间隔分钟</Label>
                    <Select
                      value={builder.minuteInterval}
                      onValueChange={(value) =>
                        syncFormCron({ ...builder, minuteInterval: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 59 }, (_, index) => {
                          const value = String(index + 1);
                          return (
                            <SelectItem key={value} value={value}>
                              每 {value} 分钟
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                </TabsContent>

                <TabsContent value="hourly" className="space-y-3">
                  <div className="grid gap-2 md:w-56">
                    <Label>分钟</Label>
                    {renderNumberSelect(
                      builder.hourlyMinute,
                      (value) => syncFormCron({ ...builder, hourlyMinute: value }),
                      59,
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="daily" className="space-y-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>小时</Label>
                      {renderNumberSelect(
                        builder.dailyHour,
                        (value) => syncFormCron({ ...builder, dailyHour: value }),
                        23,
                      )}
                    </div>
                    <div className="grid gap-2">
                      <Label>分钟</Label>
                      {renderNumberSelect(
                        builder.dailyMinute,
                        (value) => syncFormCron({ ...builder, dailyMinute: value }),
                        59,
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="weekly" className="space-y-4">
                  <div className="grid gap-2">
                    <Label>执行日期</Label>
                    <div className="grid grid-cols-4 gap-2 md:grid-cols-7">
                      {DAY_OPTIONS.map((day) => {
                        const checked = builder.weeklyDays.includes(day.value);
                        return (
                          <Button
                            key={day.value}
                            type="button"
                            variant={checked ? "default" : "outline"}
                            size="sm"
                            onClick={() => {
                              const nextDays = checked
                                ? builder.weeklyDays.filter((value) => value !== day.value)
                                : [...builder.weeklyDays, day.value];
                              syncFormCron({
                                ...builder,
                                weeklyDays:
                                  nextDays.length > 0 ? nextDays : [...DEFAULT_WEEKLY_DAYS],
                              });
                            }}
                          >
                            {day.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>小时</Label>
                      {renderNumberSelect(
                        builder.weeklyHour,
                        (value) => syncFormCron({ ...builder, weeklyHour: value }),
                        23,
                      )}
                    </div>
                    <div className="grid gap-2">
                      <Label>分钟</Label>
                      {renderNumberSelect(
                        builder.weeklyMinute,
                        (value) => syncFormCron({ ...builder, weeklyMinute: value }),
                        59,
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="custom" className="space-y-3">
                  <div className="grid gap-2">
                    <Label>Cron 表达式</Label>
                    <Input
                      placeholder="*/5 * * * *"
                      value={builder.customCron}
                      className="font-mono"
                      onChange={(event) => {
                        const customCron = event.target.value;
                        setBuilder((current) => ({ ...current, customCron }));
                        setForm((current) => ({ ...current, cron: customCron }));
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      格式示例：*/5 * * * *、30 9 * * 1,3,5（分 时 日 月 周，本机时区）
                    </p>
                  </div>
                </TabsContent>
              </Tabs>

              <Separator className="my-4" />

              <div className="flex flex-col gap-2">
                <Label>表达式</Label>
                <Input
                  placeholder="*/5 * * * *"
                  value={form.cron}
                  className="font-mono"
                  onChange={(event) => {
                    const cron = event.target.value;
                    setForm((current) => ({ ...current, cron }));
                    setBuilder(parseCronToBuilder(cron));
                  }}
                />
                <div className="text-sm text-muted-foreground">{cronSummary}</div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>提示词</Label>
              <Textarea
                placeholder="触发时提交给智能体的指令，例如：汇总今天的 git 提交并生成日报……"
                value={form.prompt}
                rows={5}
                onChange={(event) => setForm({ ...form, prompt: event.target.value })}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label>智能体</Label>
                <Select
                  value={form.agentId || EMPTY_AGENT_VALUE}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      agentId: value === EMPTY_AGENT_VALUE ? "" : value,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY_AGENT_VALUE}>默认智能体</SelectItem>
                    {agents
                      .filter((agent) => agent.isActive)
                      .map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                          {agent.isBuiltIn ? "（内置）" : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {form.agentId
                    ? `使用「${agentNameMap.get(form.agentId) ?? form.agentId}」及其默认模型`
                    : "按项目 / 全局默认配置解析智能体与模型"}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label>权限模式</Label>
                <Select
                  value={form.permissionMode}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      permissionMode: value as CronPermissionMode,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {PERMISSION_MODE_OPTIONS.find(
                    (option) => option.value === form.permissionMode,
                  )?.hint ?? ""}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>描述（可选）</Label>
              <Input
                placeholder="这条任务用来做什么，便于日后辨认"
                value={form.description}
                maxLength={500}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={form.isActive}
                onCheckedChange={(checked) => setForm({ ...form, isActive: checked })}
              />
              <Label>创建后立即启用调度</Label>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="grid gap-1">
                <Label>复用上次会话</Label>
                <p className="text-xs text-muted-foreground">
                  {form.reuseThread
                    ? "每次执行落在同一会话里，智能体可延续历史上下文"
                    : "每次执行新建会话（标题锁定为任务名），彼此独立"}
                </p>
              </div>
              <Switch
                checked={form.reuseThread}
                onCheckedChange={(checked) => setForm({ ...form, reuseThread: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={!canSave} onClick={() => void handleSave()}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 执行历史对话框 */}
      <Dialog open={viewingCron !== null} onOpenChange={(open) => !open && setViewingCron(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>执行历史{viewingCron ? ` — ${viewingCron.name}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            {!viewingCron || viewingCron.runHistory.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                还没有执行记录
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {[...viewingCron.runHistory].reverse().map((record, index) => (
                  <div
                    key={`${record.startedAt}-${index}`}
                    className="flex flex-col gap-2 rounded-lg border bg-muted/20 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {renderRunStatus(record.status)}
                      <Badge variant="outline" className="text-xs">
                        {record.trigger === "manual" ? "手动触发" : "定时触发"}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        用时：{formatDuration(record.startedAt, record.endedAt)}
                      </span>
                    </div>
                    <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <div>开始：{new Date(record.startedAt).toLocaleString()}</div>
                      <div>
                        结束：
                        {record.endedAt ? new Date(record.endedAt).toLocaleString() : "-"}
                      </div>
                    </div>
                    {record.conversationId ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">产物会话：</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-0 text-xs"
                          onClick={() => {
                            setViewingCron(null);
                            onOpenConversation(record.conversationId!);
                          }}
                        >
                          打开对话
                        </Button>
                        <span className="font-mono text-muted-foreground">
                          {record.conversationId.slice(0, 8)}
                        </span>
                      </div>
                    ) : null}
                    {record.error ? (
                      <div className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                        <span className="font-medium">错误：</span>
                        {record.error}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewingCron(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除定时任务</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除“{deleting?.name}”吗？调度会立即停止；已生成的会话会保留。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
