import { prisma } from "../../db.js";

/**
 * bash 工具的命令级放行（allowlist）：
 *
 * 工具级审批（confirm 模式逐条弹卡、approve_always 一次放开整个 bash）
 * 粒度太粗——安全的是"某几类命令"，不是"bash 这个工具"。这里把粒度
 * 收到命令层：内置一张保守的只读命令表（git status/diff/log、ls、cat
 * ……天然无副作用），叠加用户自建规则（全局或项目级），命中的命令跳过
 * 审批直接执行；其余照常弹卡。plan 模式的门控同样用它放行只读命令，
 * 让调研阶段能跑 git log / grep。
 *
 * 安全边界（宁可不放行，不可放过）：
 * - 复合命令（&& || ; | & 换行）逐段检查，任何一段不认识都整体弹卡；
 * - 命令包含重定向/替换语法（> < ` $(）时永不放行——重定向可以 把
 *   "只读"命令变成写文件；
 * - 前缀匹配按 token 边界（"pnpm test" 不匹配 "pnpm test2"），比较不
 *   区分大小写（Windows 命令行本身不区分）；
 * - 审批卡一键建规则时推导保守前缀，危险可执行文件（rm / git push /
 *   Remove-Item …）硬拒绝，单 token 的宽口径可执行文件（git、npm、
 *   node 本体）也拒绝。
 */

export type CommandMatchType = "prefix" | "exact";

export interface CommandRulePattern {
  pattern: string;
  matchType: CommandMatchType;
}

/** 内置只读安全表。prefix = 任意参数都只读；exact = 仅裸命令只读
 * （如 `git branch` 列分支，带参数就是增删分支）。 */
export const BUILTIN_SAFE_RULES: CommandRulePattern[] = [
  { pattern: "git status", matchType: "prefix" },
  { pattern: "git diff", matchType: "prefix" },
  { pattern: "git log", matchType: "prefix" },
  { pattern: "git show", matchType: "prefix" },
  { pattern: "git blame", matchType: "prefix" },
  { pattern: "git rev-parse", matchType: "prefix" },
  { pattern: "git ls-files", matchType: "prefix" },
  { pattern: "git branch", matchType: "exact" },
  { pattern: "git remote", matchType: "exact" },
  { pattern: "git config --get", matchType: "prefix" },
  { pattern: "ls", matchType: "prefix" },
  { pattern: "dir", matchType: "prefix" },
  { pattern: "tree", matchType: "prefix" },
  { pattern: "cat", matchType: "prefix" },
  { pattern: "head", matchType: "prefix" },
  { pattern: "tail", matchType: "prefix" },
  { pattern: "wc", matchType: "prefix" },
  { pattern: "grep", matchType: "prefix" },
  { pattern: "findstr", matchType: "prefix" },
  { pattern: "Get-Content", matchType: "prefix" },
  { pattern: "Get-ChildItem", matchType: "prefix" },
  { pattern: "Get-Item", matchType: "prefix" },
  { pattern: "pwd", matchType: "exact" },
  { pattern: "whoami", matchType: "exact" },
  { pattern: "echo", matchType: "prefix" },
  { pattern: "which", matchType: "prefix" },
  { pattern: "where", matchType: "prefix" },
];

/** 这些可执行文件的第一段出现在命令里时，拒绝推导放行规则。 */
const DANGEROUS_EXECUTABLES = new Set([
  "rm", "del", "erase", "rd", "rmdir", "remove-item", "ri",
  "format", "shutdown", "kill", "taskkill", "sudo",
  "dd", "mkfs", "reg", "regedit", "mv", "move", "cp", "copy",
]);

/** 危险的 git 子命令（首两 token 命中即拒绝推导）。 */
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "push", "reset", "clean", "checkout", "switch", "restore", "rebase", "filter-branch",
]);

/** 单 token 规则等于"这个程序随便跑"——对这类宽口径工具拒绝推导。 */
const BROAD_EXECUTABLES = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "node", "deno",
  "python", "python3", "pip", "uv", "pip3", "cargo", "go", "dotnet",
  "java", "docker", "podman", "powershell", "pwsh", "cmd", "bash", "sh", "make",
]);

