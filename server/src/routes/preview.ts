import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { prisma } from "../db.js";
import { getWorkspaceRoot } from "../runtime/workspace.js";

/** 内置浏览器面板的静态文件服务：把工作区/项目内的文件以原始字节吐出，
 * 供 iframe 预览生成的 HTML（及其相对引用的 css/js/图片）。
 * 只允许读取全局工作区与启用中项目的根目录之内，与文件浏览接口同一防线。 */

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
};

async function allowedRoots(): Promise<string[]> {
  const roots = [(await getWorkspaceRoot()).path];
  const projects = await prisma.project.findMany({
    where: { isActive: true },
    select: { rootPath: true },
  });
  for (const project of projects) {
    roots.push(path.resolve(project.rootPath));
  }
  return roots;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** URL 形如 /preview/E:/ws/demo/index.html（Windows 盘符）或
 * /preview/home/user/demo/index.html（POSIX 绝对路径）。 */
function decodeTargetPath(urlPath: string): string | null {
  let raw: string;
  try {
    raw = decodeURIComponent(urlPath.replace(/^\/preview\/?/, ""));
  } catch {
    return null;
  }
  if (!raw) return null;
  // Windows 盘符（E:/… 或 E%3A/…）保持原样交给 path.resolve；
  // 其余按 POSIX 绝对路径处理（去掉 /preview 前缀时保住了首个 /）。
  const candidate = /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)
    ? raw
    : raw.startsWith("/")
      ? raw
      : `/${raw}`;
  return path.resolve(candidate);
}

export const previewRoutes = new Hono();

previewRoutes.get("/*", async (c) => {
  const target = decodeTargetPath(c.req.path);
  if (!target) return c.text("Bad preview path", 400);

  const roots = await allowedRoots();
  if (!roots.some((root) => isInside(root, target))) {
    return c.text("Access denied: path is outside workspace and projects", 403);
  }

  let resolved = target;
  let stat = await fsp.stat(resolved).catch(() => null);
  // 目录请求自动落到 index.html，方便直接预览整个静态站点
  if (stat?.isDirectory()) {
    resolved = path.join(resolved, "index.html");
    stat = await fsp.stat(resolved).catch(() => null);
  }
  if (!stat?.isFile()) {
    return c.text("Not found", 404);
  }

  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(resolved)) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, 200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
});
