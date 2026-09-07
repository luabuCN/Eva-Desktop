import { Hono } from "hono";
import { z } from "zod";
import {
  cronService,
  isValidCronPattern,
  type CronJobInput,
} from "../runtime/cron-service.js";

const cronPatternSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidCronPattern, "无效的 cron 表达式");

const createCronSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1),
  cron: cronPatternSchema,
  description: z.string().trim().max(500).nullish(),
  projectId: z.string().uuid().nullish(),
  agentId: z.string().min(1).nullish(),
  permissionMode: z.enum(["confirm", "auto_edit", "full"]).default("confirm"),
  isActive: z.boolean().default(true),
  reuseThread: z.boolean().default(false),
});

const updateCronSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).optional(),
  cron: cronPatternSchema.optional(),
  description: z.string().trim().max(500).nullish(),
  projectId: z.string().uuid().nullish(),
  agentId: z.string().min(1).nullish(),
  permissionMode: z.enum(["confirm", "auto_edit", "full"]).optional(),
  isActive: z.boolean().optional(),
  reuseThread: z.boolean().optional(),
});

function normalize(input: z.infer<typeof createCronSchema>): CronJobInput {
  return {
    name: input.name,
    prompt: input.prompt,
    cron: input.cron,
    description: input.description,
    projectId: input.projectId ?? null,
    agentId: input.agentId ?? null,
    permissionMode: input.permissionMode,
    isActive: input.isActive,
    reuseThread: input.reuseThread,
  };
}

export const cronRoutes = new Hono();

cronRoutes.get("/", async (c) => {
  return c.json({ crons: await cronService.list() });
});

cronRoutes.post("/", async (c) => {
  const body = createCronSchema.parse(await c.req.json());
  return c.json({ cron: await cronService.create(normalize(body)) }, 201);
});

cronRoutes.patch("/:id", async (c) => {
  const body = updateCronSchema.parse(await c.req.json());
  return c.json({ cron: await cronService.update(c.req.param("id"), body) });
});

cronRoutes.delete("/:id", async (c) => {
  await cronService.remove(c.req.param("id"));
  return c.json({ ok: true });
});

cronRoutes.post("/:id/run", async (c) => {
  return c.json(await cronService.runNow(c.req.param("id")));
});
