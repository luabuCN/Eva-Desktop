import { Hono } from "hono";
import { z } from "zod";
import { subAgentService } from "../runtime/subagents.js";

export const subAgentRoutes = new Hono();

subAgentRoutes.get("/", async (c) => {
  const subagents = await subAgentService.list();
  return c.json({ subagents });
});

const subAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().min(1).max(2_000).optional(),
  tools: z.array(z.string().trim().min(1)).min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
  providerId: z.string().trim().nullable().optional(),
  modelId: z.string().trim().nullable().optional(),
  imageProviderId: z.string().trim().nullable().optional(),
  imageModelId: z.string().trim().nullable().optional(),
  maxTurns: z.number().int().min(1).max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});

subAgentRoutes.post("/", async (c) => {
  const input = subAgentInputSchema.parse(await c.req.json());
  try {
    const subagent = await subAgentService.create(input);
    return c.json({ subagent }, 201);
  } catch (cause) {
    return c.json({ error: cause instanceof Error ? cause.message : "创建失败" }, 400);
  }
});

subAgentRoutes.put("/:id", async (c) => {
  const input = subAgentInputSchema.parse(await c.req.json());
  try {
    const subagent = await subAgentService.update(c.req.param("id"), input);
    return c.json({ subagent });
  } catch (cause) {
    return c.json({ error: cause instanceof Error ? cause.message : "更新失败" }, 400);
  }
});

subAgentRoutes.delete("/:id", async (c) => {
  try {
    await subAgentService.remove(c.req.param("id"));
    return c.json({ ok: true });
  } catch (cause) {
    return c.json({ error: cause instanceof Error ? cause.message : "删除失败" }, 400);
  }
});
