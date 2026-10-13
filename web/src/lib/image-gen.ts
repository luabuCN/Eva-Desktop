import { apiFetch, type ModelSelection } from "@/api";
import type { ChatUIMessage } from "@/lib/chat-utils";

/**
 * 对话内直出生图的前端常量与请求封装。
 *
 * 比例/风格表、张数与比例的关键词推断函数、图片模型命名正则是
 * server/src/images/image-service.ts 的静态复制（表很小，不值得为此增加
 * 拉取接口；推断用于生成中占位动画的预知，权威推断仍在服务端），改动时
 * 两边同步。
 */

/** 图片模型家族命名特征：过滤 providers 里可生图的模型。 */
export const IMAGE_MODEL_PATTERN =
  /(gpt-image|dall-e|cogview|seedream|seededit|qwen-image|hunyuan-image|flux|stable-diffusion|\bsd3\b|wanx|jimeng|image-generation)/i;

export interface AspectRatioOption {
  id: string;
  label: string;
  /** 选项图标按真实宽高比绘制（宽/高）。 */
  ratio?: number;
}

export const ASPECT_RATIOS: AspectRatioOption[] = [
  { id: "auto", label: "自动" },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
  { id: "2:3", label: "2:3", ratio: 2 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

export const DEFAULT_RATIO = "auto";

export interface ImageStyleOption {
  id: string;
  label: string;
}

export const IMAGE_STYLES: ImageStyleOption[] = [
  { id: "none", label: "无" },
  { id: "portrait", label: "人像摄影" },
  { id: "cinematic", label: "电影写真" },
  { id: "chinese", label: "中国风" },
  { id: "anime", label: "动漫" },
  { id: "render3d", label: "3D 渲染" },
  { id: "cyberpunk", label: "赛博朋克" },
  { id: "cg", label: "CG 动画" },
  { id: "ink", label: "水墨画" },
  { id: "oil", label: "油画" },
  { id: "classical", label: "古典" },
  { id: "watercolor", label: "水彩画" },
  { id: "cartoon", label: "卡通" },
];

export const DEFAULT_STYLE = "none";

/** 生成张数选项：0 表示「自动」，从提示词关键词推断（默认 1），上限 4。 */
export const IMAGE_COUNTS = [0, 1, 2, 3, 4] as const;

export function imageCountLabel(count: number): string {
  return count === 0 ? "自动" : `${count} 张`;
}

/**
 * 张数/比例的关键词推断：与 image-service.ts 同规则（静态复制）。这里只
 * 用于生成中的占位动画按即将生成的张数/比例绘制占位块；实际生效值由服务
 * 端权威推断并写入结果卡。
 */
export function inferCountFromPrompt(prompt: string): number | undefined {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 };
  const parse = (raw: string) => {
    const value = /^\d$/.test(raw) ? Number(raw) : digits[raw];
    return value && value >= 1 ? Math.min(value, 4) : undefined;
  };
  for (const match of prompt.matchAll(
    /(\d|[一二两三四])\s*[张幅份]\s*(?:图|图片|照片|壁纸|海报)/g,
  )) {
    const count = parse(match[1]);
    if (count) return count;
  }
  for (const match of prompt.matchAll(
    /(?:生成|画|绘制|出|来)\s*(\d|[一二两三四])\s*[张幅份]/g,
  )) {
    const count = parse(match[1]);
    if (count) return count;
  }
  return undefined;
}

export function inferRatioFromPrompt(prompt: string): string | undefined {
  for (const match of prompt.matchAll(/(\d{1,2})\s*[:：]\s*(\d{1,2})/g)) {
    const candidate = `${match[1]}:${match[2]}`;
    if (ASPECT_RATIOS.some((ratio) => ratio.id === candidate)) return candidate;
  }
  if (/横版|横图|横屏|横向|横幅|landscape|widescreen/i.test(prompt)) return "16:9";
  if (/竖版|竖图|竖屏|纵向|竖幅|portrait/i.test(prompt)) return "9:16";
  if (/方形|方图|正方|square/i.test(prompt)) return "1:1";
  return undefined;
}

/**
 * 普通对话下的生图意图识别（仅前端使用）：命中高置信生图信号时，提交自动
 * 改走直出生图（参数全自动推断），无需手动切换图像生成模式——对齐豆包。
 * 宁可漏判（走普通对话）也不错判：询问/编程/写作语境先整体排除；三类
 * 信号按置信度排列：
 *   1. 强动词「画/绘制」（“画一只猫”“帮我画个太阳”）；
 *   2. 泛动词 + 图类名词（“生成一张图”“创建一个皮卡丘的图片”）；
 *   3. 作品名词 + 风格/比例词（“厚涂油画风格猫咪插画 比例1:1”）。
 * 超长文本（>300）不识别——粘贴的长文即使含生图词也不应触发。
 */
export function isImageGenPrompt(text: string): boolean {
  const prompt = text.trim();
  if (!prompt || prompt.length > 300) return false;
  // 询问/编程/写作语境：意图是学习、开发或加工文字，而非要图（“用 React
  // 画一个页面”“生成图片的脚本”“写一篇插画分析”）。
  if (
    /怎么|如何|为什么|教程|原理|代码|脚本|函数|接口|api|sdk|调用|canvas|svg|react|vue|html|css|页面|网页|组件|界面|写一篇|文章|分析|论文|作文|翻译|总结|解释|介绍一/i.test(
      prompt,
    )
  ) {
    return false;
  }
  // 强动词：画/绘制。出现在句首或请求前缀后，宾语不限（“画一只猫”）。
  if (/(?:^|[，。,.!！?？；;\s])(?:请|帮我|给我|帮忙|麻烦|我要|我想|想要)?\s*(画|绘制)/.test(prompt)) {
    return true;
  }
  // 泛动词 + 量词 + 图：“生成一张图”“出一幅图”。
  if (/(生成|创作|设计|创建|制作|出)\s*(一|两)?\s*[张幅]\s*图/.test(prompt)) {
    return true;
  }
  // 泛动词 + 短修饰 + 明确图类名词：“创建一个皮卡丘的图片”“设计个logo”。
  if (
    /(生成|创作|设计|创建|制作)\s*(一|两)?\s*[张幅个只条]?[^，。,.!！?？；;\s]{0,12}(图片|图像|插画|插图|画像|海报|壁纸|头像|照片|logo|图标|封面|漫画)/i.test(
      prompt,
    )
  ) {
    return true;
  }
  // 作品名词 + 风格/比例词：“厚涂油画风格猫咪插画 比例1:1”“竖版胶片风海报”。
  if (
    /(插画|海报|壁纸|头像|封面|漫画)/.test(prompt) &&
    /(风格|比例|横版|竖版|横向|纵向|写实|油画|水彩|水墨|国风|国潮|新中式|动漫|二次元|赛博|像素|扁平|胶片|清新|治愈|卡通|3d)/i.test(
      prompt,
    )
  ) {
    return true;
  }
  return false;
}

export function imageStyleLabel(id: string): string {
  return IMAGE_STYLES.find((style) => style.id === id)?.label ?? id;
}

export function aspectRatioLabel(id: string): string {
  return ASPECT_RATIOS.find((ratio) => ratio.id === id)?.label ?? id;
}

/** 图像生成模式的参数行状态；model 为 null、count 为 0 均表示「自动」。 */
export interface ImageGenOptions {
  model: ModelSelection | null;
  ratio: string;
  style: string;
  count: number;
}

export const DEFAULT_IMAGE_GEN_OPTIONS: ImageGenOptions = {
  model: null,
  ratio: DEFAULT_RATIO,
  style: DEFAULT_STYLE,
  count: 0,
};

export interface ImageGenRequest {
  /** 会话 id；缺省服务端新建。 */
  id?: string;
  /** 全量历史（服务端整体快照持久化，与 /api/chat 同构）。 */
  messages: ChatUIMessage[];
  prompt: string;
  model?: ModelSelection;
  ratio?: string;
  style?: string;
  count?: number;
  projectId?: string;
}

export interface ImageGenResponse {
  id: string;
  /** 追加到会话末尾的 user/assistant 两条新消息（已持久化）。 */
  messages: ChatUIMessage[];
}

export function generateImages(
  input: ImageGenRequest,
  signal?: AbortSignal,
): Promise<ImageGenResponse> {
  return apiFetch<ImageGenResponse>("/api/images/generate", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}
