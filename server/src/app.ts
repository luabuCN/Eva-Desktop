import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { agentRoutes } from "./routes/agents.js";
import { changeRoutes } from "./routes/changes.js";
import { chatRoutes } from "./routes/chat.js";
import { commandRuleRoutes } from "./routes/command-rules.js";
import { cronRoutes } from "./routes/crons.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { healthRoutes } from "./routes/health.js";
import { mcpRoutes } from "./routes/mcp.js";
import { providerRoutes } from "./routes/providers.js";
import { projectRoutes } from "./routes/projects.js";
import { previewRoutes } from "./routes/preview.js";
import { runRoutes } from "./routes/runs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { settingRoutes } from "./routes/settings.js";
import { skillRoutes } from "./routes/skills.js";
import { subAgentRoutes } from "./routes/subagents.js";
import { taskRoutes } from "./routes/tasks.js";
import { terminalRoutes } from "./routes/terminal.js";
import { toolRoutes } from "./routes/tools.js";
import { wikiRoutes } from "./routes/wiki.js";

const allowedOrigins = new Set(
  [
    process.env.OPENHARNESS_ALLOWED_ORIGIN,
    "http://localhost:8089",
    "http://127.0.0.1:8089",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
  ].filter((origin): origin is string => Boolean(origin)),
);

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : null),
    credentials: true,
  }),
);

app.onError((error, c) => {
  console.error(error);
  if (error instanceof ZodError) {
    return c.json({ error: "Invalid request", details: error.issues }, 400);
  }
  return c.json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
});

app.route("/health", healthRoutes);
app.route("/api/files", fileRoutes);
app.route("/api/sessions", sessionRoutes);
app.route("/api/providers", providerRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/runs", runRoutes);
app.route("/api/tools", toolRoutes);
app.route("/api/command-rules", commandRuleRoutes);
app.route("/api/terminal", terminalRoutes);
app.route("/api/settings", settingRoutes);
app.route("/api/conversations", taskRoutes);
app.route("/api/agents", agentRoutes);
app.route("/api/subagents", subAgentRoutes);
app.route("/api/skills", skillRoutes);
app.route("/api/mcp", mcpRoutes);
app.route("/api/crons", cronRoutes);
app.route("/api/git", gitRoutes);
app.route("/api/changes", changeRoutes);
app.route("/api/wiki", wikiRoutes);
app.route("/api/chat", chatRoutes);
// 内置浏览器面板的静态预览（工作区/项目内文件，按原始字节返回）
app.route("/preview", previewRoutes);
