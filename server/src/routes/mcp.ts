import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { mcpManager, type McpServerRecord } from "../runtime/mcp-manager.js";

/** MCP 服务器配置的增删改查与连接测试；每次写操作后 refresh 连接管理器，
 * 使变更立即反映到下一次运行装配。 */

export const mcpRoutes = new Hono();

function withStatus(record: McpServerRecord) {
  return { ...record, status: mcpManager.statusOf(record.id) };
}

async function currentRecord(id: string): Promise<McpServerRecord | undefined> {
  const row = await prisma.mcpServer.findUnique({ where: { id } });
  return row ? toApiRecord(row) : undefined;
}

// Prisma 行 → API 记录（解析 JSON 字段）。
function toApiRecord(row: {
  id: string;
  label: string;
  description: string | null;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  enabled: boolean;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): McpServerRecord {
  const parseMap = (raw: string): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const pairs: Array<[string, string]> = [];
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") pairs.push([key, value]);
      }
      return Object.fromEntries(pairs);
    } catch {
      return {};
    }
  };
  const parseList = (raw: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command,
    args: parseList(row.args),
    env: parseMap(row.env),
    url: row.url,
    headers: parseMap(row.headers),
    enabled: row.enabled,
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const urlAllowed = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

const serverInputSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).nullable().optional(),
    transport: z.enum(["stdio", "http"]),
    command: z.string().trim().max(500).nullable().optional(),
    args: z.array(z.string().max(1_000)).max(100).optional(),
    env: z.record(z.string().max(200), z.string().max(4_000)).optional(),
    url: z.string().trim().max(2_000).nullable().optional(),
    headers: z.record(z.string().max(200), z.string().max(4_000)).optional(),
    enabled: z.boolean().optional(),
    projectId: z.string().nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.transport === "stdio") {
      if (!input.command) {
        ctx.addIssue({
          code: "custom",
          message: "stdio 传输需要启动命令",
        });
      }
      if (input.command?.includes("..")) {
        ctx.addIssue({ code: "custom", message: "启动命令不允许包含 .." });
      }
    } else {
      if (!input.url) {
        ctx.addIssue({ code: "custom", message: "http 传输需要服务器 URL" });
      } else if (!urlAllowed(input.url)) {
        ctx.addIssue({
          code: "custom",
          message: "URL 仅支持 https 或本机回环 http 地址",
        });
      }
    }
  });

mcpRoutes.get("/", async (c) => {
  await mcpManager.refresh();
  return c.json({ servers: mcpManager.listRecords().map(withStatus) });
});

const createSchema = serverInputSchema.extend({
  id: z.string().regex(ID_PATTERN, "标识符需以字母开头，仅含字母、数字、_ 和 -（最长 64）"),
});

mcpRoutes.post("/", async (c) => {
  const input = createSchema.parse(await c.req.json());
  if (input.projectId) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) return c.json({ error: "指定的项目不存在" }, 400);
  }
  try {
    await prisma.mcpServer.create({
      data: {
        id: input.id,
        label: input.label,
        description: input.description ?? null,
        transport: input.transport,
        command: input.command ?? null,
        args: JSON.stringify(input.args ?? []),
        env: JSON.stringify(input.env ?? {}),
        url: input.url ?? null,
        headers: JSON.stringify(input.headers ?? {}),
        enabled: input.enabled ?? true,
        projectId: input.projectId ?? null,
      },
    });
  } catch (cause) {
    return c.json(
      { error: cause instanceof Error && cause.message.includes("Unique") ? "已存在同名标识符的 MCP 服务器" : "创建失败" },
      400,
    );
  }
  await mcpManager.refresh();
  const record = await currentRecord(input.id);
  return c.json({ server: record ? withStatus(record) : null }, 201);
});

mcpRoutes.put("/:id", async (c) => {
  const input = serverInputSchema.parse(await c.req.json());
  const id = c.req.param("id");
  const existing = await prisma.mcpServer.findUnique({ where: { id } });
  if (!existing) return c.json({ error: "MCP 服务器不存在" }, 404);
  if (input.projectId) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) return c.json({ error: "指定的项目不存在" }, 400);
  }
  await prisma.mcpServer.update({
    where: { id },
    data: {
      label: input.label,
      description: input.description ?? null,
      transport: input.transport,
      command: input.command ?? null,
      args: JSON.stringify(input.args ?? []),
      env: JSON.stringify(input.env ?? {}),
      url: input.url ?? null,
      headers: JSON.stringify(input.headers ?? {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId ?? null } : {}),
    },
  });
  await mcpManager.refresh();
  const record = await currentRecord(id);
  return c.json({ server: record ? withStatus(record) : null });
});

const toggleSchema = z.object({ enabled: z.boolean() });

mcpRoutes.patch("/:id/enabled", async (c) => {
  const { enabled } = toggleSchema.parse(await c.req.json());
  const id = c.req.param("id");
  try {
    await prisma.mcpServer.update({ where: { id }, data: { enabled } });
  } catch {
    return c.json({ error: "MCP 服务器不存在" }, 404);
  }
  await mcpManager.refresh();
  const record = await currentRecord(id);
  return c.json({ server: record ? withStatus(record) : null });
});

mcpRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await prisma.mcpServer.delete({ where: { id } });
  } catch {
    return c.json({ error: "MCP 服务器不存在" }, 404);
  }
  await mcpManager.refresh();
  return c.json({ ok: true });
});

mcpRoutes.post("/:id/test", async (c) => {
  const id = c.req.param("id");
  try {
    const status = await mcpManager.test(id);
    return c.json({ status });
  } catch (cause) {
    return c.json({ error: cause instanceof Error ? cause.message : "测试失败" }, 404);
  }
});
