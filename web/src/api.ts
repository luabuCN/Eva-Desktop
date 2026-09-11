export const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8878";

/** 会话当前进行中运行的状态；null 表示空闲（用于侧栏后台运行状态点）。 */
export type ActiveRunStatus = "queued" | "running" | "waiting_approval";

export interface SessionSummary {
  id: string;
  title: string;
  projectId?: string | null;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  activeRunStatus?: ActiveRunStatus | null;
}

/** 设置页归档分区里的会话行，比侧栏摘要多一个归档时间。 */
export interface ArchivedSessionSummary extends SessionSummary {
  archivedAt: string;
}

export interface SessionUpdateInput {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

/** 更新会话元数据：重命名 / 置顶 / 归档（archived: false 为恢复）。 */
export function updateSession(id: string, input: SessionUpdateInput): Promise<SessionSummary> {
  return apiFetch<{ session: SessionSummary }>(`/api/sessions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((data) => data.session);
}

export function listArchivedSessions(): Promise<ArchivedSessionSummary[]> {
  return apiFetch<{ sessions: ArchivedSessionSummary[] }>("/api/sessions/archived")
    .then((data) => data.sessions);
}

export function deleteSession(id: string): Promise<void> {
  return apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).then(() => undefined);
}

export interface HealthInfo {
  status: string;
  model?: string;
  modelSource?: string;
  workspace: boolean;
  bash: boolean;
}

export type ThinkingMode = "fast" | "deep";

/** 推理等级：off 关闭，low/medium/high 映射到服务端的 reasoning_effort。 */
export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    REASONING_EFFORTS.includes(value as ReasoningEffort)
  );
}

export const PERMISSION_MODES = ["plan", "confirm", "auto_edit", "full"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode);
}

export interface FileEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export function fetchHealth(): Promise<HealthInfo> {
  return apiFetch<HealthInfo>("/health");
}

export async function listFiles(path: string): Promise<FileEntry[]> {
  const data = await apiFetch<{ path: string; entries: FileEntry[] }>(
    `/api/files?path=${encodeURIComponent(path)}`,
  );
  return data.entries;
}

export interface FileContent {
  path: string;
  size: number;
  content: string;
}

export async function readFileContent(path: string): Promise<FileContent> {
  return apiFetch<FileContent>(`/api/files/content?path=${encodeURIComponent(path)}`);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `请求失败：${response.status}`);
  }

  return response.json() as Promise<T>;
}

export interface ProviderModel {
  id: string;
  name: string;
  enabled: boolean;
  isCustom?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
}

export interface ProviderInfo {
  id: string;
  name: string;
  type: string;
  apiBase: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  isActive: boolean;
  models: ProviderModel[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  description?: string | null;
  defaultAgentId?: string | null;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  isActive: boolean;
  pinned?: boolean;
  archivedAt?: string | null;
  /** 项目级对话自动总结开关：null = 跟随全局设置。 */
  wikiAutoIngest?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalInfo {
  id: string;
  runId: string;
  toolName: string;
  input: string;
  reason?: string | null;
  status: "pending" | "approved" | "rejected" | "timeout" | "cancelled";
  createdAt: string;
}

export interface AskUserQuestionInfo {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

export interface AskUserInfo {
  id: string;
  runId: string;
  questions: AskUserQuestionInfo[];
  answers?: string | null;
  status: "pending" | "answered" | "cancelled";
  createdAt: string;
}

export interface PlanApprovalInfo {
  id: string;
  runId: string;
  plan: string;
  feedback?: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  /** approve → auto_edit；approve_full → full；reject 时为空。 */
  action?: "approve" | "approve_full" | "reject" | null;
  createdAt: string;
}

export interface RunInfo {
  id: string;
  conversationId: string;
  projectId?: string | null;
  agentId?: string | null;
  thinkingMode: string;
  providerId?: string | null;
  modelId?: string | null;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "aborted";
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  approvals: ApprovalInfo[];
  asks?: AskUserInfo[];
  plans?: PlanApprovalInfo[];
}

export interface AgentTaskInfo {
  id: string;
  conversationId: string;
  runId?: string | null;
  taskId: string;
  subject: string;
  description?: string | null;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string | null;
  owner?: string | null;
  metadata: Record<string, unknown>;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderTypeInfo {
  id: string;
  name: string;
  api?: string;
}

export interface ProviderInput {
  name: string;
  type: string;
  apiBase: string;
  apiKey?: string | null;
  isActive?: boolean;
  models?: ProviderModel[];
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export type ToolPolicy = {
  enabled: boolean;
  requireApproval: boolean;
};

export interface ToolCatalogInfo {
  name: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
  mutating: boolean;
  defaultPolicy: ToolPolicy;
}

export interface SubAgentInfo {
  id: string;
  name: string;
  description: string;
  instructions: string;
  readOnly: boolean;
}

/** 委派式子智能体定义（Delegate 工具目录，区别于上面的 legacy SubAgentInfo）。 */
export interface SubAgentDefinitionInfo {
  id: string;
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  providerId?: string | null;
  modelId?: string | null;
  maxTurns?: number | null;
  isActive: boolean;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubAgentDefinitionInput {
  name?: string;
  description?: string;
  tools?: string[];
  prompt?: string;
  providerId?: string | null;
  modelId?: string | null;
  maxTurns?: number | null;
  isActive?: boolean;
}

export function listSubAgents(): Promise<SubAgentDefinitionInfo[]> {
  return apiFetch<{ subagents: SubAgentDefinitionInfo[] }>("/api/subagents")
    .then((data) => data.subagents);
}

export function createSubAgent(input: SubAgentDefinitionInput): Promise<SubAgentDefinitionInfo> {
  return apiFetch<{ subagent: SubAgentDefinitionInfo }>("/api/subagents", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.subagent);
}

export function updateSubAgent(
  id: string,
  input: SubAgentDefinitionInput,
): Promise<SubAgentDefinitionInfo> {
  return apiFetch<{ subagent: SubAgentDefinitionInfo }>(`/api/subagents/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.subagent);
}

export function deleteSubAgent(id: string): Promise<void> {
  return apiFetch(`/api/subagents/${id}`, { method: "DELETE" }).then(() => undefined);
}

export type SkillSource = "custom" | "claude" | "codex" | "ccswitch";

export interface SkillInfo {
  key: string;
  source: SkillSource;
  id: string;
  name: string;
  description?: string;
  dir: string;
  path: string;
  enabled: boolean;
  isCustom: boolean;
}

export interface SkillSourceInfo {
  source: SkillSource;
  label: string;
  dir: string;
  exists: boolean;
}

export interface SkillInput {
  name?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
}

export function listSkills(): Promise<{ skills: SkillInfo[]; sources: SkillSourceInfo[] }> {
  return apiFetch<{ skills: SkillInfo[]; sources: SkillSourceInfo[] }>("/api/skills");
}

export function createSkill(input: { name: string; description?: string; body: string }): Promise<SkillInfo> {
  return apiFetch<{ skill: SkillInfo }>("/api/skills", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.skill);
}

export function readSkillBody(key: string): Promise<{ name: string; description?: string; body: string }> {
  return apiFetch(`/api/skills/${encodeURIComponent(key)}/body`);
}

export function updateSkill(key: string, input: SkillInput): Promise<SkillInfo> {
  return apiFetch<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.skill);
}

