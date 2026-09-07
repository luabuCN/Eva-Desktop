import { Cron } from "croner";

/**
 * cron 表达式的纯函数工具。独立成模块（只依赖 croner）是为了让工具提供方
 * （cron-provider）静态引用它们时不把 cron-service → agent-runtime 的边带进
 * registry 的模块加载顺序里。
 */

/** croner 以暂停模式构造一遍来校验表达式；非法 pattern 会在构造时抛错。 */
export function isValidCronPattern(pattern: string): boolean {
  if (!pattern.trim()) return false;
  try {
    const probe = new Cron(pattern, { paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

/** 表达式下一次触发时间（本机时区，ISO 字符串）；无效或不再触发返回 null。 */
export function nextRunFor(pattern: string): string | null {
  try {
    const probe = new Cron(pattern, { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}
