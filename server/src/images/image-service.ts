import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { SafeFsProvider } from "../safe-fs.js";
import { recordFileChange } from "../runtime/file-changes.js";

/**
 * 图片生成共享服务：图片模型解析、比例映射、风格拼接、OpenAI 兼容
 * /images/generations 调用与工作区落盘。对话内直出端点
 * （routes/images.ts）与 agent 生图工具（runtime/tools/image-provider.ts）
 * 共用同一实现，避免双份漂移。
 *
 * 前端的展示常量（web/src/lib/image-gen.ts）与本文件的比例/风格表是静态
 * 复制关系，改动时两边同步。
 */

/** 图片模型家族命名特征：自动发现按它匹配启用中的模型 id。 */
export const IMAGE_MODEL_PATTERN =
  /(gpt-image|dall-e|cogview|seedream|seededit|qwen-image|hunyuan-image|flux|stable-diffusion|\bsd3\b|wanx|jimeng|image-generation)/i;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ImageModelRef {
  apiBase: string;
  apiKey?: string;
  modelId: string;
  providerName: string;
}

function parseModels(value: string): Array<{ id: string; enabled: boolean }> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && typeof entry.id === "string",
      )
      .map((entry) => ({ id: entry.id as string, enabled: entry.enabled !== false }));
  } catch {
    return [];
  }
}

/**
 * 图片模型发现：显式指定优先（校验 Provider 可用），否则按创建顺序扫描
 * 启用中的 Provider，取第一个命名匹配图片特征的启用模型。
 */
