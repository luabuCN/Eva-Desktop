import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const devDataDir = path.resolve(process.cwd(), ".local-data");

export const dataDir = path.resolve(process.env.OPENHARNESS_DATA_DIR ?? devDataDir);
export const workspaceDir = path.resolve(
  process.env.OPENHARNESS_WORKSPACE ?? path.join(dataDir, "workspace"),
);
export const skillsDir = path.resolve(
  process.env.OPENHARNESS_SKILLS_DIR ?? path.join(dataDir, "skills"),
);

for (const envFile of [path.join(dataDir, ".env"), path.resolve(process.cwd(), ".env")]) {
  dotenv.config({ path: envFile });
}

fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });

if (!process.env.DATABASE_URL) {
  const databaseFile = path.join(dataDir, "openharness.db").replaceAll("\\", "/");
  fs.closeSync(fs.openSync(databaseFile, "a"));
  process.env.DATABASE_URL = `file:${databaseFile}?connection_limit=1`;
}

/**
 * SEA 打包的 sidecar 里 Prisma 找不到查询引擎：esbuild bundle 不携带
 * *.dll.node，Prisma 只会去 node_modules 结构里搜（打包后不存在）。
 * prepare-sidecar.mjs 把引擎复制到 exe 同目录（打包版在 Tauri resources
 * 的 binaries/ 下），这里在首个 Prisma 查询前显式指向它。开发环境走
 * node_modules 原生解析，不受影响。
 */
function locateQueryEngine(): string | undefined {
  if (process.env.PRISMA_QUERY_ENGINE_LIBRARY) return process.env.PRISMA_QUERY_ENGINE_LIBRARY;
  const exeDir = path.dirname(process.execPath);
  const candidates = [exeDir, path.join(exeDir, "binaries"), path.join(exeDir, "resources")];
  for (const dir of candidates) {
    try {
      const hit = fs
        .readdirSync(dir)
        .find((name) => /^((lib)?query_engine-.+\.(dll|so|dylib)\.node)$/.test(name));
      if (hit) return path.join(dir, hit);
    } catch {
      // 目录不存在即跳过。
    }
  }
  return undefined;
}

const queryEngine = locateQueryEngine();
if (queryEngine) process.env.PRISMA_QUERY_ENGINE_LIBRARY = queryEngine;

/** 模型流空闲超时（毫秒）：连接保持但超过该时长没有任何分片时，判定
 * 提供方挂起并自动中止回合（这类挂起不会让请求“失败”，maxRetries 无从
 * 触发）。非法值回落默认 240 秒。 */
function parseStreamIdleTimeoutMs(): number {
  const parsed = Number(process.env.OPENHARNESS_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 240_000;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? process.env.OPENHARNESS_PORT ?? 8878),
  enableBash: process.env.OPENHARNESS_ENABLE_BASH === "true",
  contextWindow: Number(process.env.OPENHARNESS_CONTEXT_WINDOW ?? 128_000),
  streamIdleTimeoutMs: parseStreamIdleTimeoutMs(),
  /** webSearch 工具的 API key；缺省时优先复用已配置的智谱供应商 key，再降级到免 key 抓取。 */
  webSearchApiKey: process.env.OPENHARNESS_WEBSEARCH_API_KEY,
  /** webSearch 引擎：zhipu / bocha / tavily / brave / sogou / duckduckgo / auto（默认 auto）。 */
  webSearchEngine: process.env.OPENHARNESS_WEBSEARCH_ENGINE,
};
