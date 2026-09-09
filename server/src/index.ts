import { serve } from "@hono/node-server";
import "./env.js";
import { app } from "./app.js";
import { config } from "./env.js";
import { ensureSchema } from "./db.js";
import { cronService } from "./runtime/cron-service.js";
import { mcpManager } from "./runtime/mcp-manager.js";
import { toolRecordService } from "./runtime/tools/tool-records.js";
import { wikiQueue } from "./wiki/wiki-queue.js";

let server: ReturnType<typeof serve>;

/** 绑定端口；EADDRINUSE 时等待占用方退出并重试，避免 dev 热重启/多实例竞态导致进程直接退出。 */
async function listenWithRetry(maxAttempts = 30, delayMs = 1_000): Promise<ReturnType<typeof serve>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const bound = serve(
          {
            fetch: app.fetch,
            hostname: config.host,
            port: config.port,
          },
          (information) => {
            console.log(`OpenHarness sidecar listening on http://${information.address}:${information.port}`);
            resolve(bound);
          },
        );
        bound.on("error", reject);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= maxAttempts) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          console.error(
            `[sidecar] 端口 ${config.port} 已被占用（EADDRINUSE），重试 ${maxAttempts} 次后放弃。\n` +
              `可能有另一个 OpenHarness 实例仍在运行，请结束占用该端口的进程后重试：\n` +
              `  Windows: netstat -ano | findstr :${config.port}  然后 taskkill /PID <进程PID> /F\n` +
              `  或通过环境变量 OPENHARNESS_PORT 指定其他端口。`,
          );
          process.exit(1);
        }
        throw error;
      }
      console.warn(
        `[sidecar] 端口 ${config.port} 被占用，${delayMs}ms 后重试（${attempt}/${maxAttempts}）...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main() {
  await ensureSchema();
  await toolRecordService.syncFromRegistry();
  await cronService.init();
  // 知识库总结队列：消费重启前遗留与新增的 ingest 任务（串行后台执行）。
  void wikiQueue.init();
  // 后台预热全局级 MCP 连接：失败只记状态，不阻塞启动。
  void mcpManager.warmUp();

  server = await listenWithRetry();
}

function shutdown() {
  mcpManager.closeAll();
  server?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
