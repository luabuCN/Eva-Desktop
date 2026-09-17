import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { SafeFsProvider, SafeShellProvider } from "../../safe-fs.js";
import { recordFileChange, type FileEditSummary } from "../file-changes.js";
import { detectLiveServerUrl, looksLikeDevServer, startDevServer } from "../dev-server.js";
import { buildPreviewUrl } from "../preview-url.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RunContext } from "./run-context.js";
import type { RuntimeTool } from "./types.js";
import { formatBytes, isBinaryPath, MAX_WRITE_BYTES } from "./fs-utils.js";

/** Shape edit tools return on success: compact for the model, plus the diff
 * the chat UI renders. before/after snapshots live on the FileChange row. */
function editOutput(summary: FileEditSummary, extra: Record<string, unknown>) {
  return {
    path: summary.path,
    changeKind: summary.changeKind,
    additions: summary.additions,
    deletions: summary.deletions,
    unifiedDiff: summary.unifiedDiff,
    ...extra,
  };
}

/** 生成 HTML 页面后请求面板预览；写文件成功后再通知，保证 iframe 拿到的
 * 是新内容。其他扩展名不推送，避免把代码文件当页面打开。 */
function notifyHtmlPreview(run: RunContext, absolutePath: string, label: string) {
  if (!/\.html?$/i.test(absolutePath)) return;
  run.notifyPreview?.({ url: buildPreviewUrl(absolutePath), kind: "file", label });
}

function createWriteFileTool(fsProvider: SafeFsProvider, run: RunContext): RuntimeTool {
  return createTool({
    id: "writeFile",
    description:
      "Create a UTF-8 text file or completely replace an existing one. Prefer editFile for small changes.",
    inputSchema: z.object({
      filePath: z.string().min(1),
      content: z.string().describe("The full file contents to write"),
    }),
    execute: async ({ filePath, content }) => {
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        return { error: `Content exceeds the ${formatBytes(MAX_WRITE_BYTES)} write limit.` };
      }
      const resolved = fsProvider.resolvePath(filePath);
      const binary = isBinaryPath(resolved);
      const existed = await fsProvider.exists(resolved);
      const before = binary || !existed ? null : await fsProvider.readFile(resolved).catch(() => null);
      await fsProvider.writeFile(resolved, content);
      const summary = await recordFileChange({
        runId: run.runId,
        conversationId: run.conversationId,
        projectId: run.projectId,
        workspacePath: run.workspacePath,
        absolutePath: resolved,
        before,
        after: binary ? null : content,
        existed,
      });
      notifyHtmlPreview(run, resolved, summary.path);
      return editOutput(summary, {
        filePath: resolved,
        bytesWritten: Buffer.byteLength(content, "utf8"),
        lines: content.split("\n").length,
      });
    },
  });
}

function createEditFileTool(fsProvider: SafeFsProvider, run: RunContext): RuntimeTool {  return createTool({
    id: "editFile",
    description:
      "Replace exact occurrences in a UTF-8 text file. Include enough surrounding text to make replacements unambiguous.",
    inputSchema: z.object({
      filePath: z.string().min(1),
      oldString: z.string().min(1),
      newString: z.string(),
      expectedReplacements: z.number().int().min(1).max(100).optional()
        .describe("Number of exact occurrences to replace; defaults to 1"),
    }),
    execute: async ({ filePath, oldString, newString, expectedReplacements = 1 }) => {
      const resolved = fsProvider.resolvePath(filePath);
      if (isBinaryPath(resolved)) return { error: "editFile cannot modify binary files." };
      const original = await fsProvider.readFile(resolved).catch(() => null);
      if (original === null) return { error: `File does not exist or cannot be read: ${resolved}` };

      const occurrences = original.split(oldString).length - 1;
      if (occurrences === 0) return { error: "oldString was not found." };
      if (occurrences !== expectedReplacements) {
        return {
          error: `oldString matched ${occurrences} time(s), expected ${expectedReplacements}. Add surrounding context.`,
          occurrences,
        };
      }

      const updated =
        expectedReplacements === 1
          ? original.replace(oldString, () => newString)
          : original.replaceAll(oldString, () => newString);
      if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
        return { error: `Updated file exceeds the ${formatBytes(MAX_WRITE_BYTES)} limit.` };
      }

      await fsProvider.writeFile(resolved, updated);
      const summary = await recordFileChange({
        runId: run.runId,
        conversationId: run.conversationId,
        projectId: run.projectId,
        workspacePath: run.workspacePath,
        absolutePath: resolved,
        before: original,
        after: updated,
        existed: true,
      });
      notifyHtmlPreview(run, resolved, summary.path);
      return editOutput(summary, {
        filePath: resolved,
        replacements: expectedReplacements,
        oldLength: Buffer.byteLength(original, "utf8"),
        newLength: Buffer.byteLength(updated, "utf8"),
      });
    },
  });
}

