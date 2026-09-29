import { Hono } from "hono";
import { z } from "zod";
import {
  deleteMemoryNote,
  isMemoryEnabledFor,
  listMemoryNotes,
  setMemoryEnabled,
  updateMemoryNote,
} from "../memory/memory-service.js";

export const memoryRoutes = new Hono();

// 列表带 conversationId 时按会话过滤（聊天内卡片用），否则列出整个范围
// （projectId 为空 = 默认工作区记忆）。
memoryRoutes.get("/", async (c) => {
  const projectId = c.req.query("projectId") || null;
  const conversationId = c.req.query("conversationId") || null;
  const notes = await listMemoryNotes({ projectId, conversationId });
  return c.json({ notes });
});

memoryRoutes.get("/enabled", async (c) => {
  const projectId = c.req.query("projectId") || null;
  return c.json({ enabled: await isMemoryEnabledFor(projectId) });
});

const enabledInputSchema = z.object({
  enabled: z.boolean(),
  /** 指定项目 id 时写项目级覆盖，否则写全局设置。 */
  projectId: z.string().trim().min(1).nullable().optional(),
});

memoryRoutes.put("/enabled", async (c) => {
  const input = enabledInputSchema.parse(await c.req.json());
  await setMemoryEnabled(input);
  return c.json({ enabled: input.enabled });
});

const noteInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(20_000).optional(),
});

memoryRoutes.patch("/:id", async (c) => {
  const input = noteInputSchema.parse(await c.req.json());
  const note = await updateMemoryNote(c.req.param("id"), input);
  return c.json({ note });
});

memoryRoutes.delete("/:id", async (c) => {
  await deleteMemoryNote(c.req.param("id"));
  return c.json({ ok: true });
});
