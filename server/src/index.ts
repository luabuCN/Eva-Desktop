import { serve } from "@hono/node-server";
import "./env.js";
import { app } from "./app.js";
import { config } from "./env.js";
import { ensureSchema } from "./db.js";
import { cronService } from "./runtime/cron-service.js";
import { mcpManager } from "./runtime/mcp-manager.js";
import { toolRecordService } from "./runtime/tools/tool-records.js";

let server: ReturnType<typeof serve>;

async function main() {
  await ensureSchema();
  await toolRecordService.syncFromRegistry();
  await cronService.init();
  // 后台预热全局级 MCP 连接：失败只记状态，不阻塞启动。
  void mcpManager.warmUp();

  server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (information) => {
      console.log(`OpenHarness sidecar listening on http://${information.address}:${information.port}`);
    },
  );

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[sidecar] 端口 ${config.port} 已被占用（EADDRINUSE），无法启动。\n` +
          `可能有另一个 OpenHarness 实例仍在运行，请结束占用该端口的进程后重试：\n` +
          `  Windows: netstat -ano | findstr :${config.port}  然后 taskkill /PID <进程PID> /F\n` +
          `  或通过环境变量 OPENHARNESS_PORT 指定其他端口。`,
      );
      process.exit(1);
    }
    throw error;
  });
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
