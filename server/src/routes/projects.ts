import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { removeScopeFromDisk } from "../wiki/wiki-files.js";
import { projectScopeId } from "../wiki/wiki-service.js";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  rootPath: z.string().trim().min(1),
  description: z.string().trim().max(500).optional(),
  defaultAgentId: z.string().trim().min(1).max(100).nullable().optional(),
  defaultProviderId: z.string().trim().min(1).nullable().optional(),
  defaultModelId: z.string().trim().min(1).max(200).nullable().optional(),
  /** 项目级对话自动总结开关：null = 跟随全局设置。 */
  wikiAutoIngest: z.boolean().nullable().optional(),
});

const updateProjectSchema = createProjectSchema.partial().extend({
  isActive: z.boolean().optional(),
  pinned: z.boolean().optional(),
  /** true = 归档（写入 archivedAt），false = 恢复（清空）。 */
  archived: z.boolean().optional(),
});

async function assertRootDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved)) throw new Error("项目路径必须是绝对路径");
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("项目路径不存在或不是目录");
  return resolved;
}

async function assertDefaults(input: {
  defaultAgentId?: string | null;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
}, current?: { defaultAgentId?: string | null; defaultProviderId?: string | null; defaultModelId?: string | null }) {
  const agentId = input.defaultAgentId === undefined ? current?.defaultAgentId : input.defaultAgentId;
  const providerId =
    input.defaultProviderId === undefined ? current?.defaultProviderId : input.defaultProviderId;
  const modelId =
    input.defaultModelId === undefined ? current?.defaultModelId : input.defaultModelId;

  if (agentId) {
    const agent = await prisma.agentConfig.findUnique({ where: { id: agentId } });
    if (!agent?.isActive) throw new Error("默认 Agent 不存在或未启用");
  }
  if (providerId && !modelId) throw new Error("选择默认 Provider 时必须同时选择默认模型");

  if (providerId && modelId) {
    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider?.isActive) throw new Error("默认 Provider 不存在或未启用");
    try {
      const models = provider.models ? JSON.parse(provider.models) as unknown[] : [];
      const enabled = models.filter(
        (entry): entry is { id: string; enabled?: boolean } =>
          typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string",
      );
      if (enabled.length > 0 && !enabled.some((entry) => entry.enabled !== false && entry.id === modelId)) {
        throw new Error("默认模型未启用");
      }
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("供应商模型配置无效");
      throw error;
    }
  }
}

function serializeProject(project: Awaited<ReturnType<typeof prisma.project.findFirstOrThrow>>) {
  return {
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export const projectRoutes = new Hono();

projectRoutes.get("/", async (c) => {
  const projects = await prisma.project.findMany({
    // 置顶项目排前，其余保持创建顺序；归档项目也返回，由前端分区展示。
    orderBy: [{ pinned: "desc" }, { createdAt: "asc" }],
    include: { _count: { select: { conversations: true } } },
  });
  return c.json({
    projects: projects.map((project) => ({
      ...serializeProject(project),
      conversationCount: project._count.conversations,
    })),
  });
});

projectRoutes.post("/", async (c) => {
  const input = createProjectSchema.parse(await c.req.json());
  let rootPath: string;
  try {
    rootPath = await assertRootDirectory(input.rootPath);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid project path" }, 400);
  }

  try {
    await assertDefaults(input);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid project defaults" }, 400);
  }

  const project = await prisma.project.create({ data: { ...input, rootPath } });
  return c.json({ project: serializeProject(project) }, 201);
});

projectRoutes.put("/:id", async (c) => {
  const input = updateProjectSchema.parse(await c.req.json());
  let nextRootPath: string | undefined;
  if (input.rootPath !== undefined) {
    try {
      nextRootPath = await assertRootDirectory(input.rootPath);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid project path" }, 400);
    }
  }

  const { rootPath: requestedRootPath, archived, ...data } = input;
  void requestedRootPath;
  try {
    const current = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
    if (!current) return c.json({ error: "Project not found" }, 404);
    await assertDefaults(input, current);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid project defaults" }, 400);
  }
  const project = await prisma.project.update({
    where: { id: c.req.param("id") },
    data: {
      ...data,
      ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
      ...(nextRootPath ? { rootPath: nextRootPath } : {}),
    },
  });
  return c.json({ project: serializeProject(project) });
});

projectRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // 项目删除时连带清理其知识库（页面/原文档/修订/队列任务），否则这些数据
  // 会因 scope 不可达而永久残留。会话本身保留（projectId 置空），需要时可重建。
  const scopeId = projectScopeId(id);
  await prisma.$transaction([
    prisma.wikiPage.deleteMany({ where: { scopeId } }),
    prisma.wikiDocument.deleteMany({ where: { scopeId } }),
    prisma.wikiPageRevision.deleteMany({ where: { scopeId } }),
    prisma.wikiIngestJob.deleteMany({ where: { scopeId } }),
    prisma.project.delete({ where: { id } }),
  ]);
  void removeScopeFromDisk(scopeId);
  return c.json({ ok: true });
});
