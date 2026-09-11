import fs from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { workspaceDir } from "../env.js";

/**
 * 可配置的默认工作区根目录。
 *
 * 之前全局工作区硬编码为数据目录下的 workspace/（env.ts 的 workspaceDir，
 * OPENHARNESS_WORKSPACE 可覆盖），用户没有指定权。现在存 AppSetting
 * （key = workspace.root）：设置页可改，首次启动强制引导选择一次；
 * 未配置时回落 env 默认。进程内缓存，set 后立即生效。
 */

const WORKSPACE_ROOT_KEY = "workspace.root";

export interface WorkspaceRoot {
  path: string;
  /** 用户是否显式配置过（false = 还在用 env 默认值，前端据此弹引导）。 */
  configured: boolean;
}

let cached: WorkspaceRoot | undefined;

export async function getWorkspaceRoot(): Promise<WorkspaceRoot> {
  if (cached) return cached;
  const value = (
    await prisma.appSetting.findUnique({ where: { key: WORKSPACE_ROOT_KEY } })
  )?.value.trim();
  if (value && path.isAbsolute(value)) {
    fs.mkdirSync(value, { recursive: true });
    cached = { path: path.resolve(value), configured: true };
  } else {
    cached = { path: workspaceDir, configured: false };
  }
  return cached;
}

/** 写入探针再删除：mkdir 成功不代表可写（网络驱动器/权限）。 */
function assertWritable(target: string): void {
  const probe = path.join(target, `.eva-workspace-probe-${Date.now()}`);
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe, { force: true });
}

export async function setWorkspaceRoot(input: string): Promise<WorkspaceRoot> {
  const trimmed = input.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error("工作区需要一个绝对路径");
  }
  const resolved = path.resolve(trimmed);
  fs.mkdirSync(resolved, { recursive: true });
  assertWritable(resolved);

  await prisma.appSetting.upsert({
    where: { key: WORKSPACE_ROOT_KEY },
    update: { value: resolved },
    create: { key: WORKSPACE_ROOT_KEY, value: resolved },
  });
  cached = { path: resolved, configured: true };
  return cached;
}
