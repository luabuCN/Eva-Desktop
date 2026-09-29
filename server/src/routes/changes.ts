import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { runService } from "../runtime/run-service.js";
import { getWorkspaceRoot } from "../runtime/workspace.js";

export const changeRoutes = new Hono();

interface ChangeSummaryRow {
  id: string;
  conversationId: string;
  projectId: string | null;
  path: string;
  changeKind: string;
  unifiedDiff: string | null;
  additions: number;
  deletions: number;
  createdAt: Date;
}

interface FileChangeRow extends ChangeSummaryRow {
  before: string | null;
}

function serializeChange(row: ChangeSummaryRow) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    projectId: row.projectId,
    path: row.path,
    changeKind: row.changeKind,
    unifiedDiff: row.unifiedDiff,
    additions: row.additions,
    deletions: row.deletions,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Latest edit per path across the project (or one conversation), newest first.
 * The changes panel renders this as "what is currently different". */
changeRoutes.get("/", async (c) => {
  const projectId = c.req.query("projectId");
  const conversationId = c.req.query("conversationId");
  if (!projectId && !conversationId) {
    return c.json({ error: "projectId 或 conversationId 至少提供一个" }, 400);
  }

  const rows = await prisma.fileChange.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(conversationId ? { conversationId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 1_000,
    select: {
      id: true,
      conversationId: true,
      projectId: true,
      path: true,
      changeKind: true,
      unifiedDiff: true,
      additions: true,
      deletions: true,
      createdAt: true,
    },
  });

  const latestByPath = new Map<string, ChangeSummaryRow>();
  for (const row of rows) {
    if (!latestByPath.has(row.path)) latestByPath.set(row.path, row);
  }
  const changes = [...latestByPath.values()].map(serializeChange);

  return c.json({
    changes,
    totals: {
      files: changes.length,
      additions: changes.reduce((sum, change) => sum + change.additions, 0),
      deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
    },
  });
});

async function projectRootFor(row: { projectId: string | null }): Promise<string> {
  if (row.projectId) {
    const project = await prisma.project.findUnique({ where: { id: row.projectId } });
    if (!project?.isActive) throw new Error("项目不存在或已停用");
    return path.resolve(project.rootPath);
  }
  // 无项目的会话运行在默认工作区：路径按当时的默认工作区根记录，
  // 撤回时回落到当前默认工作区根（用户中途改过根目录的旧记录会失准）。
  return (await getWorkspaceRoot()).path;
}

/** Restore one path to its pre-conversation state (the earliest row's before
 * snapshot); rows for that path are dropped afterwards. When `since` is set
 * (edit-and-resend flow) only rows inside that time window are dropped and the
 * restore point is the earliest in-window row, so earlier edits stay recorded. */
async function revertPath(
  rows: FileChangeRow[],
  since?: Date,
): Promise<{ path: string; action: string }> {
  const earliest = rows[0];
  const root = await projectRootFor(earliest);
  const absolute = path.resolve(root, earliest.path);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`访问被拒绝：${earliest.path}`);
  }

  if (earliest.changeKind === "create" && earliest.before === null) {
    await fs.rm(absolute, { force: true });
  } else if (earliest.before !== null) {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, earliest.before, "utf8");
  } else {
    throw new Error(`无法撤销 ${earliest.path}：缺少原始内容快照`);
  }

  await prisma.fileChange.deleteMany({
    where: {
      conversationId: earliest.conversationId,
      path: earliest.path,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
  });
  return { path: earliest.path, action: earliest.changeKind === "create" ? "deleted" : "restored" };
}

const revertSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

