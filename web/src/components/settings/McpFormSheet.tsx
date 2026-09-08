import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, Loader2, Plus, Server, Terminal, Trash2 } from "lucide-react";

import {
  createMcpServer,
  updateMcpServer,
  type McpServerInfo,
  type McpTransport,
  type ProjectInfo,
} from "@/api";
import { highlightCode } from "@/components/ai-elements/code-block";
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
import { parseLooseJson, parseMcpImport } from "@/lib/mcp-import";
import type { ThemedToken } from "shiki";
import { cn } from "@/lib/utils";

/** 可编辑的 JSON 代码框：复用聊天代码块的 shiki 高亮（highlightCode 共享
 * 同一个高亮器与缓存），透明 textarea 叠在高亮层上，两层同字体同行高、
 * 滚动同步；粘贴进来的是合法 JSON（含可修复片段）时直接替换为格式化结果。 */
function JsonEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const highlightLayer = useRef<HTMLDivElement>(null);

  const rawTokens = useMemo(
    () =>
      value.split("\n").map((line) =>
        line ? [{ color: "inherit", content: line } as ThemedToken] : [],
      ),
    [value],
  );
  const syncTokens = useMemo(
    () => highlightCode(value, "json")?.tokens ?? rawTokens,
    [value, rawTokens],
  );
  const [asyncTokens, setAsyncTokens] = useState<ThemedToken[][] | null>(null);
  const tokenKey = useRef(value);
  if (tokenKey.current !== value) {
    tokenKey.current = value;
    setAsyncTokens(null);
  }
  useEffect(() => {
    let cancelled = false;
    highlightCode(value, "json", (result) => {
      if (!cancelled) setAsyncTokens(result.tokens);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);
  const tokens = asyncTokens ?? syncTokens;

  return (
    <div className="relative h-72 overflow-hidden rounded-md border bg-muted/20">
      <div
        ref={highlightLayer}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 p-3 font-mono text-xs leading-5 whitespace-pre"
      >
        {tokens.map((line, lineIndex) => (
          <div key={lineIndex} className="min-h-5">
            {line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                className="dark:!text-[var(--shiki-dark)]"
                style={{ color: token.color }}
              >
                {token.content}
              </span>
            ))}
          </div>
        ))}
      </div>
      <textarea
        id="mcp-json"
        value={value}
        spellCheck={false}
        wrap="off"
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          const parsed = parseLooseJson(text);
          if (parsed.ok) {
            event.preventDefault();
            onChange(JSON.stringify(parsed.value, null, 2));
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          const field = event.currentTarget;
          const start = field.selectionStart;
          const end = field.selectionEnd;
          onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
          requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2));
        }}
        onScroll={(event) => {
          const field = event.currentTarget;
          if (highlightLayer.current) {
            highlightLayer.current.style.transform = `translate(${-field.scrollLeft}px, ${-field.scrollTop}px)`;
          }
        }}
        className="absolute inset-0 h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-foreground outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}

interface McpFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建。 */
  initial: McpServerInfo | null;
  projects: ProjectInfo[];
  /** 新建时的默认作用域（项目 id；null = 全局）。 */
  defaultProjectId?: string | null;
  onSaved: () => void;
}

/** 一行键值对（环境变量 / 请求头）。 */
interface KVPair {
  key: string;
  value: string;
}

function recordToPairs(record: Record<string, string>): KVPair[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function pairsToRecord(pairs: KVPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) out[key.trim()] = value;
  }
  return out;
}

/** 命令行参数按空白切分，支持引号包裹的段（路径带空格仍是一个参数）。 */
function splitArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** 服务端可接受的标识符：字母开头，[A-Za-z0-9_-]，最长 64。 */
function idFromLabel(label: string): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return /^[a-z]/.test(cleaned) ? cleaned : "";
}

