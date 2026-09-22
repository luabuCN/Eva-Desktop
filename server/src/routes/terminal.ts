import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { terminalHub } from "../runtime/terminal-hub.js";

export const terminalRoutes = new Hono();

const STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function unavailable(c: Context) {
  return c.json({ error: "终端组件不可用（node-pty 未加载）" }, 503);
}

const createSchema = z.object({
  cwd: z.string().trim().max(500).optional(),
  title: z.string().trim().max(120).optional(),
  projectId: z.string().trim().max(200).optional(),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(200).optional(),
});

terminalRoutes.post("/", async (c) => {
  const input = createSchema.parse(await c.req.json().catch(() => ({})));
  try {
    const terminal = await terminalHub.create(input);
    return c.json({ terminal });
  } catch (error) {
    if (error instanceof Error && error.message === "TERMINAL_UNAVAILABLE") {
      return unavailable(c);
    }
    throw error;
  }
});

terminalRoutes.get("/", (c) => {
  return c.json({ terminals: terminalHub.list() });
});

terminalRoutes.delete("/:id", (c) => {
  return c.json({ ok: terminalHub.kill(c.req.param("id")) });
});

const inputSchema = z.object({ data: z.string().max(8_192) });
terminalRoutes.post("/:id/input", async (c) => {
  const session = terminalHub.get(c.req.param("id"));
  if (!session) return c.json({ error: "Terminal not found" }, 404);
  const { data } = inputSchema.parse(await c.req.json());
  return c.json({ ok: session.write(data) });
});

const resizeSchema = z.object({
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(200),
});
terminalRoutes.post("/:id/resize", async (c) => {
  const session = terminalHub.get(c.req.param("id"));
  if (!session) return c.json({ error: "Terminal not found" }, 404);
  const { cols, rows } = resizeSchema.parse(await c.req.json());
  session.resize(cols, rows);
  return c.json({ ok: true });
});

/** 输出流：先整体回放环形缓冲（切页签/刷新回来历史不丢），再接实时输出；
 * 进程退出时发送 exit 事件并关闭。 */
terminalRoutes.get("/:id/stream", (c) => {
  const session = terminalHub.get(c.req.param("id"));
  if (!session) return c.json({ error: "Terminal not found" }, 404);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: "replay", data: session.replay() });
      const unsubscribe = session.subscribe((event) => {
        send(event);
        if (event.type === "exit") {
          unsubscribe();
          closed = true;
          try {
            controller.close();
          } catch {
            // 客户端已断开
          }
        }
      });
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
});
