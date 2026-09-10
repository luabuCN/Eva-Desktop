import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { extractDocumentTextFromBytes } from "../runtime/tools/document-extract.js";
import { buildWikiGraph } from "../wiki/wiki-graph.js";
import { readRawDocumentFile, syncAllScopesToDisk } from "../wiki/wiki-files.js";
import { parseScopeId, wikiService } from "../wiki/wiki-service.js";
import { isWikiPageType } from "../wiki/wiki-types.js";
import {
  getWikiSettings,
  updateWikiSettings,
  wikiQueue,
} from "../wiki/wiki-queue.js";

export const wikiRoutes = new Hono();

/** 单个上传文档的大小上限（与聊天附件同量级）。 */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** 原件服务的 Content-Type（按扩展名；缺省走通用二进制流）。 */
const FILE_CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};

/** 静态子路径需在 /:scopeId 之前注册（Hono 按注册顺序匹配）。 */

wikiRoutes.get("/scopes", async (c) => {
  return c.json({ scopes: await wikiService.listScopes() });
});

wikiRoutes.get("/settings", async (c) => {
  return c.json(await getWikiSettings());
});

const settingsUpdateSchema = z.object({
  autoIngest: z.boolean().optional(),
  defaultScope: z.string().min(1).optional(),
  /** null = 恢复默认镜像目录。 */
  storagePath: z.string().min(1).nullable().optional(),
  /** 语义检索 embedding 配置：两项都为 null = 关闭。 */
  embeddingProviderId: z.string().min(1).nullable().optional(),
  embeddingModelId: z.string().min(1).nullable().optional(),
});

wikiRoutes.put("/settings", async (c) => {
  const body = settingsUpdateSchema.parse(await c.req.json());
  try {
    return c.json(await updateWikiSettings(body));
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "设置保存失败" },
      400,
    );
  }
});

wikiRoutes.get("/jobs", async (c) => {
  const [stats, jobs] = await Promise.all([wikiQueue.stats(), wikiQueue.recentJobs()]);
  return c.json({
    stats,
    jobs: jobs.map((job) => {
      let filename: string | null = null;
      if (job.sourceKind === "document") {
        try {
          filename = (JSON.parse(job.payload) as { filename?: string }).filename ?? null;
        } catch {
          filename = null;
        }
      }
      return {
        id: job.id,
        scopeId: job.scopeId,
        conversationId: job.conversationId,
        sourceKind: job.sourceKind,
        filename,
        status: job.status,
        trigger: job.trigger,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
      };
    }),
  });
});

/** 重试失败的总结任务（全部 / 单条）。 */
wikiRoutes.post("/jobs/retry-failed", async (c) => {
  return c.json({ retried: await wikiQueue.retryFailedJobs() });
});

wikiRoutes.post("/jobs/:id/retry", async (c) => {
  const ok = await wikiQueue.retryJob(c.req.param("id"));
  if (!ok) return c.json({ error: "任务不存在或当前状态不可重试" }, 404);
  return c.json({ ok: true });
});

/** 手动重新同步磁盘镜像（修改存放路径后或怀疑镜像不同步时）。 */
wikiRoutes.post("/storage/resync", async (c) => {
  const synced = await syncAllScopesToDisk();
  return c.json({ ok: true, synced });
});

wikiRoutes.get("/:scopeId/tree", async (c) => {
  const scopeId = c.req.param("scopeId");
  const typeParam = c.req.query("type");
  const type = isWikiPageType(typeParam) ? typeParam : undefined;
  return c.json(await wikiService.treeFiltered(scopeId, type));
});

/** 原始二进制文件服务：预览（inline）/ 下载（?download=1）。
 * 按扩展名给 Content-Type；文件名用 RFC 5987 编码兼容中文。 */
wikiRoutes.get("/:scopeId/documents/:documentId/file", async (c) => {
  const scopeId = c.req.param("scopeId");
  const documentId = c.req.param("documentId");
  const document = await prisma.wikiDocument.findUnique({
    where: { id: documentId },
    select: { scopeId: true, filename: true, hasFile: true },
  });
  if (!document || document.scopeId !== scopeId || !document.hasFile) {
    return c.json({ error: "原文档不存在或未保存原件" }, 404);
  }
  const bytes = await readRawDocumentFile(scopeId, documentId, document.filename);
  if (!bytes) return c.json({ error: "原文档文件已丢失（可重新上传恢复）" }, 404);
  const dot = document.filename.lastIndexOf(".");
  const extension = dot >= 0 ? document.filename.slice(dot).toLowerCase() : "";
  const disposition = c.req.query("download") ? "attachment" : "inline";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": FILE_CONTENT_TYPES[extension] ?? "application/octet-stream",
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
      "cache-control": "no-store",
    },
  });
});

wikiRoutes.get("/:scopeId/page", async (c) => {
  const page = await wikiService.page(c.req.param("scopeId"), c.req.query("path") ?? "");
  return c.json({ page });
});

const pageSaveSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  type: z.string().refine(isWikiPageType).optional(),
  content: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

wikiRoutes.put("/:scopeId/page", async (c) => {
  const body = pageSaveSchema.parse(await c.req.json());
  const page = await wikiService.savePage(c.req.param("scopeId"), {
    ...body,
    meta: body.meta as Record<string, unknown> | undefined,
  });
  return c.json({ page });
});

