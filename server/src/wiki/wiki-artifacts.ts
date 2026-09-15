import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import type { ChatUIMessage } from "../chat-types.js";
import {
  extractDocumentTextFromBytes,
  isIngestibleDocumentPath,
} from "../runtime/tools/document-extract.js";
import { getWorkspaceRoot } from "../runtime/workspace.js";
import { wikiService } from "./wiki-service.js";

/**
 * 对话产物沉淀：回合生成的文档类产物（PPT/表格/Word/PDF/md 等）在对话
 * 总结入库的同时，自动走手动上传同款的解析管线——提取文本、保存原件、
 * 建立「来源/原始资料」入口页，再交回串行队列做 LLM 总结。产物路径来自
 * 每回合消息里的 data-oh:changes 部件（writeFile/editFile 精确记录 +
 * bash 产物时间窗扫描），只取可解析的文档扩展，代码文件不进知识库。
 */

/** 单个产物的入库上限（对齐手动上传）；单次对话任务最多入库的产物数。 */
const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const ARTIFACT_MAX_FILES = 10;

export interface ConversationArtifact {
  documentId: string;
  /** 工作区相对路径（正斜杠），作为知识库内的文档标识：同名即同一份，
   * upsert 天然幂等；带目录前缀也让「原始资料」列表能看出产物出处。 */
  filename: string;
  title: string;
  text: string;
}

/** 从窗口内的消息快照收集产物文档路径：data-oh:changes 部件按出现顺序
 * 去重（后写的回合覆盖先前的同路径记录），delete 不算产物。 */
async function collectArtifactPaths(
  conversationId: string,
  fromSeq: number,
  toSeq: number,
): Promise<string[]> {
  const rows = await prisma.storedMessage.findMany({
    where: { conversationId, kind: "ui", sequence: { gte: fromSeq, lt: toSeq } },
    orderBy: { sequence: "asc" },
    select: { payload: true },
  });
  const byPath = new Map<string, true>();
  for (const row of rows) {
    let message: ChatUIMessage;
    try {
      message = JSON.parse(row.payload) as ChatUIMessage;
    } catch {
      continue;
    }
    for (const part of message.parts ?? []) {
      if (part.type !== "data-oh:changes") continue;
      const files = (part.data as { files?: Array<{ path?: string; changeKind?: string }> })
        ?.files;
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        if (typeof file.path !== "string" || !file.path) continue;
        if (file.changeKind === "delete") {
          byPath.delete(file.path);
          continue;
        }
        byPath.set(file.path, true);
      }
    }
  }
  return [...byPath.keys()];
}

/**
 * 解析并保存对话窗口内的全部文档产物（raw 层 + 来源页，不触发 LLM 总结
 * ——调用方把返回项交回 wikiQueue.enqueueDocument 排队）。单个产物失败
 * （不可读/超限/提取不出文本）只跳过并记日志，绝不影响对话总结本身。
 * 文本未变化的产物直接跳过：重复点「存入知识库」不会重复总结。
 */
export async function ingestConversationArtifacts(input: {
  scopeId: string;
  projectId?: string | null;
  conversationId: string;
  fromSeq: number;
  toSeq: number;
}): Promise<ConversationArtifact[]> {
  let root: string;
  if (input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { rootPath: true },
    });
    root = project?.rootPath ?? (await getWorkspaceRoot()).path;
  } else {
    root = (await getWorkspaceRoot()).path;
  }

  const paths = (await collectArtifactPaths(input.conversationId, input.fromSeq, input.toSeq))
    .filter((relative) => isIngestibleDocumentPath(relative))
    .slice(0, ARTIFACT_MAX_FILES);
  if (paths.length === 0) return [];

  const artifacts: ConversationArtifact[] = [];
  for (const relative of paths) {
    try {
      const absolute = path.resolve(root, relative);
      // 防御路径穿越：解析结果必须仍落在工作区内（跨盘符时 relative
      // 返回绝对路径，同样视为越界）。
      const relativeToRoot = path.relative(root, absolute);
      if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) continue;
      const stat = await fsp.stat(absolute);
      if (!stat.isFile() || stat.size === 0 || stat.size > ARTIFACT_MAX_BYTES) continue;

      const bytes = await fsp.readFile(absolute);
      const extracted = await extractDocumentTextFromBytes(bytes, relative);
      if (!extracted.text.trim()) {
        console.warn(`[wiki] artifact ${relative} 提取不到文本，跳过入库`);
        continue;
      }

      // 内容未变化的产物：raw 层已是最新，无需重存重总结。
      const existing = await prisma.wikiDocument.findUnique({
        where: { scopeId_filename: { scopeId: input.scopeId, filename: relative } },
        select: { text: true },
      });
      if (existing?.text === extracted.text) continue;

      const title = path.basename(relative).replace(/\.[^.]+$/, "").trim() || relative;
      const document = await wikiService.saveRawDocument(input.scopeId, {
        filename: relative,
        title,
        text: extracted.text,
        truncated: extracted.truncated,
        bytes,
      });
      artifacts.push({
        documentId: document.id,
        filename: relative,
        title,
        text: extracted.text,
      });
    } catch (error) {
      console.error(`[wiki] artifact ingest failed: ${relative}`, error);
    }
  }
  return artifacts;
}
