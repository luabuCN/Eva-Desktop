import path from "node:path";
import { SafeFsProvider } from "../../safe-fs.js";

export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1_024;
export const DEFAULT_MAX_LINE_LENGTH = 2_000;
export const MAX_WRITE_BYTES = 10 * 1_024 * 1_024;
export const SKIP_DIRS = new Set(["node_modules", ".git"]);
export const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".exe", ".dll",
  ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib", ".png", ".jpg",
  ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif", ".mp3",
  ".mp4", ".avi", ".mov", ".wav", ".flac", ".ogg", ".webm", ".mkv",
  ".pdf", ".wasm", ".class", ".jar", ".pyc", ".pyd", ".whl",
  ".ttf", ".otf", ".woff", ".woff2", ".eot", ".sqlite", ".db",
  // OOXML/Office 文档：readFile 走文本提取，但不能当普通文本改写。
  ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
]);

export async function walkDirectory(
  fsProvider: SafeFsProvider,
  root: string,
  current: string,
): Promise<Array<{ relativePath: string; isDirectory: boolean }>> {
  const entries = await fsProvider.readdir(current);
  const result: Array<{ relativePath: string; isDirectory: boolean }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    result.push({
      relativePath: path.relative(root, absolutePath).replaceAll("\\", "/"),
      isDirectory: entry.isDirectory,
    });
    if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
      result.push(...(await walkDirectory(fsProvider, root, absolutePath)));
    }
  }

  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function walkFiles(fsProvider: SafeFsProvider, root: string): Promise<string[]> {
  const directories = await walkDirectory(fsProvider, root, root);
  return directories
    .filter((entry) => !entry.isDirectory)
    .map((entry) => path.join(root, entry.relativePath));
}

export function paginate<T>(items: T[], offset?: number, limit?: number, byteLimit?: number) {
  const start = Math.max((offset ?? 1) - 1, 0);
  const cappedLimit = limit ?? DEFAULT_MAX_LINES;
  const limited: T[] = [];
  let bytes = 0;
  let truncated = false;

  for (const item of items.slice(start)) {
    if (limited.length >= cappedLimit) {
      truncated = true;
      break;
    }
    const itemBytes = byteLimit ? Buffer.byteLength(JSON.stringify(item), "utf8") : 0;
    if (byteLimit && bytes + itemBytes > byteLimit) {
      truncated = true;
      break;
    }
    bytes += itemBytes;
    limited.push(item);
  }

  return {
    items: limited,
    from: limited.length > 0 ? start + 1 : 0,
    to: start + limited.length,
    truncated,
  };
}

export function compileGlob(pattern: string): (filePath: string) => boolean {
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment === "**") return "(?:[^/]+/)*[^/]+";
      return segment
        .replaceAll(/[.+^${}()[\]\\]/g, "\\$&")
        .replaceAll("**", "\u0000")
        .replaceAll("*", "[^/]*")
        .replaceAll("\u0000", ".*")
        .replaceAll("?", "[^/]");
    })
    .join("/");
  const matcher = new RegExp(`^${source}$`);
  return (filePath) => matcher.test(filePath);
}

export function buildContinuationStatus(input: {
  total: number;
  shownThrough: number;
  truncated: boolean;
  continuationLabel: string;
  emptyMessage?: string;
}): string {
  if (input.total === 0) return input.emptyMessage ?? `No ${input.continuationLabel}.`;
  if (input.shownThrough < input.total || input.truncated) {
    return `Showing ${input.continuationLabel} through ${input.shownThrough} of ${input.total}. Continue with the next offset.`;
  }
  return `End of results -- ${input.total} ${input.continuationLabel} total.`;
}

export function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}... (line truncated at ${maxLength} chars)`;
}

export function isBinaryPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension !== "" && BINARY_EXTENSIONS.has(extension);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