function createMkdirTool(fsProvider: SafeFsProvider): RuntimeTool {
  return createTool({
    id: "mkdir",
    description: "Create a directory and missing parent directories.",
    inputSchema: z.object({ dirPath: z.string().min(1) }),
    execute: async ({ dirPath }) => {
      const resolved = fsProvider.resolvePath(dirPath);
      await fsProvider.mkdir(resolved, { recursive: true });
      return { dirPath: resolved };
    },
  });
}

function createBashTool(rootPath: string, run: RunContext): RuntimeTool {
  const shellProvider = new SafeShellProvider(rootPath);
  return createTool({
    id: "bash",
    description:
      "Execute a shell command in the project workspace. Any file the command produces " +
      "(documents, images, archives, builds) must be written inside the workspace root, " +
      "never to the Desktop, home directory, or other outside locations. " +
      "Read-only commands (git status/diff/log, ls, grep, ...) and allowlisted command rules run without asking; everything else waits for explicit user approval. Uses PowerShell on Windows and Bash elsewhere. Dev-server style commands (pnpm dev, npm start, vite, python -m http.server, ...) are started in the background instead of blocking, and their URL is reported back. " +
      "Set runInBackground=true for long-running setup commands (dependency installs: pnpm/npm/yarn/bun install or add, pip install, cargo fetch; big builds) — the command starts as a background task and this returns a taskId immediately so you can continue editing files in parallel. Before running anything that depends on such a command (dev/build/test/import), you MUST call bashTaskOutput with block=true and confirm it succeeded. Never end the turn with a failed-or-unknown background task: converge on each one before finishing.",
    inputSchema: z.object({
      command: z.string().min(1),
      timeout: z.number().int().min(1_000).max(300_000).optional().default(30_000),
      runInBackground: z
        .boolean()
        .optional()
        .describe("Run detached and return a taskId immediately instead of blocking on completion."),
    }),
    execute: async ({ command, timeout, runInBackground }) => {
      // 开发服务器类命令会一直运行，阻塞式执行只会等到超时被杀；
      // 改为后台拉起并探测访问地址，成功后在内置浏览器面板中打开。
      if (looksLikeDevServer(command)) {
        const started = await startDevServer({ command, cwd: rootPath });
        if (started.url) {
          run.notifyPreview?.({ url: started.url, kind: "server", label: command.slice(0, 80) });
        }
        return started;
      }
      // 依赖安装/构建类长命令：转后台任务立即返回，主循环继续写代码，
      // 结果稍后经 bashTaskOutput 收敛（详见工具描述里的使用规范）。
      if (runInBackground && run.backgroundTasks) {
        const started = await run.backgroundTasks.start({
          command,
          cwd: rootPath,
          conversationId: run.conversationId,
        });
        if (!started.ok) return { error: started.error };
        return {
          taskId: started.taskId,
          status: "running",
          mode: "background",
          message:
            `Background task ${started.taskId} started; the command keeps running while you work. ` +
            "Continue with independent edits now, then call bashTaskOutput with block=true to get the result. " +
            "Do NOT run commands that depend on this one (dev/build/test/import) until bashTaskOutput reports success.",
        };
      }
      const result = await shellProvider.exec(command, { timeout });
      // 兜底：前台命令的输出里报出了 localhost 地址且端口确实在监听
      // （比如通过自建脚本/批处理启动的服务），同样请求面板预览。
      const liveUrl = await detectLiveServerUrl(`${result.stdout}\n${result.stderr}`);
      if (liveUrl) {
        run.notifyPreview?.({ url: liveUrl, kind: "server", label: command.slice(0, 80) });
      }
      return result;
    },
  });
}

/** bashTask* 三件套：查询/等待/停止后台 shell 任务。镜像 Delegate 家族——
 * 工具只做参数编排，进程注册表在 BackgroundTaskHub。 */
