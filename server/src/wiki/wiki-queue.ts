import { prisma } from "../db.js";
import {
  DEFAULT_WIKI_SCOPE,
  parseScopeId,
  projectScopeId,
  wikiService,
} from "./wiki-service.js";
import {
  applyIngestResult,
  loadConversationTranscript,
  summarizeConversationToWiki,
  summarizeDocumentToWiki,
} from "./wiki-llm.js";

const AUTO_INGEST_KEY = "wiki.autoIngest";
const DEFAULT_SCOPE_KEY = "wiki.defaultScope";

export async function isAutoIngestEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_INGEST_KEY } });
  return row ? row.value !== "false" : true;
}

export async function setAutoIngestEnabled(enabled: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: AUTO_INGEST_KEY },
    create: { key: AUTO_INGEST_KEY, value: String(enabled) },
    update: { value: String(enabled) },
  });
}

/** 知识库全局设置（设置页「知识库」分区读写）。 */
export interface WikiSettings {
  autoIngest: boolean;
  /** 知识库页默认打开的 scope（默认空间或项目知识库）。 */
  defaultScope: string;
}

async function isValidScope(scopeId: string): Promise<boolean> {
  try {
    await wikiService.ensureScope(scopeId);
    return true;
  } catch {
    return false;
  }
}

export async function getWikiSettings(): Promise<WikiSettings> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [AUTO_INGEST_KEY, DEFAULT_SCOPE_KEY] } },
  });
  const autoIngestRow = rows.find((row) => row.key === AUTO_INGEST_KEY);
  const defaultScope = rows.find((row) => row.key === DEFAULT_SCOPE_KEY)?.value
    ?? DEFAULT_WIKI_SCOPE;
  return {
    autoIngest: autoIngestRow ? autoIngestRow.value !== "false" : true,
    defaultScope: (await isValidScope(defaultScope)) ? defaultScope : DEFAULT_WIKI_SCOPE,
  };
}

export async function updateWikiSettings(
  input: { autoIngest?: boolean; defaultScope?: string },
): Promise<WikiSettings> {
  if (input.autoIngest !== undefined) await setAutoIngestEnabled(input.autoIngest);
  if (input.defaultScope !== undefined) {
    if (!(await isValidScope(input.defaultScope))) {
      throw new Error("默认知识库不存在（项目可能已被删除或归档）");
    }
    await prisma.appSetting.upsert({
      where: { key: DEFAULT_SCOPE_KEY },
      create: { key: DEFAULT_SCOPE_KEY, value: input.defaultScope },
      update: { value: input.defaultScope },
    });
  }
  return getWikiSettings();
}

export interface EnqueueTurnInput {
  conversationId: string;
  projectId?: string | null;
  /** ui 快照 sequence 区间 [fromSeq, toSeq)。 */
  fromSeq: number;
  toSeq: number;
  trigger: "auto" | "manual" | "rebuild";
}

/**
 * 串行总结队列：对话回合完成后入队，后台逐条消费。
 * 同一会话已有 queued 任务时合并（窗口取并集）——连续多轮对话只触发
 * 一次 LLM 总结，既省 token 也让页面合并更连贯。
 */
class WikiIngestQueue {
  private pumping = false;

  async enqueueTurn(input: EnqueueTurnInput): Promise<void> {
    if (input.toSeq <= input.fromSeq && input.trigger !== "manual") return;
    const scopeId = input.projectId ? projectScopeId(input.projectId) : DEFAULT_WIKI_SCOPE;

    const pending = await prisma.wikiIngestJob.findFirst({
      where: {
        conversationId: input.conversationId,
        sourceKind: "conversation",
        status: { in: ["queued", "processing"] },
      },
      orderBy: { createdAt: "asc" },
    });
    if (pending) {
      await prisma.wikiIngestJob.update({
        where: { id: pending.id },
        data: {
          scopeId,
          projectId: input.projectId ?? null,
          fromSeq: Math.min(pending.fromSeq, input.fromSeq),
          toSeq: Math.max(pending.toSeq, input.toSeq),
          updatedAt: new Date(),
        },
      });
    } else {
      await prisma.wikiIngestJob.create({
        data: {
          scopeId,
          conversationId: input.conversationId,
          projectId: input.projectId ?? null,
          fromSeq: input.fromSeq,
          toSeq: input.toSeq,
          trigger: input.trigger,
        },
      });
    }
    void this.pump();
  }

