/** 错误文案展示兜底：服务端已在流出口改写新错误，这里覆盖历史消息与
 * 数据库回放的原始错误串（含堆栈 JSON dump），保证任何入口都不把
 * 技术细节直接怼在用户脸上。 */

const RAW_CAP = 200;

interface ParsedDump {
  message: string;
  statusCode?: number;
}

function parseDump(raw: string): ParsedDump | undefined {
  const text = raw.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const statusCode =
      typeof parsed.statusCode === "number"
        ? parsed.statusCode
        : typeof parsed.status === "number"
          ? (parsed.status as number)
          : undefined;
    return message || statusCode !== undefined ? { message, statusCode } : undefined;
  } catch {
    return undefined;
  }
}

/** 原文是否是技术细节 dump（JSON/堆栈）——决定要不要挂"技术详情"折叠。 */
export function isRawErrorDump(raw: string): boolean {
  const text = raw.trim();
  return text.startsWith("{") || /\n\s+at\s+\S+/.test(text);
}

function classify(raw: string, statusCode?: number): string {
  const notFound = raw.match(/ENOTFOUND\s+([a-zA-Z0-9._-]+)/);
  if (notFound) {
    return `无法连接模型服务：域名解析失败（${notFound[1]}）。请检查本机网络或代理设置后重试。`;
  }
  if (/ECONNREFUSED/.test(raw)) {
    return "无法连接模型服务：连接被拒绝。请检查网络、防火墙或代理设置。";
  }
  if (/ETIMEDOUT|socket\ timeout|Request timed out|AbortError/i.test(raw)) {
    return "模型服务请求超时，请检查网络后重试。";
  }
  if (/ECONNRESET|other side closed|socket hang up|Connection error/i.test(raw)) {
    return "与模型服务的连接被中断，请重试；若频繁出现请检查网络或代理。";
  }
  if (/fetch failed|network error/i.test(raw)) {
    return "网络请求失败：无法访问模型服务，请检查网络或代理设置。";
  }
  const code = statusCode ?? Number(raw.match(/\b(401|403|404|429|5\d{2})\b/)?.[1] ?? NaN);
  if (code === 401 || /Unauthorized|invalid[ _-]?api[ _-]?key/i.test(raw)) {
    return "模型服务认证失败：API Key 无效或已过期，请在设置中检查密钥。";
  }
  if (code === 403) {
    return "无权访问该模型（403）：请检查 API Key 权限或更换模型。";
  }
  if (code === 404) {
    return "模型或接口不存在（404）：请检查所选模型 ID 是否正确。";
  }
  if (code === 429 || /rate[ _-]?limit|quota/i.test(raw)) {
    return "请求过于频繁或额度不足（429）：请稍后重试或检查账户额度。";
  }
  if (code >= 500 && code < 600) {
    return `模型服务暂时不可用（${code}），请稍后重试。`;
  }
  return "";
}

function fallbackText(raw: string): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const cleaned = firstLine.replace(/^[A-Za-z]*(?:Error|Exception):\s*/, "").trim();
  const text = cleaned || "请求失败，请重试。";
  return text.length > RAW_CAP ? `${text.slice(0, RAW_CAP)}…` : text;
}

/** 识别不了的原文原样返回（已是友好文案时幂等）。 */
export function friendlyErrorText(raw: string): string {
  const dump = parseDump(raw);
  const source = dump?.message || raw;
  const single = dump ? source.split("\n", 1)[0] ?? source : source;
  return classify(single, dump?.statusCode) || fallbackText(single);
}

/** 供"技术详情"折叠展示的原文（截断）；非 dump 返回 undefined。 */
export function rawErrorDetail(raw: string): string | undefined {
  if (!isRawErrorDump(raw)) return undefined;
  return raw.length > 4_000 ? `${raw.slice(0, 4_000)}…` : raw;
}