export function deleteSkill(key: string): Promise<void> {
  return apiFetch(`/api/skills/${encodeURIComponent(key)}`, { method: "DELETE" }).then(() => undefined);
}

// ---------------------------------------------------------------------------
// MCP 服务器配置
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "http";

export type McpServerState = "idle" | "connecting" | "ready" | "failed";

export interface McpServerStatus {
  serverId: string;
  state: McpServerState;
  toolCount: number;
  message?: string;
  toolNames?: string[];
  updatedAt: number;
}

/** 一条 MCP 服务器配置；projectId 为空表示全局级，否则为项目级。 */
export interface McpServerInfo {
  id: string;
  label: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  status?: McpServerStatus;
}

export interface McpServerInput {
  label: string;
  description?: string | null;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  enabled?: boolean;
  projectId?: string | null;
}

export function listMcpServers(): Promise<McpServerInfo[]> {
  return apiFetch<{ servers: McpServerInfo[] }>("/api/mcp").then((data) => data.servers);
}

export function createMcpServer(input: McpServerInput & { id: string }): Promise<McpServerInfo> {
  return apiFetch<{ server: McpServerInfo }>("/api/mcp", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.server);
}

export function updateMcpServer(id: string, input: McpServerInput): Promise<McpServerInfo> {
  return apiFetch<{ server: McpServerInfo }>(`/api/mcp/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.server);
}

export function setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerInfo> {
  return apiFetch<{ server: McpServerInfo }>(`/api/mcp/${encodeURIComponent(id)}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }).then((data) => data.server);
}