export async function resolveImageModel(
  override?: { providerId: string; modelId: string },
): Promise<ImageModelRef | undefined> {
  const rows = await prisma.provider.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, apiBase: true, apiKey: true, isActive: true, models: true },
  });
  if (override) {
    const row = rows.find((entry) => entry.id === override.providerId);
    if (!row?.isActive) {
      throw new Error(
        `固定图片模型的供应商不可用（${override.providerId}），请更新子智能体设置或清除固定。`,
      );
    }
    return {
      apiBase: row.apiBase,
      apiKey: row.apiKey ?? undefined,
      modelId: override.modelId,
      providerName: row.name,
    };
  }
  for (const row of rows) {
    if (!row.isActive) continue;
    const model = parseModels(row.models ?? "").find(
      (entry) => entry.enabled && IMAGE_MODEL_PATTERN.test(entry.id),
    );
    if (model) {
      return {
        apiBase: row.apiBase,
        apiKey: row.apiKey ?? undefined,
        modelId: model.id,
        providerName: row.name,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 比例：UI 选项 → 接口 size 参数
// ---------------------------------------------------------------------------

export type AspectOrientation = "square" | "landscape" | "portrait";

export interface AspectRatioOption {
  id: string;
  label: string;
  orientation: AspectOrientation;
  /** 非 OpenAI 家族使用的精确尺寸（多数兼容网关接受任意 WxH）。 */
  size?: string;
}

export const ASPECT_RATIOS: AspectRatioOption[] = [
  { id: "auto", label: "自动", orientation: "square" },
  { id: "9:16", label: "9:16", orientation: "portrait", size: "864x1536" },
  { id: "2:3", label: "2:3", orientation: "portrait", size: "1024x1536" },
  { id: "3:4", label: "3:4", orientation: "portrait", size: "960x1280" },
  { id: "1:1", label: "1:1", orientation: "square", size: "1024x1024" },
  { id: "4:3", label: "4:3", orientation: "landscape", size: "1280x960" },
  { id: "3:2", label: "3:2", orientation: "landscape", size: "1536x1024" },
  { id: "16:9", label: "16:9", orientation: "landscape", size: "1536x864" },
];

export const ASPECT_RATIO_IDS = ASPECT_RATIOS.map((ratio) => ratio.id);

/** OpenAI 家族（gpt-image / dall-e）只支持三档尺寸，按方向就近映射。 */
const OPENAI_SIZE_BY_ORIENTATION: Record<AspectOrientation, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/** 比例 id → 接口 size 参数；"auto" 不传 size，由模型自定。 */
export function resolveSize(ratioId: string | undefined, modelId: string): string | undefined {
  const ratio = ASPECT_RATIOS.find((entry) => entry.id === ratioId) ?? ASPECT_RATIOS[0];
  if (ratio.id === "auto") return undefined;
  if (/gpt-image|dall-e/i.test(modelId)) {
    return OPENAI_SIZE_BY_ORIENTATION[ratio.orientation];
  }
  return ratio.size;
}

// ---------------------------------------------------------------------------
// 风格：预设后缀拼接进提示词（英文后缀效果更稳）
// ---------------------------------------------------------------------------

export interface ImageStyleOption {
  id: string;
  label: string;
  promptSuffix?: string;
}

export const IMAGE_STYLES: ImageStyleOption[] = [
  { id: "none", label: "无" },
  {
    id: "portrait",
    label: "人像摄影",
    promptSuffix: "professional portrait photography, 85mm lens, soft studio lighting",
  },
  {
    id: "cinematic",
    label: "电影写真",
    promptSuffix: "cinematic film still, dramatic lighting, shallow depth of field",
  },
  {
    id: "chinese",
    label: "中国风",
    promptSuffix: "traditional Chinese style, ink-wash aesthetics, elegant composition",
  },
  {
    id: "anime",
    label: "动漫",
    promptSuffix: "anime style, cel shading, vibrant colors",
  },
  {
    id: "render3d",
    label: "3D 渲染",
    promptSuffix: "3D render, octane render, high detail, studio lighting",
  },
  {
    id: "cyberpunk",
    label: "赛博朋克",
    promptSuffix: "cyberpunk style, neon lights, futuristic city, high contrast",
  },
  {
    id: "cg",
    label: "CG 动画",
    promptSuffix: "CG animation style, polished, pixar-like rendering",
  },
  {
    id: "ink",
    label: "水墨画",
    promptSuffix: "Chinese ink wash painting, minimal, expressive brush strokes",
  },
  {
    id: "oil",
    label: "油画",
    promptSuffix: "oil painting, visible brush texture, rich colors",
  },
  {
    id: "classical",
    label: "古典",
    promptSuffix: "classical painting, renaissance composition, muted palette",
  },
  {
    id: "watercolor",
    label: "水彩画",
    promptSuffix: "watercolor painting, soft washes, paper texture",
  },
  {
    id: "cartoon",
    label: "卡通",
    promptSuffix: "cartoon style, flat illustration, bold outlines",
  },
];

export const IMAGE_STYLE_IDS = IMAGE_STYLES.map((style) => style.id);

/** 风格后缀拼接；none/未知 id 原样返回。 */
export function buildPrompt(prompt: string, styleId?: string): string {
  const style = IMAGE_STYLES.find((entry) => entry.id === styleId);
  if (!style?.promptSuffix) return prompt;
  return `${prompt}, ${style.promptSuffix}`;
}

// ---------------------------------------------------------------------------
// 提示词关键词推断：UI 参数为“自动/无”时，从自然语言里提取比例与风格
// ---------------------------------------------------------------------------

/**
 * 从提示词推断比例：明确写出的宽高比（“比例3:4”“3:4”）优先，且必须命中
 * 内置比例表——避免把“17:00”这类时间数字对误判为比例；其次方向词
 * （横版/竖版/方形）。推断不出返回 undefined（维持模型自定）。
 */
export function inferRatioFromPrompt(prompt: string): string | undefined {
  for (const match of prompt.matchAll(/(\d{1,2})\s*[:：]\s*(\d{1,2})/g)) {
    const candidate = `${match[1]}:${match[2]}`;
    if (ASPECT_RATIO_IDS.includes(candidate)) return candidate;
  }
  if (/横版|横图|横屏|横向|横幅|landscape|widescreen/i.test(prompt)) return "16:9";
  if (/竖版|竖图|竖屏|纵向|竖幅|portrait/i.test(prompt)) return "9:16";
  if (/方形|方图|正方|square/i.test(prompt)) return "1:1";
  return undefined;
}

/** 风格关键词 → 风格 id：只收录高置信词（预设 label 本名与常用别名），
 *  按表顺序取第一个命中；“插画”这类宽泛词不映射，避免过度推断。 */
const STYLE_KEYWORDS: Array<[pattern: RegExp, styleId: string]> = [
  [/人像摄影|人像写真/, "portrait"],
  [/电影写真|电影感|电影级|cinematic/i, "cinematic"],
  [/新中式|国潮|国风|中国风/, "chinese"],
  [/动漫|二次元|anime/i, "anime"],
  [/3D\s*渲染|三维渲染/, "render3d"],
  [/赛博朋克|cyberpunk/i, "cyberpunk"],
  [/CG\s*动画|皮克斯|pixar/i, "cg"],
  [/水墨/, "ink"],
  [/油画/, "oil"],
  [/古典/, "classical"],
  [/水彩/, "watercolor"],
  [/卡通/, "cartoon"],
];

export function inferStyleFromPrompt(prompt: string): string | undefined {
  for (const [pattern, styleId] of STYLE_KEYWORDS) {
    if (pattern.test(prompt)) return styleId;
  }
  return undefined;
}

/**
 * 从提示词推断生成张数：只命中高置信写法——量词「张/幅/份」后接图类名词
 * （“两张图”“4张照片”），或生成类动词紧邻数量（“生成3张”“画两幅”）；
 * 避免把“两张脸”“夸张”这类描述误判为张数。结果 clamp 到 1-4（直出端点
 * 上限），推断不出返回 undefined（维持默认 1 张）。
 */
const COUNT_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 };

function parseCountDigit(raw: string): number | undefined {
  const value = /^\d$/.test(raw) ? Number(raw) : COUNT_DIGITS[raw];
  if (!value || value < 1) return undefined;
  return Math.min(value, 4);
}

export function inferCountFromPrompt(prompt: string): number | undefined {
  for (const match of prompt.matchAll(
    /(\d|[一二两三四])\s*[张幅份]\s*(?:图|图片|照片|壁纸|海报)/g,
  )) {
    const count = parseCountDigit(match[1]);
    if (count) return count;
  }
  for (const match of prompt.matchAll(
    /(?:生成|画|绘制|出|来)\s*(\d|[一二两三四])\s*[张幅份]/g,
  )) {
    const count = parseCountDigit(match[1]);
    if (count) return count;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 接口调用与落盘
// ---------------------------------------------------------------------------

/**
 * 调用 OpenAI 兼容 /images/generations，返回全部产物的字节。
 * dall-e 系列默认返回 url，需要显式要 b64；gpt-image / qwen-image 系
 * 列原生返回 b64，多余的参数部分网关会拒绝，因此只在 dall-e 时携带。
 */
export async function fetchImages(
  model: ImageModelRef,
  prompt: string,
  size: string | undefined,
  count: number,
  signal?: AbortSignal,
): Promise<Buffer[]> {
  const body: Record<string, unknown> = {
    model: model.modelId,
    prompt,
    n: count,
    ...(size ? { size } : {}),
    ...(/dall-e/i.test(model.modelId) ? { response_format: "b64_json" } : {}),
  };
  const response = await fetch(`${model.apiBase.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`图片生成接口返回 ${response.status}：${detail || response.statusText}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const entries = payload.data ?? [];
  if (entries.length === 0) {
    throw new Error("图片接口未返回 b64_json 或 url 数据。");
  }
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    if (entry?.b64_json) {
      buffers.push(Buffer.from(entry.b64_json, "base64"));
      continue;
    }
    if (entry?.url) {
      const download = await fetch(entry.url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!download.ok) {
        throw new Error(`图片下载失败（${download.status}）：${entry.url.slice(0, 200)}`);
      }
      buffers.push(Buffer.from(await download.arrayBuffer()));
      continue;
    }
    throw new Error("图片接口未返回 b64_json 或 url 数据。");
  }
  return buffers;
}

export interface SavedImageFile {
  absolutePath: string;
  /** 工作区相对路径（正斜杠），消息 data part 与变更面板都用它。 */
  relativePath: string;
  filename: string;
  bytes: number;
}

/**
 * 单张图片落盘并登记变更面板：target 缺省 assets/image-<timestamp>.png，
 * 无图片扩展名时补 .png；图片是二进制产物，不存快照，只登记路径与新建标记。
 */
export async function saveImageToWorkspace(input: {
  workspacePath: string;
  bytes: Buffer;
  target?: string;
  runId?: string;
  conversationId: string;
  projectId?: string;
}): Promise<SavedImageFile> {
  if (input.bytes.byteLength === 0) throw new Error("图片接口返回了空文件。");
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`生成的图片超过 ${MAX_IMAGE_BYTES} 字节限制，未保存。`);
  }

  const fsProvider = new SafeFsProvider(input.workspacePath);
  const target = input.target?.trim() || `assets/image-${Date.now()}.png`;
  const withExtension = IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase())
    ? target
    : `${target}.png`;
  const resolved = fsProvider.resolvePath(withExtension);
  const existed = await fsProvider.exists(resolved).catch(() => false);

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, input.bytes);
  await recordFileChange({
    runId: input.runId,
    conversationId: input.conversationId,
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    absolutePath: resolved,
    before: null,
    after: null,
    existed,
  });
  return {
    absolutePath: resolved,
    relativePath: path.relative(input.workspacePath, resolved).replaceAll("\\", "/"),
    filename: path.basename(resolved),
    bytes: input.bytes.byteLength,
  };
}

