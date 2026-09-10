import { embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { prisma } from "../db.js";

/**
 * 知识库语义检索（可选）：页面/原文档分块后调用配置的 embedding 模型，
 * 向量存 WikiChunk（JSON 数组），查询时 JS 余弦相似度召回。
 *
 * - 模型取自任意已配置供应商（openai-compatible /embeddings 接口），
 *   通常填供应商的 embedding 模型 id（如 text-embedding-3-small），
 *   不要求出现在聊天模型列表里。
 * - 未配置或调用失败时一切静默降级：search 回落到纯关键词，绝不阻塞总结。
 * - 语义结果只补位（关键词没命中的页面），关键词命中优先。
 */

const EMBEDDING_PROVIDER_KEY = "wiki.embeddingProviderId";
const EMBEDDING_MODEL_KEY = "wiki.embeddingModelId";

/** 分块目标长度（字符）：段落聚合，超长段落硬切。 */
const CHUNK_TARGET_CHARS = 900;
const CHUNK_MAX_CHARS = 1_200;
/** embedMany 单批条数（保守值，规避供应商单请求上限）。 */
const EMBED_BATCH = 16;

export interface WikiEmbeddingConfig {
  providerId: string;
  modelId: string;
}

export async function getEmbeddingConfig(): Promise<WikiEmbeddingConfig | null> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [EMBEDDING_PROVIDER_KEY, EMBEDDING_MODEL_KEY] } },
  });
  const providerId = rows.find((row) => row.key === EMBEDDING_PROVIDER_KEY)?.value?.trim();
  const modelId = rows.find((row) => row.key === EMBEDDING_MODEL_KEY)?.value?.trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** 保存/清空 embedding 配置（providerId 为空 = 关闭语义检索）。 */
export async function setEmbeddingConfig(config: WikiEmbeddingConfig | null): Promise<void> {
  if (!config) {
    await prisma.appSetting.deleteMany({
      where: { key: { in: [EMBEDDING_PROVIDER_KEY, EMBEDDING_MODEL_KEY] } },
    });
    return;
  }
  const provider = await prisma.provider.findUnique({ where: { id: config.providerId } });
  if (!provider?.isActive) throw new Error("embedding 供应商不存在或未启用");
  await prisma.appSetting.upsert({
    where: { key: EMBEDDING_PROVIDER_KEY },
    create: { key: EMBEDDING_PROVIDER_KEY, value: config.providerId },
    update: { value: config.providerId },
  });
  await prisma.appSetting.upsert({
    where: { key: EMBEDDING_MODEL_KEY },
    create: { key: EMBEDDING_MODEL_KEY, value: config.modelId },
    update: { value: config.modelId },
  });
}

async function createEmbeddingModel(config: WikiEmbeddingConfig) {
  const provider = await prisma.provider.findUnique({ where: { id: config.providerId } });
  if (!provider?.isActive) throw new Error("embedding 供应商不存在或未启用");
  const client = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.apiBase,
    apiKey: provider.apiKey ?? undefined,
  });
  return client.textEmbeddingModel(config.modelId);
}

async function embedTexts(values: string[]): Promise<number[][]> {
  const config = await getEmbeddingConfig();
  if (!config || values.length === 0) return [];
  const model = await createEmbeddingModel(config);
  const embeddings: number[][] = [];
  for (let offset = 0; offset < values.length; offset += EMBED_BATCH) {
    const batch = values.slice(offset, offset + EMBED_BATCH);
    const { embeddings: batchEmbeddings } = await embedMany({ model, values: batch });
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}

/** 纯文本分块：段落聚合到目标长度，超长段落按句读/字符硬切。长文档 map-reduce 总结复用。 */
export function chunkPlainText(
  text: string,
  target = CHUNK_TARGET_CHARS,
  max = CHUNK_MAX_CHARS,
): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const hardSplit = (piece: string): string[] => {
    if (piece.length <= max) return [piece];
    const parts: string[] = [];
    let rest = piece;
    while (rest.length > max) {
      // 在最大长度内找最后一个句读断点，找不到就按字符切。
      const window = rest.slice(0, max);
      const cut =
        Math.max(window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf(". "), window.lastIndexOf("\n")) + 1;
      const at = cut > target * 0.5 ? cut : max;
      parts.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (rest.trim()) parts.push(rest);
    return parts;
  };
  const chunks: string[] = [];
  let buffer = "";
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) chunks.push(...hardSplit(trimmed));
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      flush();
      chunks.push(...hardSplit(paragraph));
      continue;
    }
    if (buffer.length + paragraph.length + 2 > target) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