export function deleteMcpServer(id: string): Promise<void> {
  return apiFetch(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
}

export function testMcpServer(id: string): Promise<McpServerStatus> {
  return apiFetch<{ status: McpServerStatus }>(`/api/mcp/${encodeURIComponent(id)}/test`, {
    method: "POST",
  }).then((data) => data.status);
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  instructions: string;
  readOnly: boolean;
  subAgents: SubAgentInfo[];
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInput {
  name?: string;
  description?: string;
  instructions?: string;
  subAgents?: SubAgentInfo[];
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  isActive?: boolean;
}

export function listAgents(): Promise<AgentInfo[]> {
  return apiFetch<{ agents: AgentInfo[] }>("/api/agents").then((data) => data.agents);
}

export function listTools(): Promise<ToolCatalogInfo[]> {
  return apiFetch<{ tools: ToolCatalogInfo[] }>("/api/agents/tools").then((data) => data.tools);
}

export function createAgent(input: AgentInput): Promise<AgentInfo> {
  return apiFetch<{ agent: AgentInfo }>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.agent);
}

export function updateAgent(id: string, input: AgentInput): Promise<AgentInfo> {
  return apiFetch<{ agent: AgentInfo }>(`/api/agents/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.agent);
}

export function deleteAgent(id: string): Promise<void> {
  return apiFetch(`/api/agents/${id}`, { method: "DELETE" }).then(() => undefined);
}

export function listProviders(): Promise<ProviderInfo[]> {
  return apiFetch<{ providers: ProviderInfo[] }>("/api/providers").then((data) => data.providers);
}

export function listProviderTypes(): Promise<ProviderTypeInfo[]> {
  return apiFetch<{ types: ProviderTypeInfo[] }>("/api/providers/types").then((data) => data.types);
}

export function fetchRemoteModels(apiBase: string, apiKey?: string | null): Promise<ProviderModel[]> {
  return apiFetch<{ models: ProviderModel[] }>("/api/providers/fetch-models", {
    method: "POST",
    body: JSON.stringify({ apiBase, apiKey }),
  }).then((data) => data.models);
}

export function fetchSavedProviderModels(providerId: string): Promise<ProviderModel[]> {
  return apiFetch<{ models: ProviderModel[] }>(`/api/providers/${providerId}/fetch-models`, {
    method: "POST",
  }).then((data) => data.models);
}

export function listProjects(): Promise<ProjectInfo[]> {
  return apiFetch<{ projects: ProjectInfo[] }>("/api/projects").then((data) => data.projects);
}

export function createProject(input: Pick<ProjectInfo, "name" | "rootPath"> & Partial<ProjectInfo>): Promise<ProjectInfo> {
  return apiFetch<{ project: ProjectInfo }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.project);
}

export interface ProjectUpdateInput extends Partial<Pick<ProjectInfo, "name" | "rootPath"> & ProjectInfo> {
  /** true = 归档项目，false = 恢复（服务端写入/清空 archivedAt）。 */
  archived?: boolean;
}

export function updateProject(
  id: string,
  input: ProjectUpdateInput,
): Promise<ProjectInfo> {
  return apiFetch<{ project: ProjectInfo }>(`/api/projects/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.project);
}

export function deleteProject(id: string): Promise<void> {
  return apiFetch(`/api/projects/${id}`, { method: "DELETE" }).then(() => undefined);
}

export function listConversationRuns(conversationId: string): Promise<RunInfo[]> {
  return apiFetch<{ runs: RunInfo[] }>(`/api/runs/conversations/${conversationId}`)
    .then((data) => data.runs);
}

/** 停止会话当前进行中的后台运行（服务端中止 agent 循环）。 */
export function abortConversation(conversationId: string): Promise<void> {
  return apiFetch(`/api/runs/conversations/${conversationId}/abort`, {
    method: "POST",
  }).then(() => undefined);
}

export function listConversationTasks(conversationId: string): Promise<AgentTaskInfo[]> {
  return apiFetch<{ tasks: AgentTaskInfo[] }>(`/api/conversations/${conversationId}/tasks`)
    .then((data) => data.tasks);
}

export type ApprovalAction =
  | "approve"
  | "approve_always"
  | "reject"
  /** bash 专用：从当前命令推导保守前缀规则并放行（仅本次批准不放开整个工具）。 */
  | "approve_command_always";

export function decideApproval(
  runId: string,
  approvalId: string,
  action: ApprovalAction,
): Promise<void> {
  return apiFetch(`/api/runs/${runId}/approvals/${approvalId}`, {
    method: "POST",
    body: JSON.stringify({ action }),
  }).then(() => undefined);
}

export interface WorkspaceSettingInfo {
  path: string;
  /** 用户是否显式配置过；false = 还在用默认位置（首启引导据此触发）。 */
  configured: boolean;
  defaultPath: string;
}

export function getWorkspaceSetting(): Promise<WorkspaceSettingInfo> {
  return apiFetch<WorkspaceSettingInfo>("/api/settings/workspace");
}

export function setWorkspaceSetting(path: string): Promise<WorkspaceSettingInfo> {
  return apiFetch<WorkspaceSettingInfo>("/api/settings/workspace", {
    method: "PUT",
    body: JSON.stringify({ path }),
  });
}

export interface TerminalInfo {
  id: string;
  pid: number;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

export function listTerminals(): Promise<TerminalInfo[]> {
  return apiFetch<{ terminals: TerminalInfo[] }>("/api/terminal")
    .then((data) => data.terminals);
}

export function createTerminal(input: {
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
}): Promise<TerminalInfo> {
  return apiFetch<{ terminal: TerminalInfo }>("/api/terminal", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.terminal);
}

export function sendTerminalInput(id: string, data: string): Promise<void> {
  return apiFetch(`/api/terminal/${id}/input`, {
    method: "POST",
    body: JSON.stringify({ data }),
  }).then(() => undefined);
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return apiFetch(`/api/terminal/${id}/resize`, {
    method: "POST",
    body: JSON.stringify({ cols, rows }),
  }).then(() => undefined);
}

export function killTerminal(id: string): Promise<void> {
  return apiFetch(`/api/terminal/${id}`, { method: "DELETE" }).then(() => undefined);
}

export interface CommandRuleInfo {
  id: string;
  pattern: string;
  matchType: "prefix" | "exact";
  projectId?: string | null;
  projectName?: string | null;
  createdAt: string;
}

export function listCommandRules(): Promise<CommandRuleInfo[]> {
  return apiFetch<{ rules: CommandRuleInfo[] }>("/api/command-rules")
    .then((data) => data.rules);
}

export function createCommandRule(input: {
  pattern: string;
  matchType: "prefix" | "exact";
  projectId?: string | null;
}): Promise<CommandRuleInfo> {
  return apiFetch<{ rule: CommandRuleInfo }>("/api/command-rules", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.rule);
}

export function deleteCommandRule(id: string): Promise<void> {
  return apiFetch(`/api/command-rules/${id}`, { method: "DELETE" }).then(() => undefined);
}

/** ExitPlanMode 计划卡裁决：approve → auto_edit，approve_full → full，reject 可附反馈。 */
export type PlanApprovalAction = "approve" | "approve_full" | "reject";

export function decidePlan(
  runId: string,
  planId: string,
  action: PlanApprovalAction,
  feedback?: string,
): Promise<void> {
  return apiFetch(`/api/runs/${runId}/plans/${planId}`, {
    method: "POST",
    body: JSON.stringify({ action, feedback }),
  }).then(() => undefined);
}

/** askUser 卡片提交：answers 与 questions 一一对应，null 表示该题跳过。 */
export function answerAsk(
  runId: string,
  askId: string,
  answers: Array<string[] | null>,
): Promise<void> {
  return apiFetch(`/api/runs/${runId}/asks/${askId}`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  }).then(() => undefined);
}

export function createProvider(input: ProviderInput): Promise<ProviderInfo> {
  return apiFetch<{ provider: ProviderInfo }>("/api/providers", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.provider);
}

export interface FileChangeInfo {
  id: string;
  conversationId: string;
  projectId?: string | null;
  path: string;
  changeKind: "create" | "edit" | "delete";
  unifiedDiff: string | null;
  additions: number;
  deletions: number;
  createdAt: string;
}

export interface ChangesSummary {
  changes: FileChangeInfo[];
  totals: { files: number; additions: number; deletions: number };
}

export function listChanges(params: { projectId?: string; conversationId?: string }): Promise<ChangesSummary> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.conversationId) query.set("conversationId", params.conversationId);
  return apiFetch<ChangesSummary>(`/api/changes?${query.toString()}`);
}