  /** 手动上传文档入队：原文档已先经 saveRawDocument 落库（documentId 关联），
   * payload 携带提取文本，串行总结为 wiki 页面。 */
  async enqueueDocument(input: {
    scopeId: string;
    projectId?: string | null;
    documentId?: string;
    filename: string;
    title: string;
    text: string;
  }): Promise<void> {
    await prisma.wikiIngestJob.create({
      data: {
        scopeId: input.scopeId,
        conversationId: "",
        projectId: input.projectId ?? null,
        sourceKind: "document",
        payload: JSON.stringify({
          documentId: input.documentId,
          filename: input.filename,
          title: input.title,
          text: input.text,
        }),
        trigger: "upload",
      },
    });
    void this.pump();
  }

  /** 为某个知识库批量入队全部历史会话（初次构建项目 wiki 用）。 */  async enqueueScopeRebuild(scopeId: string): Promise<number> {
    const parsed = parseScopeId(scopeId);
    const projectId = parsed.kind === "project" ? parsed.projectId : null;
    const conversations = await prisma.conversation.findMany({
      where: {
        archivedAt: null,
        ...(projectId ? { projectId } : { projectId: null }),
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
    });
    let enqueued = 0;
    for (const conversation of conversations) {
      const last = await prisma.storedMessage.findFirst({
        where: { conversationId: conversation.id, kind: "ui" },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      if (!last) continue;
      await prisma.wikiIngestJob.create({
        data: {
          scopeId,
          conversationId: conversation.id,
          projectId,
          fromSeq: 0,
          toSeq: last.sequence + 1,
          trigger: "rebuild",
        },
      });
      enqueued += 1;
    }
    void this.pump();
    return enqueued;
  }

  async stats(): Promise<{ queued: number; processing: number; failedRecent: number }> {
    const [queued, processing, failedRecent] = await Promise.all([
      prisma.wikiIngestJob.count({ where: { status: "queued" } }),
      prisma.wikiIngestJob.count({ where: { status: "processing" } }),
      prisma.wikiIngestJob.count({
        where: { status: "failed", createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      }),
    ]);
    return { queued, processing, failedRecent };
  }

  async recentJobs(limit = 20) {
    return prisma.wikiIngestJob.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async init(): Promise<void> {
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = await prisma.wikiIngestJob.findFirst({
          where: { status: "queued" },
          orderBy: { createdAt: "asc" },
        });
        if (!job) break;
        await this.runJob(job.id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const claimed = await prisma.wikiIngestJob.updateMany({
      where: { id: jobId, status: "queued" },
      data: { status: "processing", updatedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const job = await prisma.wikiIngestJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    try {
      let projectName = "默认工作区";
      if (job.projectId) {
        const project = await prisma.project.findUnique({
          where: { id: job.projectId },
          select: { name: true },
        });
        if (project) projectName = project.name;
      }

      if (job.sourceKind === "document") {
        // 手动上传文档：payload 携带提取文本，直接交给文档总结。
        const payload = JSON.parse(job.payload) as {
          documentId?: string;
          filename?: string;
          title?: string;
          text?: string;
        };
        const filename = payload.filename ?? "未命名文档";
        if (!payload.text?.trim()) {
          await prisma.wikiIngestJob.update({
            where: { id: jobId },
            data: {
              status: "failed",
              completedAt: new Date(),
              error: "文档未提取到文本（扫描版 PDF 请先 OCR）",
            },
          });
          return;
        }
        const result = await summarizeDocumentToWiki({
          scopeId: job.scopeId,
          filename,
          title: payload.title ?? filename,
          text: payload.text,
        });
        await applyIngestResult({
          scopeId: job.scopeId,
          projectName,
          origin: {
            kind: "document",
            filename,
            title: payload.title ?? filename,
            documentId: payload.documentId,
          },
          result,
        });
        await prisma.wikiIngestJob.update({
          where: { id: jobId },
          data: { status: "completed", completedAt: new Date(), error: null },
        });
        return;
      }

      const transcript = await loadConversationTranscript(
        job.conversationId,
        job.fromSeq,
        job.toSeq,
      );
      if (!transcript || !transcript.transcript.trim()) {
        await prisma.wikiIngestJob.update({
          where: { id: jobId },
          data: { status: "completed", completedAt: new Date(), error: null },
        });
        return;
      }

      const result = await summarizeConversationToWiki({
        scopeId: job.scopeId,
        transcript: transcript.transcript,
        conversationTitle: transcript.title,
        conversationId: job.conversationId,
      });
      await applyIngestResult({
        scopeId: job.scopeId,
        projectName,
        origin: {
          kind: "conversation",
          conversationId: job.conversationId,
          conversationTitle: transcript.title,
        },
        result,
      });
      await prisma.wikiIngestJob.update({
        where: { id: jobId },
        data: { status: "completed", completedAt: new Date(), error: null },
      });
    } catch (error) {
      await prisma.wikiIngestJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      });
    }
  }
}

export const wikiQueue = new WikiIngestQueue();
