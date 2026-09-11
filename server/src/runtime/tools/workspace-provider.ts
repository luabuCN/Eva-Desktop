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
      "Execute a shell command in the project workspace. Read-only commands (git status/diff/log, ls, grep, ...) and allowlisted command rules run without asking; everything else waits for explicit user approval. Uses PowerShell on Windows and Bash elsewhere. Dev-server style commands (pnpm dev, npm start, vite, python -m http.server, ...) are started in the background instead of blocking, and their URL is reported back.",
    inputSchema: z.object({
      command: z.string().min(1),
      timeout: z.number().int().min(1_000).max(300_000).optional().default(30_000),
    }),
    execute: async ({ command, timeout }) => {
      // 开发服务器类命令会一直运行，阻塞式执行只会等到超时被杀；
      // 改为后台拉起并探测访问地址，成功后在内置浏览器面板中打开。
      if (looksLikeDevServer(command)) {
        const started = await startDevServer({ command, cwd: rootPath });
        if (started.url) {
          run.notifyPreview?.({ url: started.url, kind: "server", label: command.slice(0, 80) });
        }
        return started;
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
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    const fsProvider = new SafeFsProvider(run.workspacePath);
    return {
      writeFile: createWriteFileTool(fsProvider, run),
      editFile: createEditFileTool(fsProvider, run),
      mkdir: createMkdirTool(fsProvider),
      bash: createBashTool(run.workspacePath, run),
    };
  }
}
