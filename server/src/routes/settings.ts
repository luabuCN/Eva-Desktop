import { Hono } from "hono";
import { z } from "zod";
import { workspaceDir } from "../env.js";
import { getWorkspaceRoot, setWorkspaceRoot } from "../runtime/workspace.js";

export const settingRoutes = new Hono();

settingRoutes.get("/workspace", async (c) => {
  const root = await getWorkspaceRoot();
  return c.json({ path: root.path, configured: root.configured, defaultPath: workspaceDir });
});

const workspaceInputSchema = z.object({
  path: z.string().trim().min(1).max(500),
});

settingRoutes.put("/workspace", async (c) => {
  const { path } = workspaceInputSchema.parse(await c.req.json());
  const root = await setWorkspaceRoot(path);
  return c.json({ path: root.path, configured: root.configured, defaultPath: workspaceDir });
});
