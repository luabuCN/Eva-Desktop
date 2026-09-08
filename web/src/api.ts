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

export const PERMISSION_MODES = ["confirm", "auto_edit", "full"] as const;

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

export type ApprovalAction = "approve" | "approve_always" | "reject";

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