/** 含这些语法的命令永不放行：重定向可把只读命令变成写，替换可藏任意代码。 */
const UNSAFE_SHELL_SYNTAX = /[>`]|\$\(|</;

/** 按空白分词，尊重单双引号，引号内容算一个 token。 */
export function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 拆复合命令：&& || ; | & 换行分隔的每段都要单独过检。 */
export function splitCompoundCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|&\n\r]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function matchesRule(tokens: string[], rule: CommandRulePattern): boolean {
  const patternTokens = tokenizeCommand(rule.pattern).map((token) => token.toLowerCase());
  if (patternTokens.length === 0) return false;
  const actual = tokens.map((token) => token.toLowerCase());
  if (actual.length < patternTokens.length) return false;
  if (rule.matchType === "exact" && actual.length !== patternTokens.length) return false;
  return patternTokens.every((token, index) => actual[index] === token);
}

function segmentAllowed(segment: string, rules: CommandRulePattern[]): boolean {
  const tokens = tokenizeCommand(segment);
  if (tokens.length === 0) return false;
  return rules.some((rule) => matchesRule(tokens, rule));
}

export interface CommandClassification {
  allowed: boolean;
  /** 命中的规则（内置表或用户规则），供调试/展示。 */
  matchedBy?: string;
}

/** 整条命令是否可免审批执行：无危险语法 + 每一段都被某条规则覆盖。 */
export function classifyCommand(
  command: string,
  userRules: CommandRulePattern[] = [],
): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false };
  if (UNSAFE_SHELL_SYNTAX.test(trimmed)) return { allowed: false };
  const rules = [...BUILTIN_SAFE_RULES, ...userRules];
  const segments = splitCompoundCommand(trimmed);
  if (segments.length === 0) return { allowed: false };
  for (const segment of segments) {
    const hit = rules.find((rule) => matchesRule(tokenizeCommand(segment), rule));
    if (!hit) return { allowed: false };
  }
  const firstHit = rules.find((rule) => matchesRule(tokenizeCommand(segments[0]!), rule));
  return { allowed: true, matchedBy: firstHit?.pattern };
}

/** 审批卡「始终允许此类命令」要保存的规则：取保守 token 前缀。
 * 推不出安全前缀（危险可执行文件 / 单 token 宽口径）时返回 null。 */
export function deriveAllowRule(command: string): CommandRulePattern | null {
  const firstSegment = splitCompoundCommand(command)[0];
  if (!firstSegment || UNSAFE_SHELL_SYNTAX.test(command)) return null;
  const tokens = tokenizeCommand(firstSegment);
  if (tokens.length === 0) return null;
  const executable = tokens[0]!.toLowerCase();

  if (DANGEROUS_EXECUTABLES.has(executable)) return null;
  if (executable === "git" && tokens[1] && DANGEROUS_GIT_SUBCOMMANDS.has(tokens[1]!.toLowerCase())) {
    return null;
  }

  // 取前 1-3 个 token：可执行文件 + 不以 - 开头的子命令；包管理器 run 再多一个。
  let count = 1;
  if (tokens[1] && !tokens[1]!.startsWith("-")) count = 2;
  if (count === 2 && ["npm", "pnpm", "yarn", "bun"].includes(executable) && tokens[1]!.toLowerCase() === "run" && tokens[2]) {
    count = 3;
  }
  if (count === 1 && BROAD_EXECUTABLES.has(executable)) return null;
  return { pattern: tokens.slice(0, count).join(" "), matchType: "prefix" };
}

/** 加载用户规则：全局（projectId 为空）+ 指定项目的，合并去抖后供分类。 */
export async function loadCommandRulePatterns(projectId?: string): Promise<CommandRulePattern[]> {
  const rows = await prisma.commandRule.findMany({
    where: projectId ? { OR: [{ projectId: null }, { projectId }] } : { projectId: null },
    select: { pattern: true, matchType: true },
  });
  return rows.map((row) => ({
    pattern: row.pattern,
    matchType: row.matchType === "exact" ? "exact" : "prefix",
  }));
}

/** 审批桥 / plan 门控共用的完整判定：加载规则并分类。 */
export async function isCommandAllowed(
  command: string,
  projectId?: string,
): Promise<boolean> {
  try {
    const rules = await loadCommandRulePatterns(projectId);
    return classifyCommand(command, rules).allowed;
  } catch {
    // 规则加载失败按未放行处理，宁可多问一次。
    return false;
  }
}
