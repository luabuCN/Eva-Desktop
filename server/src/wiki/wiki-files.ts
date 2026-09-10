import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { dataDir } from "../env.js";

/**
 * 知识库磁盘镜像：所有 scope 的页面实时写成 Markdown 文件（Obsidian 兼容），
 * 与 zip 导出同构（YAML frontmatter + 正文；来源页写原文档全文）。
 *
 * - 默认目录 dataDir/wiki，可在设置中改为任意文件夹（如 Obsidian vault）；
 *   每个 scope 一个子文件夹（default / p-<projectId>）。
 * - 镜像只新增与覆盖，绝不批量删除目录内文件（目标文件夹可能混有用户自己的
 *   笔记）；页面删除只删对应的那一个镜像文件。
 * - 同步失败只记日志，绝不影响知识库本身的读写。
 */

const STORAGE_PATH_KEY = "wiki.storagePath";
/** 落盘防抖（ms）：一轮总结会连写多个页面 + index/log/overview 派生页。 */
const SYNC_DEBOUNCE_MS = 1_500;

export function defaultStoragePath(): string {
  return path.join(dataDir, "wiki");
}

// ---------------------------------------------------------------------------
// 原始二进制文件（raw/sources 层原件）：提取文本入库之外，把上传的原文件
// 完整落盘到 dataDir/wiki-raw/<scope>/<documentId><ext>，支持原样预览/下载。
// 原件不可变：同名覆盖上传时按 documentId 原地覆盖。
// ---------------------------------------------------------------------------

/** 原始文件根目录（固定在数据目录，不跟随可配置的镜像目录）。 */
export function rawDocumentRoot(): string {
  return path.join(dataDir, "wiki-raw");
}

/** 原始文件落盘路径：<root>/<scopeDir>/<documentId><ext>（ext 取自上传文件名）。 */
export function rawDocumentFilePath(
  scopeId: string,
  documentId: string,
  filename: string,
): string {
  const ext = path.extname(filename).toLowerCase();
  return path.join(rawDocumentRoot(), scopeDirName(scopeId), `${documentId}${ext}`);
}

/** 写入原始文件并返回字节数；失败抛错由调用方决定是否阻断上传。 */
export async function saveRawDocumentFile(
  scopeId: string,
  documentId: string,
  filename: string,
  bytes: Buffer,
): Promise<void> {
  const file = rawDocumentFilePath(scopeId, documentId, filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}

/** 读取原始文件；不存在返回 null（旧数据未存原件）。 */
export async function readRawDocumentFile(
  scopeId: string,
  documentId: string,
  filename: string,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(rawDocumentFilePath(scopeId, documentId, filename));
  } catch {
    return null;
  }
}

/** 删除原始文件（best-effort，文档删除时调用）。 */
export async function deleteRawDocumentFile(
  scopeId: string,
  documentId: string,
  filename: string,
): Promise<void> {
  try {
    await fs.rm(rawDocumentFilePath(scopeId, documentId, filename), { force: true });
  } catch (error) {
    console.error("wiki raw document file remove failed", error);
  }
}

/** 原件镜像到用户镜像目录的 raw/sources/ 下（llm-wiki 布局，与导出 zip 同构）。 */
function mirrorRawDocumentPath(root: string, scopeId: string, filename: string): string {
  return path.join(root, scopeDirName(scopeId), "raw", "sources", sanitizeSegment(filename));
}

/** 把原件补齐到镜像目录（已存在则跳过；改镜像路径/手动重同步后对齐用）。 */
async function syncRawDocumentsToMirror(root: string, scopeId: string): Promise<void> {
  const documents = await prisma.wikiDocument.findMany({
    where: { scopeId, hasFile: true },
    select: { id: true, filename: true },
  });
  for (const document of documents) {
    const mirror = mirrorRawDocumentPath(root, scopeId, document.filename);
    try {
      await fs.access(mirror);
    } catch {
      const bytes = await readRawDocumentFile(scopeId, document.id, document.filename);
      if (!bytes) continue;
      await fs.mkdir(path.dirname(mirror), { recursive: true });
      await fs.writeFile(mirror, bytes);
    }
  }
}

/** 删除镜像目录里的原件（文档删除时调用；best-effort）。 */
export async function removeMirroredRawDocument(scopeId: string, filename: string): Promise<void> {
  try {
    const root = await getWikiStoragePath();
    await fs.rm(mirrorRawDocumentPath(root, scopeId, filename), { force: true });
  } catch (error) {
    console.error("wiki raw document mirror remove failed", error);
  }
}

/** scope 目录名："default" 原样；"p:<id>" 转为文件系统安全的 "p-<id>"。 */
export function scopeDirName(scopeId: string): string {
  return scopeId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** 单段路径清理：去掉 Windows 保留字符与结尾的点/空格。 */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/, "").trim();
  return cleaned || "_";
}

export async function getWikiStoragePath(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: STORAGE_PATH_KEY } });
  return row?.value?.trim() ? row.value.trim() : defaultStoragePath();
}

/** 校验并保存镜像根目录：必须能创建并写入（探针文件写入后删除）。 */
export async function setWikiStoragePath(input: string): Promise<string> {
  const resolved = path.resolve(input.trim());
  if (!path.isAbsolute(resolved)) throw new Error("路径必须是绝对路径");
  await fs.mkdir(resolved, { recursive: true });
  const probe = path.join(resolved, `.openharness-wiki-probe-${Date.now()}`);
  await fs.writeFile(probe, "ok", "utf8");
  await fs.rm(probe, { force: true });
  await prisma.appSetting.upsert({
    where: { key: STORAGE_PATH_KEY },
    create: { key: STORAGE_PATH_KEY, value: resolved },
    update: { value: resolved },
  });
  return resolved;
}