export interface RevertResult {
  results: Array<{ path: string; action: string }>;
  failures: Array<{ path: string; error: string }>;
}

export function revertChanges(ids: string[]): Promise<RevertResult> {
  return apiFetch<RevertResult>("/api/changes/revert", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function revertConversationChanges(conversationId: string): Promise<RevertResult> {
  return apiFetch<RevertResult>("/api/changes/revert-conversation", {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });
}

export interface GitStatusInfo {
  available: boolean;
  isRepo?: boolean;
  reason?: string;
  root?: string;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  staged?: string[];
  changed?: string[];
  untracked?: string[];
  conflicted?: string[];
}

export function gitStatus(projectId: string): Promise<GitStatusInfo> {
  return apiFetch<GitStatusInfo>(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
}

export function gitDiffFile(projectId: string, path: string): Promise<{ path: string | null; diff: string; truncated: boolean }> {
  return apiFetch(
    `/api/git/diff?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
  );
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  message: string;
}

export function gitLog(projectId: string, limit = 10): Promise<{ commits: GitCommitInfo[] }> {
  return apiFetch(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}`);
}

export function gitCommit(projectId: string, files: string[], message: string): Promise<{ commit: string }> {
  return apiFetch("/api/git/commit", {
    method: "POST",
    body: JSON.stringify({ projectId, files, message }),
  });
}

export function gitPull(projectId: string): Promise<{ files: string[]; insertions: number; deletions: number }> {
  return apiFetch("/api/git/pull", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export function gitPush(projectId: string): Promise<{ pushed: boolean; branch: string }> {
  return apiFetch("/api/git/push", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export function updateProvider(id: string, input: Partial<ProviderInput>): Promise<ProviderInfo> {
  return apiFetch<{ provider: ProviderInfo }>(`/api/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.provider);
}

export function deleteProvider(id: string): Promise<void> {
  return apiFetch(`/api/providers/${id}`, { method: "DELETE" }).then(() => undefined);
}

// ---------------------------------------------------------------------------
// 自动化（定时任务）
// ---------------------------------------------------------------------------

/** 单次执行的历史记录（内嵌在任务行里，最多保留 50 条）。 */
export interface CronRunRecordInfo {
  startedAt: string;
  endedAt?: string;
  conversationId?: string;
  runId?: string;
  status: "running" | "success" | "failed";
  error?: string;
  trigger?: "schedule" | "manual";
}

export type CronPermissionMode = PermissionMode;

export interface CronJobInfo {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  description?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  permissionMode: CronPermissionMode;
  isActive: boolean;
  reuseThread: boolean;
  lastRunAt?: string | null;
  lastRunEndAt?: string | null;
  lastRunStatus?: string | null;
  lastRunError?: string | null;
  lastRunConversationId?: string | null;
  runHistory: CronRunRecordInfo[];
  /** 服务端当前是否正在执行（内存态，随列表返回）。 */
  isRunning: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobInput {
  name: string;
  prompt: string;
  cron: string;
  description?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  permissionMode: CronPermissionMode;
  isActive: boolean;
  reuseThread: boolean;
}

export function listCronJobs(): Promise<CronJobInfo[]> {
  return apiFetch<{ crons: CronJobInfo[] }>("/api/crons").then((data) => data.crons);
}

export function createCronJob(input: CronJobInput): Promise<CronJobInfo> {
  return apiFetch<{ cron: CronJobInfo }>("/api/crons", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.cron);
}

export function updateCronJob(id: string, input: Partial<CronJobInput>): Promise<CronJobInfo> {
  return apiFetch<{ cron: CronJobInfo }>(`/api/crons/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((data) => data.cron);
}

export function deleteCronJob(id: string): Promise<void> {
  return apiFetch(`/api/crons/${id}`, { method: "DELETE" }).then(() => undefined);
}

/** 立即触发一次执行（服务端 fire-and-forget，不等待完成）。 */
export function runCronJobNow(
  id: string,
): Promise<{ started: boolean; alreadyRunning: boolean }> {
  return apiFetch(`/api/crons/${id}/run`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// 知识库（llm-wiki：对话自动沉淀为持久 wiki）
// ---------------------------------------------------------------------------

export type WikiPageType =
  | "overview"
  | "index"
  | "log"
  | "entity"
  | "concept"
  | "source"
  | "query";

export interface WikiScopeInfo {
  id: string;
  label: string;
  kind: "default" | "project";
  projectId?: string | null;
  pageCount: number;
  lastUpdatedAt?: string | null;
}

export interface WikiPageSummary {
  path: string;
  title: string;
  type: WikiPageType;
  updatedAt: string;
  summary?: string;
  tags: string[];
}

export interface WikiPageMeta {
  tags?: string[];
  sources?: string[];
  related?: string[];
  summary?: string;
  documentId?: string;
  filename?: string;
  [key: string]: unknown;
}

/** 知识库原文档（raw 层）：来源页正文展示的原始全文。 */
export interface WikiDocumentInfo {
  id: string;
  filename: string;
  title: string;
  text: string;
  chars: number;
  truncated: boolean;
  /** 原始二进制文件已落盘：可原样预览/下载（旧数据为 false 只能看提取文本）。 */
  hasFile: boolean;
  createdAt: string;
}

export interface WikiPageDetail extends WikiPageSummary {
  content: string;
  meta: WikiPageMeta;
  links: string[];
  /** 反向链接：正文 [[双链]] 指向本页的页面。 */
  backlinks: Array<{ path: string; title: string }>;
  document?: WikiDocumentInfo;
}

/** 版本历史条目：内容被覆盖/删除/恢复前的修订快照。 */
export interface WikiRevision {
  id: string;
  path: string;
  title: string;
  reason: "manual" | "ingest" | "delete" | "restore";
  chars: number;
  createdAt: string;
}

export interface WikiTreeGroup {
  type: WikiPageType;
  label: string;
  pages: WikiPageSummary[];
}

/** 目录树「原始资料」分组条目；path 指向对应 sources/ 来源页。 */
export interface WikiTreeDocument {
  id: string;
  filename: string;
  title: string;
  path: string;
  createdAt: string;
}

export interface WikiTree {
  scopeId: string;
  groups: WikiTreeGroup[];
  totals: { pages: number };
  documents: WikiTreeDocument[];
}

export interface WikiGraphData {
  nodes: Array<{
    id: string;
    title: string;
    type: WikiPageType;
    community: number;
    degree: number;
  }>;
  edges: Array<{ source: string; target: string; kind: "link" | "source" }>;
  communities: number;
  stats: { pages: number; links: number; isolated: number };
}

export interface WikiSearchHit {
  path: string;
  title: string;
  type: WikiPageType;
  snippet: string;
}

export interface WikiJobsInfo {
  stats: { queued: number; processing: number; failedRecent: number };
  jobs: Array<{
    id: string;
    scopeId: string;
    conversationId: string;
    sourceKind?: "conversation" | "document";
    filename?: string | null;
    status: "queued" | "processing" | "completed" | "failed";
    trigger: "auto" | "manual" | "rebuild" | "upload";
    error?: string | null;
    createdAt: string;
    completedAt?: string | null;
  }>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 上传文档解析入知识库（md/txt/html/pdf/docx/xlsx/pptx，≤20MB）。 */
export async function uploadWikiDocument(
  scopeId: string,
  file: File,
): Promise<{ chars: number; truncated: boolean }> {
  if (file.size > 20 * 1024 * 1024) throw new Error("文件超过 20MB 上限");
  const contentBase64 = await fileToBase64(file);
  return apiFetch<{ chars: number; truncated: boolean }>(
    wikiPath(scopeId, "/ingest/document"),
    {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentBase64 }),
    },
  );
}

function wikiPath(scopeId: string, suffix = ""): string {
  return `/api/wiki/${encodeURIComponent(scopeId)}${suffix}`;
}

/** 原始文件下载地址（?download=1 触发浏览器下载而非内联）。 */
export function wikiDocumentFileUrl(scopeId: string, documentId: string, download = false): string {
  return `${API_URL}${wikiPath(scopeId, `/documents/${encodeURIComponent(documentId)}/file`)}${download ? "?download=1" : ""}`;
}

/** 拉取原文档二进制并包装成 File（预览器按文件名扩展名选择渲染链路）。 */
export async function fetchWikiDocumentFile(scopeId: string, document: WikiDocumentInfo): Promise<File> {
  const response = await fetch(wikiDocumentFileUrl(scopeId, document.id));
  if (!response.ok) {
    throw new Error("原始文件加载失败（可重新上传该文档恢复原件）");
  }
  const bytes = await response.arrayBuffer();
  return new File([bytes], document.filename);
}

export function listWikiScopes(): Promise<WikiScopeInfo[]> {
  return apiFetch<{ scopes: WikiScopeInfo[] }>("/api/wiki/scopes").then((data) => data.scopes);
}

export interface WikiSettings {
  /** 对话回合完成后自动总结进知识库。 */
  autoIngest: boolean;
  /** 知识库页默认打开的空间（默认知识库或项目知识库）。 */
  defaultScope: string;
  /** 全部 wiki 文件的磁盘镜像根目录（每个知识库一个子文件夹）。 */
  storagePath: string;
  /** 语义检索 embedding 配置（null = 关闭，仅关键词检索）。 */
  embeddingProviderId: string | null;
  embeddingModelId: string | null;
}

export function fetchWikiSettings(): Promise<WikiSettings> {
  return apiFetch("/api/wiki/settings");
}

export function updateWikiSettings(
  input: Partial<Pick<WikiSettings, "autoIngest" | "defaultScope">> & {
    /** null = 恢复默认镜像目录 / 关闭语义检索。 */
    storagePath?: string | null;
    embeddingProviderId?: string | null;
    embeddingModelId?: string | null;
  },
): Promise<WikiSettings> {
  return apiFetch("/api/wiki/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function fetchWikiTree(scopeId: string): Promise<WikiTree> {
  return apiFetch(wikiPath(scopeId, "/tree"));
}

export function fetchWikiPage(scopeId: string, path: string): Promise<WikiPageDetail> {
  return apiFetch<{ page: WikiPageDetail }>(
    `${wikiPath(scopeId, "/page")}?path=${encodeURIComponent(path)}`,
  ).then((data) => data.page);
}

export function saveWikiPage(
  scopeId: string,
  input: { path: string; title: string; type?: WikiPageType; content: string },
): Promise<WikiPageDetail> {
  return apiFetch<{ page: WikiPageDetail }>(wikiPath(scopeId, "/page"), {
    method: "PUT",
    body: JSON.stringify(input),
  }).then((data) => data.page);
}

export function deleteWikiPage(scopeId: string, path: string): Promise<void> {
  return apiFetch(
    `${wikiPath(scopeId, "/page")}?path=${encodeURIComponent(path)}`,
    { method: "DELETE" },
  ).then(() => undefined);
}

export function fetchWikiGraph(scopeId: string): Promise<WikiGraphData> {
  return apiFetch(wikiPath(scopeId, "/graph"));
}

export function searchWiki(scopeId: string, query: string): Promise<WikiSearchHit[]> {
  return apiFetch<{ hits: WikiSearchHit[] }>(
    `${wikiPath(scopeId, "/search")}?q=${encodeURIComponent(query)}`,
  ).then((data) => data.hits);
}

/** 手动把整个会话存入知识库（对话里的「存入知识库」按钮）。 */
export function ingestConversationToWiki(
  scopeId: string,
  conversationId: string,
): Promise<void> {
  return apiFetch(
    wikiPath(scopeId, `/ingest/conversations/${encodeURIComponent(conversationId)}`),
    { method: "POST" },
  ).then(() => undefined);
}

/** 从历史会话批量构建知识库（项目 wiki 初次生成）。 */
export function rebuildWiki(scopeId: string): Promise<{ enqueued: number }> {
  return apiFetch(wikiPath(scopeId, "/rebuild"), { method: "POST" });
}

export function fetchWikiJobs(): Promise<WikiJobsInfo> {
  return apiFetch("/api/wiki/jobs");
}

/** 重试全部失败的总结任务，返回重新入队数。 */
export function retryFailedWikiJobs(): Promise<{ retried: number }> {
  return apiFetch("/api/wiki/jobs/retry-failed", { method: "POST" });
}

/** 版本历史：某页面最近的修订快照（新 → 旧）。 */
export function fetchWikiRevisions(scopeId: string, path: string): Promise<WikiRevision[]> {
  return apiFetch<{ revisions: WikiRevision[] }>(
    `${wikiPath(scopeId, "/revisions")}?path=${encodeURIComponent(path)}`,
  ).then((data) => data.revisions);
}

/** 恢复到某次修订（当前内容会先存一份快照，恢复可再撤销）。 */
export function restoreWikiRevision(
  scopeId: string,
  path: string,
  revisionId: string,
): Promise<WikiPageDetail> {
  return apiFetch<{ page: WikiPageDetail }>(wikiPath(scopeId, "/revisions/restore"), {
    method: "POST",
    body: JSON.stringify({ path, revisionId }),
  }).then((data) => data.page);
}

/** 手动重新同步磁盘镜像，返回同步的页面数。 */
export function resyncWikiStorage(): Promise<{ synced: number }> {
  return apiFetch("/api/wiki/storage/resync", { method: "POST" });
}

/** 导入 Obsidian vault（zip 内 .md 文件，frontmatter 解析为页面元信息）。 */
export async function importWikiVault(
  scopeId: string,
  file: File,
): Promise<{ imported: number; skipped: string[] }> {
  if (file.size > 50 * 1024 * 1024) throw new Error("zip 超过 50MB 上限");
  const contentBase64 = await fileToBase64(file);
  return apiFetch<{ imported: number; skipped: string[] }>(wikiPath(scopeId, "/import"), {
    method: "POST",
    body: JSON.stringify({ contentBase64 }),
  });
}

export function wikiExportUrl(scopeId: string): string {
  return `${API_URL}${wikiPath(scopeId, "/export")}`;
}
