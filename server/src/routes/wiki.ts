import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { extractDocumentTextFromBytes } from "../runtime/tools/document-extract.js";
import { buildWikiGraph } from "../wiki/wiki-graph.js";
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

wikiRoutes.get("/:scopeId/tree", async (c) => {
  const scopeId = c.req.param("scopeId");
  const typeParam = c.req.query("type");
  const type = isWikiPageType(typeParam) ? typeParam : undefined;
  return c.json(await wikiService.treeFiltered(scopeId, type));
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
  // 原文档先落库（raw 层不可变），并立即建好「来源/原始资料」入口页——
  // 点击来源看到的就是原文；LLM 总结完成后再回填摘要与关联实体。
  const document = await wikiService.saveRawDocument(scopeId, {
    filename: body.filename,
    title,
    text: extracted.text,
    truncated: extracted.truncated,
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
