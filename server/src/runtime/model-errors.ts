/** 模型调用错误 → 用户可读文案。原始错误（含堆栈的 JSON dump、内部 URL）
 * 不应直达聊天界面：在流出口处改写，服务端日志保留原文便于排查。 */

const RAW_CAP = 200;

interface ParsedDump {
  message: string;
  statusCode?: number;
}

/** AI_APICallError 等常被 JSON.stringify 整体序列化（截图里的红色大 JSON）。
 * 先尝试解析出 message / statusCode 再分类。 */
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

/** 取首行、去掉异常名前缀并截断，作为兜底展示。 */
function fallbackText(raw: string): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const cleaned = firstLine.replace(/^[A-Za-z]*(?:Error|Exception):\s*/, "").trim();
  const text = cleaned || "模型调用失败，请重试。";
  return text.length > RAW_CAP ? `${text.slice(0, RAW_CAP)}…` : text;
}

export function friendlyModelErrorText(raw: string): string {
  const dump = parseDump(raw);
  const source = dump?.message || raw;
  // dump 里剥出的 message 可能仍带堆栈或多行，分类只看内容本身。
  const single = dump ? source.split("\n", 1)[0] ?? source : source;
  return classify(single, dump?.statusCode) || fallbackText(single);
}