function urlAllowed(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function KeyValueRows({
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  pairs: KVPair[];
  onChange: (next: KVPair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            className="h-8 flex-1 font-mono text-xs"
            value={pair.key}
            placeholder={keyPlaceholder}
            onChange={(event) =>
              onChange(pairs.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))
            }
          />
          <Input
            className="h-8 flex-1 font-mono text-xs"
            type="password"
            value={pair.value}
            placeholder={valuePlaceholder}
            onChange={(event) =>
              onChange(pairs.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            title="删除此行"
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <Plus size={13} />
        {addLabel}
      </Button>
    </div>
  );
}

/** MCP 服务器编辑器：传输类型决定表单形态，两条分支永不同时出现——
 * 同时要 URL 和命令的表单只会诱导出各填一半的配置（参考 PI-Desktop）。 */
export function McpFormSheet({
  open,
  onOpenChange,
  initial,
  projects,
  defaultProjectId,
  onSaved,
}: McpFormSheetProps) {
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [label, setLabel] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envPairs, setEnvPairs] = useState<KVPair[]>([]);
  const [url, setUrl] = useState("");
  const [headerPairs, setHeaderPairs] = useState<KVPair[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  /** 新建时的输入模式：逐字段表单 / 粘贴 JSON（编辑只有表单）。 */
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setMode("form");
    setJsonText("");
    setIdTouched(!!initial);
    if (!initial) {
      setTransport("stdio");
      setLabel("");
      setId("");
      setDescription("");
      setCommand("");
      setArgs("");
      setEnvPairs([]);
      setUrl("");
      setHeaderPairs([]);
      setProjectId(defaultProjectId ?? null);
      setEnabled(true);
      return;
    }
    setTransport(initial.transport);
    setLabel(initial.label);
    setId(initial.id);
    setDescription(initial.description ?? "");
    setCommand(initial.command ?? "");
    setArgs(initial.args.join(" "));
    setEnvPairs(recordToPairs(initial.env));
    setUrl(initial.url ?? "");
    setHeaderPairs(recordToPairs(initial.headers));
    setProjectId(initial.projectId);
    setEnabled(initial.enabled);
  }, [initial, open, defaultProjectId]);

  function validate(): string | undefined {
    if (!id.trim()) return "标识符为必填项";
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id.trim())) {
      return "标识符需以字母开头，仅含字母、数字、_ 和 -（最长 64）";
    }
    if (!label.trim()) return "名称为必填项";
    if (transport === "stdio") {
      if (!command.trim()) return "stdio 传输需要启动命令";
      if (command.includes("..")) return "启动命令不允许包含 ..";
      return undefined;
    }
    if (!url.trim()) return "http 传输需要服务器 URL";
    if (!urlAllowed(url.trim())) return "URL 仅支持 https 或本机回环 http 地址";
    return undefined;
  }

  async function save() {
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setSaving(true);
    setError(undefined);
    const input = {
      label: label.trim(),
      description: description.trim() || null,
      transport,
      enabled,
      projectId,
      ...(transport === "stdio"
        ? {
            command: command.trim(),
            args: splitArgs(args),
            env: pairsToRecord(envPairs),
          }
        : {
            url: url.trim(),
            headers: pairsToRecord(headerPairs),
          }),
    };
    try {
      if (initial) await updateMcpServer(initial.id, input);
      else await createMcpServer({ ...input, id: id.trim() });
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  /** 手动格式化：合法 JSON（含可修复片段）规整缩进，顺便把片段补全成完整对象。 */
  function formatJson() {
    const parsed = parseLooseJson(jsonText);
    if (!parsed.ok) {
      setError(`无法格式化：不是有效的 JSON（${parsed.error}）`);
      return;
    }
    setError(undefined);
    setJsonText(JSON.stringify(parsed.value, null, 2));
  }

  /** JSON 模式：解析粘贴的配置并逐个创建，支持一次导入多个服务器。 */
  async function importFromJson() {
    let parsed: ReturnType<typeof parseMcpImport>;
    try {
      parsed = parseMcpImport(jsonText);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JSON 解析失败");
      return;
    }
    if (parsed.servers.length === 0) {
      setError(
        `没有可导入的服务器：${parsed.skipped.map((item) => `${item.id}（${item.reason}）`).join("；")}`,
      );
      return;
    }
    setSaving(true);
    setError(undefined);
    const failures: string[] = [];
    let created = 0;
    try {
      for (const draft of parsed.servers) {
        try {
          await createMcpServer({ ...draft, projectId });
          created += 1;
        } catch (cause) {
          failures.push(`${draft.id}：${cause instanceof Error ? cause.message : "创建失败"}`);
        }
      }
      if (created > 0) onSaved();
      if (failures.length === 0 && parsed.skipped.length === 0) {
        onOpenChange(false);
        return;
      }
      const parts = [`成功导入 ${created} 个`];
      if (failures.length > 0) parts.push(`失败：${failures.join("；")}`);
      if (parsed.skipped.length > 0) {
        parts.push(
          `跳过：${parsed.skipped.map((item) => `${item.id}（${item.reason}）`).join("；")}`,
        );
      }
      setError(parts.join("；"));
    } finally {
      setSaving(false);
    }
  }

  const setLabelAndSlug = (value: string) => {
    setLabel(value);
    if (!idTouched && !initial) setId(idFromLabel(value));
  };

  const transports: Array<{
    id: McpTransport;
    icon: typeof Terminal;
    title: string;
    hint: string;
  }> = [
    {
      id: "stdio",
      icon: Terminal,
      title: "本地进程（stdio）",
      hint: "用命令启动本地 MCP 服务器，如 npx -y …",
    },
    {
      id: "http",
      icon: Server,
      title: "远程服务（HTTP）",
      hint: "连接 Streamable HTTP / SSE 端点",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{initial ? `编辑 MCP 服务器 ${initial.label}` : "新增 MCP 服务器"}</DialogTitle>
        </DialogHeader>

        {/* 新建支持两种输入：逐字段表单 / 粘贴现成 JSON；编辑只有表单。 */}
        {!initial ? (
          <div className="flex self-start rounded-md border p-0.5">
            {(
              [
                ["form", "表单"],
                ["json", "JSON"],
              ] as Array<["form" | "json", string]>
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
                  mode === value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setMode(value)}
              >
                {text}
              </button>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <FieldGroup>
            {mode === "json" && !initial ? (
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="mcp-json">完整配置</FieldLabel>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    title="格式化并修复片段（补全外层花括号、去掉多余尾逗号）"
                    onClick={formatJson}
                  >
                    <Braces size={13} />
                    格式化
                  </Button>
                </div>
                <JsonEditor
                  value={jsonText}
                  onChange={setJsonText}
                  placeholder={'{\n  "mcpServers": {\n    "context7": {\n      "command": "npx",\n      "args": ["-y", "@upstash/context7-mcp"]\n    }\n  }\n}'}
                />
                <FieldDescription>
                  支持粘贴 Claude Desktop / Cursor 等客户端的 mcpServers
                  配置、裸的服务器映射、单个服务器对象，甚至只是「"名称": {"…"}」这样的片段（自动补全外层花括号）；粘贴即自动格式化。带
                  command/args/env 的是 stdio，带 url/headers 的是 http，可一次导入多个。
                </FieldDescription>
              </Field>
            ) : (
              <>
            <Field>
              <FieldLabel>传输类型</FieldLabel>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="传输类型">
                {transports.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={transport === option.id}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
                      transport === option.id && "border-ring bg-accent",
                    )}
                    onClick={() => setTransport(option.id)}
                  >
                    <option.icon size={16} className="mt-0.5 shrink-0" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{option.title}</span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="mcp-label">名称</FieldLabel>
                <Input
                  id="mcp-label"
                  value={label}
                  placeholder="例如 Context7"
                  onChange={(event) => setLabelAndSlug(event.target.value)}
                />
                <FieldDescription>展示名；输入名称会自动生成标识符。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-id">标识符</FieldLabel>
                <Input
                  id="mcp-id"
                  className="font-mono"
                  value={id}
                  disabled={!!initial}
                  placeholder="context7"
                  onChange={(event) => {
                    setIdTouched(true);
                    setId(event.target.value);
                  }}
                />
                <FieldDescription>
                  {initial ? "标识符创建后不可修改。" : "工具名前缀：mcp__标识符__工具名。"}
                </FieldDescription>
              </Field>
            </div>

            {transport === "stdio" ? (
              <>
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
                  <Field>
                    <FieldLabel htmlFor="mcp-command">启动命令</FieldLabel>
                    <Input
                      id="mcp-command"
                      className="font-mono"
                      value={command}
                      placeholder="npx"
                      onChange={(event) => setCommand(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-args">参数</FieldLabel>
                    <Input
                      id="mcp-args"
                      className="font-mono"
                      value={args}
                      placeholder="-y @upstash/context7-mcp"
                      onChange={(event) => setArgs(event.target.value)}
                    />
                    <FieldDescription>空格分隔，引号包裹的段视为一个参数。</FieldDescription>
                  </Field>
                </div>
                <Field>
                  <FieldLabel>环境变量</FieldLabel>
                  <KeyValueRows
                    pairs={envPairs}
                    onChange={setEnvPairs}
                    keyPlaceholder="API_KEY"
                    valuePlaceholder="值（掩码显示）"
                    addLabel="添加变量"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="mcp-url">服务器 URL</FieldLabel>
                  <Input
                    id="mcp-url"
                    className="font-mono"
                    value={url}
                    placeholder="https://mcp.example.com/mcp"
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <FieldDescription>仅允许 https；http 仅限 localhost / 127.0.0.1。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>请求头</FieldLabel>
                  <KeyValueRows
                    pairs={headerPairs}
                    onChange={setHeaderPairs}
                    keyPlaceholder="Authorization"
                    valuePlaceholder="Bearer …（掩码显示）"
                    addLabel="添加请求头"
                  />
                </Field>
              </>
            )}

            <Field>
              <FieldLabel htmlFor="mcp-description">描述</FieldLabel>
              <Input
                id="mcp-description"
                value={description}
                placeholder="一句话说明这个服务器提供什么能力（可选）"
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
              </>
            )}

            <Field>
              <FieldLabel>作用域</FieldLabel>
              <Select
                value={projectId ?? "global"}
                onValueChange={(value) => setProjectId(value === "global" ? null : value)}
                disabled={!!initial}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">全局级 · 对所有项目生效</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      项目级 · {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {initial
                  ? "作用域创建后不可修改。"
                  : "项目级服务器仅在该项目的会话中可用；stdio 进程会以项目根目录为工作目录。"}
              </FieldDescription>
            </Field>

            {mode === "form" ? (
              <Field orientation="horizontal">
                <FieldLabel>启用</FieldLabel>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </Field>
            ) : null}

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </FieldGroup>
        </div>

        <DialogFooter className="mt-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={() =>
              mode === "json" && !initial ? void importFromJson() : void save()
            }
            disabled={saving}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {mode === "json" && !initial ? "导入" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
