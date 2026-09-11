import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { tokenizeCommand } from "../runtime/tools/command-rules.js";

export const commandRuleRoutes = new Hono();

const ruleInputSchema = z.object({
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((value) => tokenizeCommand(value).join(" "))
    .refine((value) => value.length > 0, "规则不能只有空白或引号"),
  matchType: z.enum(["prefix", "exact"]).default("prefix"),
  projectId: z.string().uuid().nullable().optional(),
});

commandRuleRoutes.get("/", async (c) => {
  const rules = await prisma.commandRule.findMany({
    orderBy: [{ projectId: "asc" }, { createdAt: "asc" }],
    include: { project: { select: { name: true } } },
  });
  return c.json({
    rules: rules.map(({ project, ...rule }) => ({
      ...rule,
      projectName: project?.name ?? null,
    })),
  });
});

commandRuleRoutes.post("/", async (c) => {
  const input = ruleInputSchema.parse(await c.req.json());
  if (input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { isActive: true },
    });
    if (!project?.isActive) return c.json({ error: "项目不存在或已停用" }, 404);
  }
  const existing = await prisma.commandRule.findFirst({
    where: {
      pattern: input.pattern,
      matchType: input.matchType,
      projectId: input.projectId ?? null,
    },
  });
  if (existing) return c.json({ rule: existing });
  const rule = await prisma.commandRule.create({
    data: {
      pattern: input.pattern,
      matchType: input.matchType,
      projectId: input.projectId ?? null,
    },
  });
  return c.json({ rule });
});

commandRuleRoutes.delete("/:id", async (c) => {
  await prisma.commandRule.deleteMany({ where: { id: c.req.param("id") } });
  return c.json({ ok: true });
});