function createBashTaskTools(run: RunContext): Record<string, RuntimeTool> {
  const hub = run.backgroundTasks;
  if (!hub) return {};

  const bashTaskOutput: RuntimeTool = createTool({
    id: "bashTaskOutput",
    description:
      "Fetch the status and output of a background task started by bash(runInBackground=true). " +
      "`taskId` defaults to the most recent task of this conversation. With block=true it waits for completion " +
      "(timeoutSeconds, default 60, max 600) — waiting past the timeout is not a failure, just call again. " +
      "Check every background task this way before running commands that depend on it, and before ending the turn.",
    inputSchema: z.object({
      taskId: z.string().optional().describe("Defaults to the most recent background task."),
      block: z.boolean().optional().describe("Wait for completion instead of returning immediately."),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    }),
    execute: async ({ taskId, block, timeoutSeconds }) => {
      const result = await hub.output({
        taskId,
        conversationId: run.conversationId,
        block,
        timeoutSeconds,
      });
      if (!result.ok) return { error: result.error };
      const task = result.task;
      const parts = [
        `# ${task.taskId} — ${task.status}` +
          (task.exitCode !== undefined ? ` (exit ${task.exitCode})` : "") +
          ` · ${Math.round(result.durationMs / 1000)}s`,
        result.note,
        task.stdoutTail ? `\nstdout (tail):\n${task.stdoutTail}` : "",
        task.stderrTail ? `\nstderr (tail):\n${task.stderrTail}` : "",
        task.error ? `\nerror: ${task.error}` : "",
      ].filter((part) => part && part.trim());
      return { ...task, durationMs: result.durationMs, note: result.note, summary: parts.join("\n") };
    },
  });

  const bashTaskList: RuntimeTool = createTool({
    id: "bashTaskList",
    description:
      "List this conversation's background shell tasks with their status. Use it to check progress without waiting, or to pick a taskId before bashTaskOutput/bashTaskStop.",
    inputSchema: z.object({}),
    execute: async () => {
      const records = hub.list(run.conversationId);
      if (records.length === 0) {
        return { tasks: [], summary: "No background tasks have been started in this conversation." };
      }
      return {
        tasks: records.map((record) => ({
          taskId: record.taskId,
          command: record.command.slice(0, 120),
          status: record.status,
          exitCode: record.exitCode,
        })),
        summary: records
          .map(
            (record) =>
              `- ${record.taskId} [${record.status}${
                record.exitCode !== undefined ? ` exit ${record.exitCode}` : ""
              }] ${record.command.slice(0, 80)}`,
          )
          .join("\n"),
      };
    },
  });

  const bashTaskStop: RuntimeTool = createTool({
    id: "bashTaskStop",
    description:
      "Stop one or more running background shell tasks. `taskIds` defaults to every running task of this conversation. Stopped tasks report as stopped.",
    inputSchema: z.object({
      taskIds: z.array(z.string()).optional().describe("Defaults to all running background tasks."),
    }),
    execute: async ({ taskIds }) => {
      const stopped = hub.stop(taskIds, run.conversationId);
      return {
        stopped,
        message:
          stopped === 0
            ? "No matching running background tasks."
            : `Stopped ${stopped} background task${stopped === 1 ? "" : "s"}.`,
      };
    },
  });

  return { bashTaskOutput, bashTaskList, bashTaskStop };
}

/** Tools that mutate the project workspace. Approval gating is applied by the
 * registry wrapper, so providers here stay policy-free. */
export class WorkspaceToolProvider implements ToolProvider {
  readonly id = "workspace";
  readonly label = "工作区工具";

  listTools(): ToolDescriptor[] {
    return [
      {
        name: "writeFile",
        label: "Write file",
        description: "Create or replace a text file in the workspace.",
        risk: "high",
        mutating: true,
        defaultPolicy: { enabled: true, requireApproval: true },
        providerId: this.id,
      },
      {
        name: "editFile",
        label: "Edit file",
        description: "Replace exact text in an existing file.",
        risk: "high",
        mutating: true,
        defaultPolicy: { enabled: true, requireApproval: true },
        providerId: this.id,
      },
      {
        name: "mkdir",
        label: "Make directory",
        description: "Create a directory and its parents.",
        risk: "medium",
        mutating: true,
        defaultPolicy: { enabled: true, requireApproval: true },
        providerId: this.id,
      },
      {
        name: "bash",
        label: "Shell",
        description: "Run a shell command in the project workspace.",
        risk: "high",
        mutating: true,
        defaultPolicy: { enabled: true, requireApproval: true },
        providerId: this.id,
      },
      {
        name: "bashTaskOutput",
        label: "Background task output",
        description: "Fetch or wait for a background shell task's result.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
      {
        name: "bashTaskList",
        label: "Background task list",
        description: "List background shell tasks with their status.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
      {
        name: "bashTaskStop",
        label: "Background task stop",
        description: "Stop running background shell tasks.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    const fsProvider = new SafeFsProvider(run.workspacePath);
    return {
      writeFile: createWriteFileTool(fsProvider, run),
      editFile: createEditFileTool(fsProvider, run),
      mkdir: createMkdirTool(fsProvider),
      bash: createBashTool(run.workspacePath, run),
      ...createBashTaskTools(run),
    };
  }
}
