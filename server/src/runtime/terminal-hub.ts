import path from "node:path";
import { getWorkspaceRoot } from "./workspace.js";

/**
 * 应用内用户终端（PTY）的后端会话中心。
 *
 * 定位：这是给用户自己用的完整 shell（绑定工作区 cwd），不走智能体的
 * 审批链——命令由人敲、由人看；智能体的 bash 工具仍走 SafeShellProvider
 * 的审批路径，两者互不影响。
 *
 * node-pty 是原生模块：开发模式（tsx）从 node_modules 正常加载；SEA
 * 打包的 sidecar 里加载会失败，此时整体降级（available=false），路由层
 * 返回 503、前端显示不可用，不影响其余功能。
 *
 * 输出回放：每个会话保留 256KB 环形缓冲，SSE 重连（切页签回来、刷新）
 * 先整体回放再接实时流，终端历史不丢。
 */

const RING_BUFFER_BYTES = 256 * 1024;

type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

export interface TerminalSessionInfo {
  id: string;
  pid: number;
  title: string;
  cwd: string;
  /** 创建时所属的项目 id；undefined 表示无项目时开的全局终端。
   *  会话与项目的绑定在创建时固化，前端按它过滤出当前项目的终端。 */
  projectId?: string;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

class TerminalSession {
  readonly id = crypto.randomUUID();
  readonly createdAt = Date.now();
  private readonly subscribers = new Set<(event: TerminalEvent) => void>();
  private readonly buffer: string[] = [];
  private bufferedBytes = 0;
  exited = false;
  exitCode?: number;

  constructor(
    readonly pty: PtyProcess,
    readonly title: string,
    readonly cwd: string,
    private cols: number,
    private rows: number,
    readonly projectId?: string,
  ) {
    pty.onData((data) => this.publish({ type: "output", data }));
    pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.publish({ type: "exit", exitCode });
      this.subscribers.clear();
    });
  }

  info(): TerminalSessionInfo {
    return {
      id: this.id,
      pid: this.pty.pid,
      title: this.title,
      cwd: this.cwd,
      projectId: this.projectId,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      exited: this.exited,
      exitCode: this.exitCode,
    };
  }

  /** 环形缓冲快照：SSE 接入时先回放，终端历史跨重连保留。 */
  replay(): string {
    return this.buffer.join("");
  }

  subscribe(listener: (event: TerminalEvent) => void): () => void {
    if (this.exited) return () => undefined;
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  write(data: string): boolean {
    if (this.exited) return false;
    this.pty.write(data);
    return true;
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // 进程刚退出的竞态下 resize 可能抛错，忽略即可。
    }
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch {
      // 已退出时的 kill 抛错无害。
    }
  }

  private publish(event: TerminalEvent): void {
    if (event.type === "output") this.appendBuffer(event.data);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // 单个订阅者故障不影响其余。
      }
    }
  }

  private appendBuffer(data: string): void {
    this.buffer.push(data);
    this.bufferedBytes += data.length;
    while (this.bufferedBytes > RING_BUFFER_BYTES && this.buffer.length > 1) {
      this.bufferedBytes -= this.buffer[0]!.length;
      this.buffer.shift();
    }
  }
}

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number };

type PtyFactory = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyProcess;

async function loadPtyFactory(): Promise<PtyFactory | undefined> {
  try {
    const pty = (await import("node-pty")) as unknown as {
      spawn: PtyFactory;
    };
    return pty.spawn;
  } catch (error) {
    console.warn("node-pty unavailable; built-in terminal disabled:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** 平台默认 shell：Windows 用 PowerShell，其余跟随 $SHELL。 */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : "/bin/bash";
  return { file: shell, args: ["-l"] };
}

export class TerminalHub {
  private readonly sessions = new Map<string, TerminalSession>();
  private factoryPromise?: Promise<PtyFactory | undefined>;
  private factory?: PtyFactory;
  private factoryFailed = false;

  get available(): boolean {
    return this.factory !== undefined;
  }

  private async ensureFactory(): Promise<PtyFactory | undefined> {
    if (this.factory) return this.factory;
    if (this.factoryFailed) return undefined;
    this.factoryPromise ??= loadPtyFactory().then((factory) => {
      if (factory) this.factory = factory;
      else this.factoryFailed = true;
      return factory;
    });
    return this.factoryPromise;
  }

  async create(input: {
    cwd?: string;
    title?: string;
    projectId?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSessionInfo> {
    const factory = await this.ensureFactory();
    if (!factory) throw new Error("TERMINAL_UNAVAILABLE");

    const cols = Math.min(Math.max(Math.trunc(input.cols ?? 80), 10), 500);
    const rows = Math.min(Math.max(Math.trunc(input.rows ?? 24), 4), 200);
    const cwd = path.resolve(input.cwd?.trim() || (await getWorkspaceRoot()).path);
    const shell = defaultShell();

    const pty = factory(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    const session = new TerminalSession(
      pty,
      input.title?.trim() || `${shell.file} · ${path.basename(cwd)}`,
      cwd,
      cols,
      rows,
      input.projectId?.trim() || undefined,
    );
    this.sessions.set(session.id, session);
    return session.info();
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    return true;
  }

  /** 服务退出时杀掉全部终端进程。 */
  dispose(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}

export const terminalHub = new TerminalHub();