/** 页面可嵌入文本：来源页 = 原文档全文 + 摘要页正文（两者都可被语义召回）。 */
async function embeddableTextForPage(row: {
  type: string;
  content: string;
  meta: string;
}): Promise<string> {
  if (row.type !== "source") return row.content;
  try {
    const meta = JSON.parse(row.meta) as { documentId?: unknown };
    if (typeof meta.documentId === "string" && meta.documentId) {
      const document = await prisma.wikiDocument.findUnique({
        where: { id: meta.documentId },
        select: { text: true },
      });
      if (document) return `${row.content}\n\n${document.text}`;
    }
  } catch {
    // meta 解析失败按普通页面处理
  }
  return row.content;
}

/** 重建一个页面的分块向量（未配置 embedding 时清掉旧分块）。 */
export async function reembedPath(scopeId: string, path: string): Promise<number> {
  const row = await prisma.wikiPage.findUnique({
    where: { scopeId_path: { scopeId, path } },
    select: { type: true, content: true, meta: true },
  });
  if (!row) {
    await prisma.wikiChunk.deleteMany({ where: { scopeId, path } });
    return 0;
  }
  const config = await getEmbeddingConfig();
  if (!config) {
    await prisma.wikiChunk.deleteMany({ where: { scopeId, path } });
    return 0;
  }
  const text = await embeddableTextForPage(row);
  const chunks = chunkPlainText(text);
  if (chunks.length === 0) {
    await prisma.wikiChunk.deleteMany({ where: { scopeId, path } });
    return 0;
  }
  const embeddings = await embedTexts(chunks);
  await prisma.wikiChunk.deleteMany({ where: { scopeId, path } });
  await prisma.wikiChunk.createMany({
    data: chunks.map((chunk, index) => ({
      scopeId,
      path,
      chunkIndex: index,
      text: chunk,
      embedding: JSON.stringify(embeddings[index] ?? []),
    })),
  });
  return chunks.length;
}

/** 重建整个 scope 的分块向量（设置变更 / 手动重建索引用），返回分块数。 */
export async function reembedScope(scopeId: string): Promise<number> {
  const pages = await prisma.wikiPage.findMany({
    where: { scopeId },
    select: { path: true },
  });
  // 先清孤儿分块：页面已删除（或路径变更）后残留的分块不再参与召回。
  if (pages.length === 0) {
    await prisma.wikiChunk.deleteMany({ where: { scopeId } });
  } else {
    await prisma.wikiChunk.deleteMany({
      where: { scopeId, path: { notIn: pages.map((page) => page.path) } },
    });
  }
  let total = 0;
  for (const page of pages) total += await reembedPath(scopeId, page.path);
  return total;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface WikiSimilarHit {
  path: string;
  score: number;
  snippet: string;
}

/** 查询向量召回：每个页面取最高分 chunk。未配置/出错返回空数组（调用方静默降级）。 */
export async function querySimilar(
  scopeId: string,
  queryText: string,
  topK = 8,
): Promise<WikiSimilarHit[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const [queryEmbedding, chunks] = await Promise.all([
    embedTexts([trimmed]).catch(() => null),
    prisma.wikiChunk.findMany({
      where: { scopeId },
      select: { path: true, text: true, embedding: true },
    }),
  ]);
  const query = queryEmbedding?.[0];
  if (!query || chunks.length === 0) return [];
  const best = new Map<string, { score: number; snippet: string }>();
  for (const chunk of chunks) {
    let vector: number[];
    try {
      vector = JSON.parse(chunk.embedding) as number[];
    } catch {
      continue;
    }
    const score = cosine(query, vector);
    const current = best.get(chunk.path);
    if (!current || score > current.score) {
      best.set(chunk.path, {
        score,
        snippet: `${chunk.text.slice(0, 140).replace(/\s+/g, " ")}…`,
      });
    }
  }
  return [...best.entries()]
    .map(([path, value]) => ({ path, ...value }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
