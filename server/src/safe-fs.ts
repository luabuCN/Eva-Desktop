import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 平台 shell 包装：与 SafeShellProvider.exec 共用同一 invocation，保证
 * 前台/后台命令的 shell 语义一致（PowerShell 的 LASTEXITCODE 透传等）。 */
export interface ShellInvocation {
  executable: string;
  args: string[];
}

export function shellInvocation(command: string): ShellInvocation {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          command,
          "if (Get-Variable LASTEXITCODE -ErrorAction Ignore) { exit $LASTEXITCODE }",
        ].join("\n"),
      ],
    };
  }

  return { executable: "bash", args: ["-c", command] };
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(
    readonly filePath: string,
    readonly fileSize: number,
    readonly maxSize: number,
  ) {
    super(
      `File too large: ${filePath} is ${formatBytes(fileSize)} (limit: ${formatBytes(maxSize)}). ` +
        `Use offset and limit parameters to read a portion of the file, or use grep to search it.`,
    );
    this.name = "FileTooLargeError";
  }
}

export class SafeFsProvider {
  private readonly root: string;
  private readonly maxFileSize: number;

  constructor(cwd: string, options?: { maxFileSize?: number }) {
    this.root = path.resolve(cwd);
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  }

  get cwd(): string {
    return this.root;
  }

  private assertInsideWorkspace(target: string): string {
    const resolved = path.resolve(this.root, target);
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Access denied outside workspace: ${resolved}`);
    }
    return resolved;
  }

  resolvePath(filePath: string): string {
    return this.assertInsideWorkspace(filePath);
  }

  async readFile(filePath: string): Promise<string> {
    const resolved = this.assertInsideWorkspace(filePath);
    const stat = await fs.stat(resolved);
    if (stat.size > this.maxFileSize) {
      throw new FileTooLargeError(resolved, stat.size, this.maxFileSize);
    }
    return fs.readFile(resolved, "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = this.assertInsideWorkspace(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.assertInsideWorkspace(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const stat = await fs.stat(this.assertInsideWorkspace(filePath));
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
    };
  }

  async readdir(dirPath: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(this.assertInsideWorkspace(dirPath), { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(this.assertInsideWorkspace(dirPath), { recursive: options?.recursive });
  }

  async remove(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    const resolved = this.assertInsideWorkspace(filePath);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      if (!options?.recursive) {
        throw new Error(`Path is a directory. Set recursive to true to delete it: ${resolved}`);
      }
      await fs.rm(resolved, { recursive: true });
      return;
    }
    await fs.unlink(resolved);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(this.assertInsideWorkspace(oldPath), this.assertInsideWorkspace(newPath));
  }
}

export class SafeShellProvider {
  private readonly cwd: string;
  private readonly maxStdout: number;
  private readonly maxStderr: number;

  constructor(cwd: string, options?: { maxStdout?: number; maxStderr?: number }) {
    this.cwd = path.resolve(cwd);
    this.maxStdout = options?.maxStdout ?? 50_000;
    this.maxStderr = options?.maxStderr ?? 10_000;
  }

  private invocation(command: string) {
    return shellInvocation(command);
  }

  exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<ShellResult> {
    return new Promise((resolve) => {
      const shell = this.invocation(command);
      const child = execFile(
        shell.executable,
        shell.args,
        {
          timeout: options?.timeout ?? 30_000,
          maxBuffer: 1024 * 1024,
          cwd: options?.cwd ?? this.cwd,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: truncateOutput(stdout, this.maxStdout),
            stderr: truncateOutput(stderr, this.maxStderr),
            exitCode: child.exitCode ?? (error ? 1 : 0),
          });
        },
      );
    });
  }
}

function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length - max} chars omitted)`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