wikiRoutes.delete("/:scopeId/page", async (c) => {
  await wikiService.deletePage(c.req.param("scopeId"), c.req.query("path") ?? "");
  return c.json({ ok: true });
});

/** 版本历史：某页面最近的修订快照。 */
wikiRoutes.get("/:scopeId/revisions", async (c) => {
  const revisions = await wikiService.listRevisions(
    c.req.param("scopeId"),
    c.req.query("path") ?? "",
  );
  return c.json({ revisions });
});

const revisionRestoreSchema = z.object({
  path: z.string().min(1),
  revisionId: z.string().min(1),
});

wikiRoutes.post("/:scopeId/revisions/restore", async (c) => {
  const body = revisionRestoreSchema.parse(await c.req.json());
  try {
    const page = await wikiService.restoreRevision(
      c.req.param("scopeId"),
      body.path,
      body.revisionId,
    );
    return c.json({ page });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "恢复失败" },
      400,
    );
  }
});

wikiRoutes.get("/:scopeId/graph", async (c) => {
  return c.json(await buildWikiGraph(c.req.param("scopeId")));
});

wikiRoutes.get("/:scopeId/search", async (c) => {
  const hits = await wikiService.search(
    c.req.param("scopeId"),
    c.req.query("q") ?? "",
  );
  return c.json({ hits });
});

/** 手动总结某个会话（对话里的「存入知识库」）：整段会话入队。 */
wikiRoutes.post("/:scopeId/ingest/conversations/:conversationId", async (c) => {
  const scopeId = c.req.param("scopeId");
  const conversationId = c.req.param("conversationId");
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, projectId: true },
  });
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const last = await prisma.storedMessage.findFirst({
    where: { conversationId, kind: "ui" },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  if (!last) return c.json({ error: "会话暂无消息" }, 400);
  await wikiQueue.enqueueTurn({
    conversationId,
    projectId: conversation.projectId,
    fromSeq: 0,
    toSeq: last.sequence + 1,
    trigger: "manual",
  });
  return c.json({ ok: true });
});

/** 手动上传文档解析入知识库：base64 → 提取文本 → 串行总结队列。 */
const documentUploadSchema = z.object({
  filename: z.string().min(1).max(200),
  contentBase64: z.string().min(1),
});

wikiRoutes.post("/:scopeId/ingest/document", async (c) => {
  const scopeId = c.req.param("scopeId");
  const body = documentUploadSchema.parse(await c.req.json());
  const bytes = Buffer.from(body.contentBase64, "base64");
  if (bytes.length === 0) return c.json({ error: "文件内容为空" }, 400);
  if (bytes.length > UPLOAD_MAX_BYTES) {
    return c.json({ error: "文件超过 20MB 上限" }, 400);
  }

  await wikiService.ensureScope(scopeId);
  let extracted: { text: string; truncated: boolean };
  try {
    extracted = await extractDocumentTextFromBytes(bytes, body.filename);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "文档解析失败" },
      400,
    );
  }
  if (!extracted.text.trim()) {
    return c.json(
      { error: "未能从文档提取到文本（扫描版 PDF 请先 OCR，或换用可复制文本的版本）" },
      400,
    );
  }

  const title = body.filename.replace(/\.[^.]+$/, "").trim() || body.filename;
  const parsed = parseScopeId(scopeId);
  // 原文档先落库（raw 层不可变，原始二进制一并落盘供原样预览），并立即
  // 建好「来源/原始资料」入口页——点击来源即可预览原件；LLM 总结完成后
  // 再回填摘要与关联实体。
  const document = await wikiService.saveRawDocument(scopeId, {
    filename: body.filename,
    title,
    text: extracted.text,
    truncated: extracted.truncated,
    bytes,
  });
  await wikiQueue.enqueueDocument({
    scopeId,
    projectId: parsed.kind === "project" ? parsed.projectId : null,
    documentId: document.id,
    filename: body.filename,
    title,
    text: extracted.text,
  });
  return c.json({ ok: true, chars: extracted.text.length, truncated: extracted.truncated });
});

/** 导入 Obsidian vault（zip 里的 .md 文件，与导出对偶）。 */
const vaultImportSchema = z.object({
  contentBase64: z.string().min(1),
});

wikiRoutes.post("/:scopeId/import", async (c) => {
  const scopeId = c.req.param("scopeId");
  const body = vaultImportSchema.parse(await c.req.json());
  const bytes = Buffer.from(body.contentBase64, "base64");
  if (bytes.length === 0) return c.json({ error: "文件内容为空" }, 400);
  if (bytes.length > 50 * 1024 * 1024) {
    return c.json({ error: "zip 超过 50MB 上限" }, 400);
  }
  try {
    const result = await wikiService.importVaultZip(scopeId, bytes);
    return c.json(result);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "导入失败（需要有效的 zip 文件）" },
      400,
    );
  }
});

/** 从历史会话构建整个知识库（项目 wiki 初次生成的入口）。 */
wikiRoutes.post("/:scopeId/rebuild", async (c) => {
  const enqueued = await wikiQueue.enqueueScopeRebuild(c.req.param("scopeId"));
  return c.json({ enqueued });
});

/** 导出为 Obsidian 兼容 vault（zip 下载）。 */
wikiRoutes.get("/:scopeId/export", async (c) => {
  const zip = await wikiService.exportZip(c.req.param("scopeId"));
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="wiki-${c.req.param("scopeId")}.zip"`,
    },
  });
});