// ---------------------------------------------------------------------------
// 对话内直出编排（routes/images.ts 使用）
// ---------------------------------------------------------------------------

export interface GenerateImagesInput {
  prompt: string;
  ratio?: string;
  style?: string;
  count?: number;
  /** 显式固定图片模型；缺省按命名特征自动发现。 */
  model?: { providerId: string; modelId: string };
  workspacePath: string;
  conversationId: string;
  projectId?: string;
  signal?: AbortSignal;
}

export interface GenerateImagesResult {
  files: SavedImageFile[];
  /** "Provider/modelId"，结果卡的参数摘要展示用。 */
  modelLabel: string;
  /** 拼接风格后缀后的最终提示词。 */
  finalPrompt: string;
}

export async function generateImages(input: GenerateImagesInput): Promise<GenerateImagesResult> {
  if (input.signal?.aborted) throw new Error("已取消生成。");
  const model = await resolveImageModel(input.model);
  if (!model) {
    throw new Error(
      "没有可用的图片生成模型：请在设置中启用一个图片模型（如 gpt-image / qwen-image / cogview / seedream 系列），或在参数行里显式选择。",
    );
  }

  const finalPrompt = buildPrompt(input.prompt, input.style);
  const size = resolveSize(input.ratio, model.modelId);
  const count = Math.min(Math.max(input.count ?? 1, 1), 4);
  const buffers = await fetchImages(model, finalPrompt, size, count, input.signal);

  const stamp = Date.now();
  const files: SavedImageFile[] = [];
  for (const [index, bytes] of buffers.entries()) {
    files.push(
      await saveImageToWorkspace({
        workspacePath: input.workspacePath,
        bytes,
        target:
          buffers.length > 1
            ? `assets/image-${stamp}-${index + 1}.png`
            : `assets/image-${stamp}.png`,
        conversationId: input.conversationId,
        projectId: input.projectId,
      }),
    );
  }
  return {
    files,
    modelLabel: `${model.providerName}/${model.modelId}`,
    finalPrompt,
  };
}
