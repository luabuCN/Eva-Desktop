import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { prisma } from "../db.js";
import { isBinaryPath } from "../runtime/tools/fs-utils.js";
import { getWorkspaceRoot } from "../runtime/workspace.js";

export const fileRoutes = new Hono();

const CONTENT_MAX_BYTES = 512 * 1024;

/**
 * The file browser may only read the global workspace or directories of
 * active registered projects; everything else is rejected, so an absolute
 * path from the renderer cannot escape into arbitrary filesystem locations.
 */
async function resolveBrowsablePath(rawPath: string | undefined): Promise<string> {
  const workspaceRoot = (await getWorkspaceRoot()).path;
  const candidates = [workspaceRoot];
  const projects = await prisma.project.findMany({
    where: { isActive: true },
    select: { rootPath: true },
  });
  for (const project of projects) {
    candidates.push(path.resolve(project.rootPath));
  }

  // Relative paths resolve against the workspace; absolute paths must land
  // inside one of the allowed roots or the containment check below fails.
  const target = rawPath ? path.resolve(workspaceRoot, rawPath) : workspaceRoot;

  for (const root of candidates) {
    const relative = path.relative(root, target);
    const inside =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative));
    if (inside) return target;
  }
  throw new Error(`Access denied outside workspace and projects: ${target}`);
}

function sortEntries<T extends { name: string; isDirectory: boolean }>(entries: T[]): T[] {
  return entries.sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
  );
}

fileRoutes.get("/", async (c) => {
  const requested = c.req.query("path") ?? "";
  try {
    const resolved = await resolveBrowsablePath(requested || undefined);
    const dirents = await fs.readdir(resolved, { withFileTypes: true });
    return c.json({
      path: resolved,
      entries: sortEntries(
        dirents.map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
        })),
      ),
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Cannot list directory" },
      400,
    );
  }
});

fileRoutes.get("/content", async (c) => {
  const requested = c.req.query("path") ?? "";
  if (!requested) return c.json({ error: "path query parameter is required" }, 400);
  try {
    const resolved = await resolveBrowsablePath(requested);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return c.json({ error: "Not a file" }, 400);
    if (isBinaryPath(resolved)) {
      return c.json({ error: "二进制文件不支持预览" }, 400);
    }
    if (stat.size > CONTENT_MAX_BYTES) {
      return c.json(
        { error: `文件过大（超过 ${Math.round(CONTENT_MAX_BYTES / 1024)} KB），无法预览` },
        400,
      );
    }
    const content = await fs.readFile(resolved, "utf-8");
    return c.json({ path: resolved, size: stat.size, content });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Cannot read file" },
      400,
    );
  }
});
