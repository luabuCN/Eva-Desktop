import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  API_URL,
  createTerminal,
  killTerminal,
  listTerminals,
  resizeTerminal,
  sendTerminalInput,
  type ProjectInfo,
  type TerminalInfo,
} from "@/api";
import { cn } from "@/lib/utils";

/**
 * 应用内用户终端（PTY）：xterm.js 前端 + sidecar 的 node-pty 会话。
 * 命令由用户直接敲，不经过智能体的审批链；cwd 跟随当前项目（无项目
 * 时为默认工作区）。PTY 会话活在 sidecar 里，离开页签只断 SSE 流，
 * 回来时重接 + 环形缓冲回放，历史不丢；进程退出后可一键重开。
 */

const TERMINAL_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#6a9955",
  yellow: "#d7ba7d",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
};

interface TerminalTab {
  info: TerminalInfo;
  term: XTerm;
  fit: FitAddon;
  source: EventSource;
  opened: boolean;
  exited: boolean;
}

export function TerminalPane({ project }: { project?: ProjectInfo | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Map<string, TerminalTab>>(new Map());
  const [ids, setIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [exitedIds, setExitedIds] = useState<Set<string>>(new Set());

  /** 为一个已存在的 PTY 会话建 xterm 实例并接入输出流（不创建进程）。 */
  const attachExisting = useCallback((info: TerminalInfo) => {
    if (tabsRef.current.has(info.id)) return;

    const term = new XTerm({
      theme: TERMINAL_THEME,
      fontSize: 12,
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // 键入合并：16ms 窗口内的按键合成一次 POST，避免逐键请求。
    let pendingInput = "";
    let flushTimer: number | undefined;
    term.onData((data) => {
      pendingInput += data;
      if (flushTimer === undefined) {
        flushTimer = window.setTimeout(() => {
          flushTimer = undefined;
          const batch = pendingInput;
          pendingInput = "";
          if (batch) void sendTerminalInput(info.id, batch).catch(() => undefined);
        }, 16);
      }
    });

    const source = new EventSource(`${API_URL}/api/terminal/${info.id}/stream`);
    const tab: TerminalTab = { info, term, fit, source, opened: false, exited: false };
    source.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          type: "replay" | "output" | "exit";
          data?: string;
          exitCode?: number;
        };
        if (message.type === "replay" || message.type === "output") {
          tab.term.write(message.data ?? "");
        } else if (message.type === "exit") {
          tab.exited = true;
          source.close();
          setExitedIds((current) => new Set(current).add(info.id));
        }
      } catch {
        // 非 JSON 消息忽略
      }
    };

    tabsRef.current.set(info.id, tab);
    setIds((current) => (current.includes(info.id) ? current : [...current, info.id]));
    setActiveId(info.id);
  }, []);

  const spawn = useCallback(
    async (title?: string) => {
      try {
        const info = await createTerminal({
          cwd: project?.rootPath || undefined,
          title,
          cols: 80,
          rows: 24,
        });
        attachExisting(info);
      } catch (error) {
        if (error instanceof Error && error.message.includes("不可用")) {
          setUnavailable(true);
        }
      }
    },
    [attachExisting, project?.rootPath],
  );

  // 启动：重接已有 PTY 会话（服务还活着、只是前端切走/刷新了），
  // 没有才开新终端。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await listTerminals();
        if (cancelled) return;
        if (existing.length > 0) {
          for (const info of existing) attachExisting(info);
          return;
        }
      } catch {
        // 列表失败按"无会话"处理。
      }
      if (!cancelled) await spawn();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // xterm 挂载：holder div 由 React 按 id 渲染，每个 tab open 到自己的
  // holder 一次；激活的 tab fit + 同步 PTY 尺寸 + 聚焦。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    for (const [id, tab] of tabsRef.current) {
      if (tab.opened) continue;
      const holder = container.querySelector<HTMLDivElement>(`[data-term="${id}"]`);
      if (!holder) continue;
      tab.term.open(holder);
      tab.opened = true;
    }
    const active = activeId ? tabsRef.current.get(activeId) : undefined;
    if (active?.opened && !active.exited) {
      try {
        active.fit.fit();
        const { cols, rows } = active.term;
        if (cols !== active.info.cols || rows !== active.info.rows) {
          void resizeTerminal(active.info.id, cols, rows).catch(() => undefined);
        }
      } catch {
        // 容器不可见时 fit 可能抛错
      }
      active.term.focus();
    }
  }, [activeId, ids]);

  // 尺寸自适应：容器变化 → 节流 fit → 通知 PTY。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const current = activeId ? tabsRef.current.get(activeId) : undefined;
        if (!current?.opened || current.exited) return;
        try {
          current.fit.fit();
          void resizeTerminal(current.info.id, current.term.cols, current.term.rows).catch(
            () => undefined,
          );
        } catch {
          // 容器不可见时 fit 可能抛错
        }
      }, 200);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      window.clearTimeout(resizeTimer);
    };
  }, [activeId]);

  // 组件卸载：只断 SSE（PTY 会话保留在 sidecar，切回来继续）。
  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current.values()) tab.source.close();
      tabsRef.current.clear();
      setIds([]);
    };
  }, []);

  const close = useCallback(
    async (id: string) => {
      const tab = tabsRef.current.get(id);
      tab?.source.close();
      tab?.term.dispose();
      tabsRef.current.delete(id);
      await killTerminal(id).catch(() => undefined);
      setIds((current) => current.filter((entry) => entry !== id));
      setExitedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setActiveId((current) => {
        if (current !== id) return current;
        const remaining = [...tabsRef.current.keys()];
        return remaining[remaining.length - 1];
      });
    },
    [],
  );

  if (unavailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <TerminalIcon className="size-6" />
        <p>终端组件不可用（node-pty 未加载）</p>
        <p className="text-xs">开发模式自带；打包版需要随 sidecar 分发原生模块</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {ids.map((id) => {
          const tab = tabsRef.current.get(id);
          const exited = exitedIds.has(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveId(id)}
              className={cn(
                "group flex max-w-44 items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors",
                id === activeId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
                exited && "opacity-60",
              )}
            >
              <TerminalIcon className="size-3 shrink-0" />
              <span className="truncate">{tab?.info.title ?? id.slice(0, 8)}</span>
              <span
                role="button"
                aria-label="关闭终端"
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  void close(id);
                }}
              >
                <XIcon className="size-3" />
              </span>
            </button>
          );
        })}
        <button
          type="button"
          aria-label="新建终端"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void spawn()}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 bg-[#1e1e1e] p-1">
        {ids.map((id) => (
          <div
            key={id}
            data-term={id}
            className={cn("absolute inset-1 overflow-hidden", id !== activeId && "hidden")}
          />
        ))}
        {activeId && exitedIds.has(activeId) ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#1e1e1e]/90 text-sm text-muted-foreground">
            <SquareIcon className="size-4" />
            <span>终端已退出</span>
            <button
              type="button"
              className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                void close(activeId).then(() => spawn());
              }}
            >
              <RotateCcwIcon className="size-3.5" />
              重新打开
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
