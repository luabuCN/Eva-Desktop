import type { ToolPart } from "@/lib/chat-utils";

/** 动作类别决定一行式工具调用的图标与措辞（参考 PI-Desktop 的 ToolRow）。 */
export type ToolAction =
  | "read" | "list" | "search" | "write" | "edit" | "run" | "git" | "task"
  | "delegate" | "browse" | "cron" | "use";

export interface ToolDisplay {
  action: ToolAction;
  /** 已完成的动词，如“读取”“修改”。 */
  verb: string;
  /** 进行中的动词，如“正在读取”。 */
  runningVerb: string;
  /** 一行摘要：文件路径 / 命令 / 模式等主要参数。 */
  summary: string;
}

const MAX_SUMMARY_LEN = 80;

function truncateSummary(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SUMMARY_LEN) return compact;
  return `${compact.slice(0, MAX_SUMMARY_LEN)}…`;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.trim();
}

type ToolInput = Record<string, unknown>;

function pickString(input: ToolInput | undefined, keys: string[]): string | undefined {
  if (!input) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** 各工具的参数名不同，这里按优先级挑出最值得展示的一项。 */
const SUMMARY_KEYS = [
  "path",
  "filePath",
  "file",
  "command",
  "pattern",
  "query",
  "dirPath",
  "dir",
  "url",
  "name",
  "branch",
  "message",
  "subject",
  "taskId",
];

function summaryOf(input: ToolInput | undefined, extra?: string): string {
  const base = extra ?? pickString(input, SUMMARY_KEYS) ?? "";
  return truncateSummary(base);
}

/** 未知/动态注册的工具：仍给出一行摘要，取常见参数或简短 JSON。 */
function fallbackDisplay(name: string, input: ToolInput | undefined): ToolDisplay {
  const summary = summaryOf(input);
  return {
    action: "use",
    verb: name,
    runningVerb: name,
    summary: summary && summary !== name ? summary : "",
  };
}

const GIT_VERBS: Record<string, string> = {
  gitStatus: "查看状态",
  gitDiff: "查看差异",
  gitLog: "查看日志",
  gitCommit: "提交",
  gitBranch: "分支",
  gitCheckout: "切换分支",
  gitPull: "拉取",
  gitPush: "推送",
};

const TASK_VERBS: Record<string, string> = {
  TaskCreate: "新建任务",
  TaskGet: "查看任务",
  TaskList: "任务列表",
  TaskUpdate: "更新任务",
};

const DELEGATE_VERBS: Record<string, string> = {
  DelegateWait: "等待委派",
  DelegateList: "查看委派",
  DelegateStop: "停止委派",
};

const CRON_VERBS: Record<string, string> = {
  CronList: "查看定时任务",
  CronDelete: "删除定时任务",
  CronRunNow: "立即运行任务",
};

/** 工具调用的一行式描述：动词随状态（进行中/已完成）变化，摘要取主要参数。 */
export function describeTool(part: ToolPart): ToolDisplay {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
  const input = ("input" in part && typeof part.input === "object" && part.input !== null
    ? (part.input as ToolInput)
    : undefined) as ToolInput | undefined;

  const running = (verb: string) => `正在${verb}`;
  switch (name) {
    case "readFile":
      return { action: "read", verb: "读取", runningVerb: running("读取"), summary: summaryOf(input) };
    case "writeFile":
      return { action: "write", verb: "写入", runningVerb: running("写入"), summary: summaryOf(input) };
    case "editFile":
      return { action: "edit", verb: "修改", runningVerb: running("修改"), summary: summaryOf(input) };
    case "listFiles":
      return { action: "list", verb: "列目录", runningVerb: running("列出"), summary: summaryOf(input) };
    case "mkdir":
      return { action: "write", verb: "新建目录", runningVerb: running("创建"), summary: summaryOf(input) };
    case "glob": {
      const pattern = pickString(input, ["pattern"]) ?? "";
      const dir = pickString(input, ["dirPath"]);
      return {
        action: "search",
        verb: "匹配文件",
        runningVerb: running("匹配"),
        summary: dir ? truncateSummary(`${pattern} @ ${dir}`) : truncateSummary(pattern),
      };
    }
    case "grep": {
      const pattern = pickString(input, ["pattern"]) ?? "";
      const dir = pickString(input, ["dirPath"]);
      return {
        action: "search",
        verb: "搜索内容",
        runningVerb: running("搜索"),
        summary: dir ? truncateSummary(`${pattern} @ ${dir}`) : truncateSummary(pattern),
      };
    }
    case "bash":
      return {
        action: "run",
        verb: "运行",
        runningVerb: running("运行"),
        // 命令可能很长，只取首行再截断
        summary: truncateSummary(firstLine(pickString(input, ["command"]) ?? "")),
      };
    case "webSearch":
      return {
        action: "search",
        verb: "搜索网页",
        runningVerb: running("搜索"),
        summary: summaryOf(input),
      };
    case "wikiSearch":
      return {
        action: "search",
        verb: "搜索知识库",
        runningVerb: running("搜索"),
        summary: summaryOf(input),
      };
    case "wikiRead":
      return {
        action: "read",
        verb: "读取知识库",
        runningVerb: running("读取"),
        summary: summaryOf(input),
      };
    case "webFetch": {
      const url = pickString(input, ["url"]) ?? "";
      return {
        action: "browse",
        verb: "读取网页",
        runningVerb: running("读取网页"),
        // 网址展示时去掉协议前缀，给摘要腾出空间
        summary: truncateSummary(url.replace(/^https?:\/\//, "")),
      };
    }
    case "announce":
      return { action: "use", verb: "播报", runningVerb: running("播报"), summary: summaryOf(input) };
    case "askUser": {
      const questions = input?.questions;
      const first =
        Array.isArray(questions) && questions[0] && typeof questions[0] === "object"
          ? pickString(questions[0] as ToolInput, ["question"])
          : undefined;
      return {
        action: "use",
        verb: "征询用户",
        runningVerb: running("等待用户选择"),
        summary: truncateSummary(first ?? ""),
      };
    }
    case "Delegate": {
      const agent = pickString(input, ["agent"]) ?? "";
      const task = firstLine(pickString(input, ["task"]) ?? "");
      return {
        action: "delegate",
        verb: `委派 ${agent}`,
        runningVerb: `正在委派 ${agent}`,
        summary: truncateSummary(task),
      };
    }
    case "DelegateWait": {
      const ids = input?.delegationIds;
      const label =
        Array.isArray(ids) && ids.length > 0
          ? `${ids.length} 个委派`
          : "全部运行中的委派";
      return {
        action: "delegate",
        verb: "等待委派",
        runningVerb: "正在等待子智能体",
        summary: label,
      };
    }
    case "gitCommit":
      return {
        action: "git",
        verb: GIT_VERBS[name],
        runningVerb: running("提交"),
        summary: truncateSummary(pickString(input, ["message"]) ?? ""),
      };
    case "CronCreate":
    case "CronUpdate": {
      const cronName = pickString(input, ["name"]);
      const cron = pickString(input, ["cron"]);
      return {
        action: "cron",
        verb: name === "CronCreate" ? "创建定时任务" : "更新定时任务",
        runningVerb: name === "CronCreate" ? "正在创建定时任务" : "正在更新定时任务",
        // 任务名 + 表达式最能说明这次改动
        summary: truncateSummary([cronName, cron].filter(Boolean).join(" · ")),
      };
    }
    default:
      break;
  }

  if (name in GIT_VERBS) {
    return {
      action: "git",
      verb: GIT_VERBS[name],
      runningVerb: running(GIT_VERBS[name]),
      summary: summaryOf(input),
    };
  }
  if (name in TASK_VERBS) {
    return {
      action: "task",
      verb: TASK_VERBS[name],
      runningVerb: running(TASK_VERBS[name]),
      summary: summaryOf(input),
    };
  }
  if (name in CRON_VERBS) {
    return {
      action: "cron",
      verb: CRON_VERBS[name],
      runningVerb: running(CRON_VERBS[name]),
      summary: summaryOf(input),
    };
  }
  if (name in DELEGATE_VERBS) {
    return {
      action: "delegate",
      verb: DELEGATE_VERBS[name],
      runningVerb: running(DELEGATE_VERBS[name]),
      summary: summaryOf(input),
    };
  }
  // MCP 工具：mcp__<服务器>__<工具> 拆开显示，比原始全名可读。
  if (name.startsWith("mcp__")) {
    const segments = name.split("__");
    const label = segments.length >= 3 ? `${segments[1]} · ${segments.slice(2).join("_")}` : name;
    return {
      action: "use",
      verb: label,
      runningVerb: `正在调用 ${label}`,
      summary: summaryOf(input),
    };
  }
  return fallbackDisplay(name, input);
}
