import fsp from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";

/** 回合修改/产物汇总卡（data-oh:changes）的单条文件记录。 */
export interface TurnFileChange {
  /** 工作区相对路径（正斜杠），用于卡片展示。 */
  path: string;
  /** 绝对路径，前端点击条目时直接交给预览面板打开。 */
  absolutePath: string;
  changeKind: "create" | "edit" | "delete" | "artifact";
  additions: number;
  deletions: number;
}

/** 兜底扫描跳过的目录名：依赖缓存/构建产物目录体量巨大且无展示意义；
 * attachments 是本回合用户上传附件的落盘目录，不算模型产物。 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".local-data",
  "attachments",
  ".next",
  "dist",
  "build",
  "target",
  "coverage",
]);
const SCAN_MAX_ENTRIES = 4_000;
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_FILES = 20;

/** bash 生成的产物（脚本写出的 pptx/pdf 等）没有 FileChange 记录，按
 * 运行时间窗内的 mtime 兜底发现。有界遍历：条目/深度/结果数超限即止，
 * 大工作区也不会拖慢回合收尾。 */
async function scanWorkspaceArtifacts(
  root: string,
  sinceMs: number,
  known: Set<string>,
): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > SCAN_MAX_DEPTH || found.length >= SCAN_MAX_FILES || visited >= SCAN_MAX_ENTRIES) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= SCAN_MAX_FILES || visited >= SCAN_MAX_ENTRIES) return;
      visited += 1;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (known.has(relative) || relative.split("/")[0] === "attachments") continue;
      const stat = await fsp.stat(absolute).catch(() => null);
      if (stat && stat.mtimeMs >= sinceMs) {
        known.add(relative);
        found.push(absolute);
      }
    }
  };

  await walk(root, 0);
  return found;
}

/**
 * 汇总一个回合产生的全部文件变更：writeFile/editFile 有精确的 FileChange
 * 记录（带增删行数），bash 产物按时间窗扫描补齐（changeKind=artifact）。
 * 收集失败只丢卡片，不影响回合本身。
 */
export async function collectTurnChanges(input: {
  runId: string;
  workspacePath: string;
  sinceMs: number;
}): Promise<{ files: TurnFileChange[] }> {
  const rows = await prisma.fileChange
    .findMany({
      where: { runId: input.runId },
      orderBy: { createdAt: "asc" },
    })
    .catch(() => []);

  // 同一路径多次编辑：增删行数累计，changeKind 取最后一次的状态。
  const byPath = new Map<string, TurnFileChange>();
  for (const row of rows) {
    const existing = byPath.get(row.path);
    byPath.set(row.path, {
      path: row.path,
      absolutePath: path.join(input.workspacePath, row.path),
      changeKind: (row.changeKind as TurnFileChange["changeKind"]) ?? "edit",
      additions: (existing?.additions ?? 0) + row.additions,
      deletions: (existing?.deletions ?? 0) + row.deletions,
    });
  }

  const scanned = await scanWorkspaceArtifacts(
    input.workspacePath,
    input.sinceMs,
    new Set(byPath.keys()),
  );

  const files = [...byPath.values()];
  for (const absolute of scanned) {
    files.push({
      path: path.relative(input.workspacePath, absolute).replaceAll("\\", "/"),
      absolutePath: absolute,
      changeKind: "artifact",
      additions: 0,
      deletions: 0,
    });
  }
  return { files };
}