changeRoutes.post("/revert", async (c) => {
  const input = revertSchema.parse(await c.req.json());
  const rows = await prisma.fileChange.findMany({ where: { id: { in: input.ids } } });
  if (rows.length === 0) return c.json({ error: "未找到对应的变更记录" }, 404);

  const results: Array<{ path: string; action: string }> = [];
  const failures: Array<{ path: string; error: string }> = [];
  for (const row of rows) {
    try {
      // Revert needs every recorded edit of that path so the row set is complete.
      const history = await prisma.fileChange.findMany({
        where: { conversationId: row.conversationId, path: row.path },
        orderBy: { createdAt: "asc" },
      });
      results.push(await revertPath(history));
    } catch (error) {
      failures.push({ path: row.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return c.json({ results, failures });
});

const revertConversationSchema = z.object({ conversationId: z.string().min(1) });

changeRoutes.post("/revert-conversation", async (c) => {
  const { conversationId } = revertConversationSchema.parse(await c.req.json());
  const rows = await prisma.fileChange.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return c.json({ results: [], failures: [] });

  const paths = [...new Set(rows.map((row) => row.path))];
  const results: Array<{ path: string; action: string }> = [];
  const failures: Array<{ path: string; error: string }> = [];
  for (const path of paths) {
    try {
      results.push(await revertPath(rows.filter((row) => row.path === path)));
    } catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return c.json({ results, failures });
});

/* —— 编辑重发：按「某条用户消息之后」圈定文件修改窗口 —— */

const WINDOW_MESSAGE_MISSING = Symbol("message-missing");
const WINDOW_EMPTY = Symbol("window-empty");

/**
 * 计算一条用户消息所触发的回合及其后所有回合的修改时间窗起点（含）。
 *
 * 关联方式：ThreadRun.triggerMessageId（运行创建时记下的触发消息），
 * 目标消息 = 持久化历史里从该消息到末尾的所有 user 消息，窗口起点取
 * 它们触发的运行里最早的 createdAt。早于本功能上线的运行没有关联字段，
 * 按位置启发式兜底：未覆盖的目标消息数 = 尾部同数量的无关联运行——
 * regenerate 会让运行数多于消息数，这部分只能近似。
 *
 * 返回 WINDOW_MESSAGE_MISSING（消息不在当前历史里）、WINDOW_EMPTY
 * （找不到任何对应运行，窗口为空）或一个 Date。
 */
async function resolveWindowStart(
  conversationId: string,
  messageId: string,
): Promise<Date | typeof WINDOW_MESSAGE_MISSING | typeof WINDOW_EMPTY> {
  const stored = await prisma.storedMessage.findMany({
    where: { conversationId, kind: "ui" },
    orderBy: { sequence: "asc" },
    select: { payload: true },
  });

  const targetIds: string[] = [];
  let found = false;
  for (const row of stored) {
    let message: { id?: unknown; role?: unknown };
    try {
      message = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (message.role !== "user" || typeof message.id !== "string") continue;
    if (message.id === messageId) found = true;
    if (found) targetIds.push(message.id);
  }
  if (!found) return WINDOW_MESSAGE_MISSING;

  const runs = await prisma.threadRun.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { triggerMessageId: true, createdAt: true },
  });
  const targetSet = new Set(targetIds);
  const linked = runs.filter(
    (run) => typeof run.triggerMessageId === "string" && targetSet.has(run.triggerMessageId),
  );
  const candidates: Date[] = [];
  if (linked.length > 0) {
    candidates.push(linked.reduce((min, run) => (run.createdAt < min ? run.createdAt : min), linked[0].createdAt));
  }
  const missing = targetIds.filter((id) => !linked.some((run) => run.triggerMessageId === id)).length;
  if (missing > 0) {
    const legacy = runs.filter((run) => run.triggerMessageId === null);
    const tail = legacy.slice(-missing);
    if (tail.length > 0) {
      candidates.push(tail.reduce((min, run) => (run.createdAt < min ? run.createdAt : min), tail[0].createdAt));
    }
  }
  if (candidates.length === 0) return WINDOW_EMPTY;
  return candidates.reduce((min, current) => (current < min ? current : min));
}

/** 编辑重发前的窗口预览：该消息之后回合修改过的文件（每路径取最新一条）。 */
changeRoutes.get("/since", async (c) => {
  const conversationId = c.req.query("conversationId");
  const messageId = c.req.query("messageId");
  if (!conversationId || !messageId) {
    return c.json({ error: "conversationId 与 messageId 必填" }, 400);
  }

  const start = await resolveWindowStart(conversationId, messageId);
  if (start === WINDOW_MESSAGE_MISSING) {
    return c.json({ error: "消息不存在或已被编辑移除" }, 404);
  }
  if (start === WINDOW_EMPTY) {
    return c.json({ changes: [], totals: { files: 0, additions: 0, deletions: 0 } });
  }

  const rows = await prisma.fileChange.findMany({
    where: { conversationId, createdAt: { gte: start } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      conversationId: true,
      projectId: true,
      path: true,
      changeKind: true,
      unifiedDiff: true,
      additions: true,
      deletions: true,
      createdAt: true,
    },
  });
  const latestByPath = new Map<string, ChangeSummaryRow>();
  for (const row of rows) {
    if (!latestByPath.has(row.path)) latestByPath.set(row.path, row);
  }
  const changes = [...latestByPath.values()].map(serializeChange);
  return c.json({
    changes,
    totals: {
      files: changes.length,
      additions: changes.reduce((sum, change) => sum + change.additions, 0),
      deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
    },
  });
});

const revertSinceSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});

/** 编辑重发的撤回：把窗口内每个路径恢复到窗口首次修改前的内容，只删
 *  窗口内的记录（更早回合的修改记录保留，变更面板仍能展示/撤销）。 */
changeRoutes.post("/revert-since", async (c) => {
  const input = revertSinceSchema.parse(await c.req.json());

  const active = await runService.activeRun(input.conversationId);
  if (active) {
    return c.json({ error: "该对话仍有进行中的运行，请先等待完成或停止再撤回" }, 409);
  }

  const start = await resolveWindowStart(input.conversationId, input.messageId);
  if (start === WINDOW_MESSAGE_MISSING) {
    return c.json({ error: "消息不存在或已被编辑移除" }, 404);
  }
  if (start === WINDOW_EMPTY) return c.json({ results: [], failures: [] });

  const rows = await prisma.fileChange.findMany({
    where: { conversationId: input.conversationId, createdAt: { gte: start } },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return c.json({ results: [], failures: [] });

  const paths = [...new Set(rows.map((row) => row.path))];
  const results: Array<{ path: string; action: string }> = [];
  const failures: Array<{ path: string; error: string }> = [];
  for (const path of paths) {
    try {
      results.push(await revertPath(rows.filter((row) => row.path === path), start));
    } catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return c.json({ results, failures });
});
