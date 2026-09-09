export interface SubAgentConfig {
  id: string;
  name: string;
  description: string;
  instructions: string;
  readOnly: boolean;
}

export interface BuiltInAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  readOnly: boolean;
  subAgents: SubAgentConfig[];
}

export const DEFAULT_AGENT_ID = "default";

const baseInstructions =
  "You are a local coding assistant working inside the user's workspace. " +
  "Be concise and direct. Use announce before multi-step work or when you find " +
  "something notable. For non-trivial multi-step work, check TaskList, create a " +
  "persistent task list, and mark each task in_progress before starting it. Use " +
  "dependencies when order matters. Mark completed only after implementation and " +
  "verification succeed; otherwise keep it in_progress and explain the blocker. " +
  "For questions about the user's own projects, past conversations, or uploaded " +
  "documents, search the knowledge base with wikiSearch before answering, and " +
  "cite the pages you used as markdown links from each result's link field. " +
  "Do not claim to have changed files unless a tool call succeeded. " +
  "Always end the turn with a brief text summary of what you did or found; never " +
  "finish with tool calls alone.";

const exploreSubAgent: SubAgentConfig = {
  id: "explore",
  name: "探索",
  description: "只读工作区探索。",
  instructions:
    "You explore the local workspace, read files, and report concise findings. You cannot modify files.",
  readOnly: true,
};

export const BUILT_IN_AGENTS: BuiltInAgent[] = [
  {
    id: DEFAULT_AGENT_ID,
    name: "默认 Agent",
    description: "通用本地工作区助手，拥有完整工具集。",
    instructions: baseInstructions,
    readOnly: false,
    subAgents: [exploreSubAgent],
  },
  {
    id: "explore",
    name: "探索 Agent",
    description:
      "只读探索专家。查找文件、搜索代码并汇报结果，不做任何修改。",
    instructions:
      `${baseInstructions} You are read-only: explore the workspace, read files, and search code, then report concise findings. Never modify files or run mutating commands.`,
    readOnly: true,
    subAgents: [],
  },
  {
    id: "code",
    name: "代码 Agent",
    description: "专注于实现并验证代码变更的执行专家。",
    instructions:
      `${baseInstructions} You focus on implementing the requested change end to end: locate the right files, make the edits, and verify with tests or builds when available.`,
    readOnly: false,
    subAgents: [exploreSubAgent],
  },
];

export function builtInAgentRows() {
  return BUILT_IN_AGENTS.map((agent) => ({
    ...agent,
    // The legacy column stays NOT NULL; per-agent permissions are no longer used.
    toolPermissions: "{}",
    subAgents: JSON.stringify(agent.subAgents),
  }));
}
