import { useCallback, useEffect, useState } from "react";
import { Loader2, PlusIcon, ShieldCheckIcon, TerminalIcon, XIcon } from "lucide-react";

import {
  createCommandRule,
  deleteCommandRule,
  listCommandRules,
  listProjects,
  type CommandRuleInfo,
  type ProjectInfo,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const GLOBAL_SCOPE = "__global__";

export function CommandRulesSection() {
  const [rules, setRules] = useState<CommandRuleInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState<"prefix" | "exact">("prefix");
  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([listCommandRules(), listProjects()])
      .then(([nextRules, nextProjects]) => {
        setRules(nextRules);
        setProjects(nextProjects);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "加载命令规则失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const add = async () => {
    const trimmed = pattern.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await createCommandRule({
        pattern: trimmed,
        matchType,
        projectId: scope === GLOBAL_SCOPE ? null : scope,
      });
      setPattern("");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存规则失败");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    await deleteCommandRule(id).catch(() => undefined);
    setRules((current) => current.filter((rule) => rule.id !== id));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 pt-2">
        <TerminalIcon className="size-4" />
        <span className="text-sm font-semibold">命令放行规则</span>
        <span className="text-xs text-muted-foreground">
          命中规则的 bash 命令免审批执行；复合命令逐段检查
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        内置只读命令（git status / diff / log、ls、cat、grep 等）自动放行；这里维护你自己的规则，
        或在命令审批卡上选「始终允许此类命令」一键添加。
      </p>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 min-w-44 flex-1 font-mono text-xs"
          placeholder="如 pnpm test 或 cargo build"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          disabled={submitting}
        />
        <Select value={matchType} onValueChange={(value) => setMatchType(value as "prefix" | "exact")}>
          <SelectTrigger className="h-8 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="prefix">前缀匹配</SelectItem>
            <SelectItem value="exact">完全匹配</SelectItem>
          </SelectContent>
        </Select>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={GLOBAL_SCOPE}>全部项目（全局）</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                仅 {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="h-8" disabled={!pattern.trim() || submitting} onClick={() => void add()}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <PlusIcon size={14} />}
          添加
        </Button>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载中...
        </p>
      ) : rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无自定义规则。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{rule.pattern}</code>
              <Badge variant={rule.matchType === "prefix" ? "secondary" : "outline"}>
                {rule.matchType === "prefix" ? "前缀" : "完全"}
              </Badge>
              <Badge variant="outline">{rule.projectName ? rule.projectName : "全局"}</Badge>
              <button
                type="button"
                aria-label="删除规则"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void remove(rule.id)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheckIcon className="size-3.5 shrink-0" />
        <span>
          安全边界：含重定向 / 命令替换（&gt;、$() 等）的命令永不自动放行；规则按空白分词匹配，
          "pnpm test" 不会放行 "pnpm test:watch" 之外的命令
        </span>
      </p>
    </div>
  );
}