/** 恢复默认镜像目录（dataDir/wiki）。 */
export async function resetWikiStoragePath(): Promise<string> {
  await prisma.appSetting.deleteMany({ where: { key: STORAGE_PATH_KEY } });
  return defaultStoragePath();
}

function parseMetaObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 页面 → 单个 Markdown 文件内容（frontmatter + 正文），zip 导出与磁盘镜像共用。 */
export function buildPageFileContent(
  row: {
    title: string;
    type: string;
    content: string;
    meta: string;
    updatedAt: Date;
  },
  rawDocument: { filename: string; text: string } | null,
): string {
  const meta = parseMetaObject(row.meta);
  const tags = Array.isArray(meta.tags) ? (meta.tags as unknown[]) : [];
  const sources = Array.isArray(meta.sources) ? (meta.sources as unknown[]) : [];
  const summary =
    typeof meta.summary === "string" ? meta.summary : rawDocument ? row.content : undefined;
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(row.title)}`,
    `type: ${row.type}`,
    ...(tags.length ? [`tags: [${tags.map((tag) => JSON.stringify(String(tag))).join(", ")}]`] : []),
    ...(sources.length
      ? [`sources: [${sources.map((source) => JSON.stringify(String(source))).join(", ")}]`]
      : []),
    ...(summary ? [`summary: ${JSON.stringify(summary)}`] : []),
    ...(rawDocument ? [`filename: ${JSON.stringify(rawDocument.filename)}`] : []),
    `updated: ${row.updatedAt.toISOString()}`,
    "---",
    "",
  ].join("\n");
  const body = rawDocument?.text ?? row.content;
  return `${frontmatter}${body}\n`;
}

/** 来源页有关联原文档时取其 filename/text（正文写原文）。 */
async function rawDocumentFor(row: {
  type: string;
  meta: string;
}): Promise<{ filename: string; text: string } | null> {
  if (row.type !== "source") return null;
  const meta = parseMetaObject(row.meta);
  if (typeof meta.documentId !== "string" || !meta.documentId) return null;
  const document = await prisma.wikiDocument.findUnique({
    where: { id: meta.documentId },
    select: { filename: true, text: true },
  });
  return document ?? null;
}

function mirrorFilePath(root: string, scopeId: string, pagePath: string): string {
  const segments = pagePath.split("/").map(sanitizeSegment);
  return path.join(root, scopeDirName(scopeId), ...segments);
}

/** 写单个页面的镜像文件（不存在镜像根目录时为 no-op 由调用方保证）。 */
async function writePageFile(
  root: string,
  scopeId: string,
  row: { path: string; title: string; type: string; content: string; meta: string; updatedAt: Date },
): Promise<void> {
  const rawDocument = await rawDocumentFor(row);
  const file = mirrorFilePath(root, scopeId, row.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buildPageFileContent(row, rawDocument), "utf8");
}

/** 全量镜像一个 scope（只增改不删除），返回写入的页面数。 */
export async function syncScopeToDisk(scopeId: string): Promise<number> {
  const root = await getWikiStoragePath();
  const pages = await prisma.wikiPage.findMany({ where: { scopeId } });
  for (const row of pages) await writePageFile(root, scopeId, row);
  // 原件补齐到镜像 raw/sources/（已存在则跳过，开销极小）。
  await syncRawDocumentsToMirror(root, scopeId).catch(() => undefined);
  return pages.length;
}

/** 同步所有存在页面的 scope（改路径 / 手动重同步用）。 */
export async function syncAllScopesToDisk(): Promise<number> {
  const scopes = await prisma.wikiPage.groupBy({ by: ["scopeId"] });
  let total = 0;
  for (const scope of scopes) total += await syncScopeToDisk(scope.scopeId);
  return total;
}

/** 防抖调度一次 scope 全量镜像；任何写库路径之后调用都安全（可重复）。 */
export function scheduleScopeSync(scopeId: string): void {
  const existing = scopeSyncTimers.get(scopeId);
  if (existing) clearTimeout(existing);
  scopeSyncTimers.set(
    scopeId,
    setTimeout(() => {
      scopeSyncTimers.delete(scopeId);
      syncScopeToDisk(scopeId).catch((error: unknown) =>
        console.error(`wiki disk sync failed (${scopeId})`, error),
      );
    }, SYNC_DEBOUNCE_MS),
  );
}

const scopeSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 删除单个页面的镜像文件（页面删除时调用；best-effort）。 */
export async function removePageFromDisk(scopeId: string, pagePath: string): Promise<void> {
  try {
    const root = await getWikiStoragePath();
    await fs.rm(mirrorFilePath(root, scopeId, pagePath), { force: true });
  } catch (error) {
    console.error("wiki disk mirror remove failed", error);
  }
}

/** 删除整个 scope 的镜像目录（项目删除时调用；目录由应用管理）。 */
export async function removeScopeFromDisk(scopeId: string): Promise<void> {
  try {
    const root = await getWikiStoragePath();
    await fs.rm(path.join(root, scopeDirName(scopeId)), { recursive: true, force: true });
  } catch (error) {
    console.error("wiki disk mirror scope remove failed", error);
  }
}
