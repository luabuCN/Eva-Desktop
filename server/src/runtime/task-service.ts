import { prisma } from "../db.js";

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

type AgentTaskRecord = Awaited<ReturnType<typeof prisma.agentTask.findFirstOrThrow>>;
type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface CreateTaskInput {
  conversationId: string;
  runId?: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlockedBy?: string[];
  addBlocks?: string[];
}

export interface AgentTaskInfo {
  id: string;
  conversationId: string;
  runId?: string | null;
  taskId: string;
  subject: string;
  description?: string | null;
  status: TaskStatus;
  activeForm?: string | null;
  owner?: string | null;
  metadata: Record<string, unknown>;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
  updatedAt: string;
}

export class TaskServiceError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "TaskServiceError";
  }
}

function parseTaskId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new TaskServiceError("Task ID must be a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TaskServiceError("Task ID must be a positive integer.");
  }
  return parsed;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function mergeMetadata(current: string | null, patch: Record<string, unknown> | undefined): string | undefined {
  if (!patch) return current ?? undefined;
  const next = { ...parseMetadata(current) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return JSON.stringify(next);
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function serializeTask(task: AgentTaskRecord): AgentTaskInfo {
  return {
    id: task.id,
    conversationId: task.conversationId,
    runId: task.runId,
    taskId: String(task.taskId),
    subject: task.subject,
    description: task.description,
    status: TASK_STATUSES.includes(task.status as TaskStatus)
      ? task.status as TaskStatus
      : "pending",
    activeForm: task.activeForm,
    owner: task.owner,
    metadata: parseMetadata(task.metadata),
    blockedBy: parseStringArray(task.blockedBy),
    blocks: parseStringArray(task.blocks),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function assertTransition(current: string, next: TaskStatus) {
  if (current === next) return;
  const allowed: Record<string, TaskStatus[]> = {
    pending: ["in_progress", "completed"],
    in_progress: ["completed"],
    completed: [],
  };
  if (!allowed[current]?.includes(next)) {
    throw new TaskServiceError(`Cannot change task status from ${current} to ${next}.`);
  }
}

function assertAcyclicGraph(graph: Map<string, Set<string>>) {
  const state = new Map<string, 1 | 2>();

  const visit = (node: string, path: Set<string>): boolean => {
    const marker = state.get(node);
    if (marker === 2) return false;
    if (marker === 1 || path.has(node)) return true;
    state.set(node, 1);
    path.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (visit(dependency, path)) return true;
    }
    path.delete(node);
    state.set(node, 2);
    return false;
  };

  for (const node of graph.keys()) {
    if (visit(node, new Set())) {
      throw new TaskServiceError("Task dependencies would create a cycle.");
    }
  }
}

function assertDependenciesValid(input: {
  records: AgentTaskRecord[];
  currentTaskId: string;
  addBlockedBy: string[];
  addBlocks: string[];
}) {
  const knownIds = new Set(input.records.map((task) => String(task.taskId)));
  for (const id of [...input.addBlockedBy, ...input.addBlocks]) {
    if (id === input.currentTaskId) {
      throw new TaskServiceError("A task cannot depend on itself.");
    }
    if (!knownIds.has(id)) throw new TaskServiceError(`Task #${id} does not exist.`, 404);
  }

  const graph = new Map<string, Set<string>>();
  for (const task of input.records) {
    graph.set(String(task.taskId), new Set(parseStringArray(task.blockedBy)));
  }
  for (const dependency of input.addBlockedBy) {
    graph.get(input.currentTaskId)?.add(dependency);
  }
  for (const dependent of input.addBlocks) {
    graph.get(dependent)?.add(input.currentTaskId);
  }
  assertAcyclicGraph(graph);
}

class AgentTaskService {
  async create(input: CreateTaskInput): Promise<AgentTaskInfo> {
    return prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: input.conversationId },
        select: { id: true },
      });
      if (!conversation) throw new TaskServiceError("Conversation not found.", 404);

      if (input.runId) {
        const run = await tx.threadRun.findFirst({
          where: { id: input.runId, conversationId: input.conversationId },
          select: { id: true },
        });
        if (!run) throw new TaskServiceError("Run does not belong to this conversation.", 404);
      }

      const aggregate = await tx.agentTask.aggregate({
        where: { conversationId: input.conversationId },
        _max: { taskId: true },
      });
      const task = await tx.agentTask.create({
        data: {
          conversationId: input.conversationId,
          runId: input.runId,
          taskId: (aggregate._max.taskId ?? 0) + 1,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          owner: input.owner,
          metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
        },
      });
      return serializeTask(task);
    });
  }

  async list(conversationId: string): Promise<AgentTaskInfo[]> {
    const tasks = await prisma.agentTask.findMany({
      where: { conversationId },
      orderBy: { taskId: "asc" },
    });
    return tasks.map(serializeTask);
  }

  async get(conversationId: string, taskId: string): Promise<AgentTaskInfo> {
    const task = await this.findTask(prisma, conversationId, taskId);
    if (!task) throw new TaskServiceError(`Task #${taskId} does not exist.`, 404);
    return serializeTask(task);
  }

  async update(conversationId: string, taskId: string, input: UpdateTaskInput): Promise<AgentTaskInfo> {
    const normalizedBlockedBy = uniqueIds(input.addBlockedBy ?? []);
    const normalizedBlocks = uniqueIds(input.addBlocks ?? []);

    return prisma.$transaction(async (tx) => {
      const current = await this.findTask(tx, conversationId, taskId);
      if (!current) throw new TaskServiceError(`Task #${taskId} does not exist.`, 404);

      const records = await tx.agentTask.findMany({ where: { conversationId } });
      const currentTaskId = String(current.taskId);
      assertDependenciesValid({
        records,
        currentTaskId,
        addBlockedBy: normalizedBlockedBy,
        addBlocks: normalizedBlocks,
      });

      const statusById = new Map(records.map((task) => [String(task.taskId), task.status]));
      const nextBlockedBy = uniqueIds([
        ...parseStringArray(current.blockedBy),
        ...normalizedBlockedBy,
      ]);
      const nextBlocks = uniqueIds([
        ...parseStringArray(current.blocks),
        ...normalizedBlocks,
      ]);

      if (input.status) assertTransition(current.status, input.status);
      const nextStatus = input.status ?? current.status;
      if (nextStatus !== "pending") {
        const unfinished = nextBlockedBy.filter((id) => statusById.get(id) !== "completed");
        if (unfinished.length > 0) {
          throw new TaskServiceError(
            `Task #${currentTaskId} is blocked by: ${unfinished.map((id) => `#${id}`).join(", ")}.`,
          );
        }
      }

      await tx.agentTask.update({
        where: { id: current.id },
        data: {
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.metadata !== undefined
            ? { metadata: mergeMetadata(current.metadata, input.metadata) }
            : {}),
          ...(normalizedBlockedBy.length > 0 ? { blockedBy: JSON.stringify(nextBlockedBy) } : {}),
          ...(normalizedBlocks.length > 0 ? { blocks: JSON.stringify(nextBlocks) } : {}),
        },
      });

      for (const dependencyId of normalizedBlockedBy) {
        if (parseStringArray(current.blockedBy).includes(dependencyId)) continue;
        const dependency = records.find((task) => String(task.taskId) === dependencyId);
        if (!dependency) continue;
        await tx.agentTask.update({
          where: { id: dependency.id },
          data: {
            blocks: JSON.stringify(uniqueIds([
              ...parseStringArray(dependency.blocks),
              currentTaskId,
            ])),
          },
        });
      }

      for (const dependentId of normalizedBlocks) {
        if (parseStringArray(current.blocks).includes(dependentId)) continue;
        const dependent = records.find((task) => String(task.taskId) === dependentId);
        if (!dependent) continue;
        await tx.agentTask.update({
          where: { id: dependent.id },
          data: {
            blockedBy: JSON.stringify(uniqueIds([
              ...parseStringArray(dependent.blockedBy),
              currentTaskId,
            ])),
          },
        });
      }

      const updated = await tx.agentTask.findUnique({ where: { id: current.id } });
      if (!updated) throw new TaskServiceError("Task disappeared during update.");
      return serializeTask(updated);
    });
  }

  /**
   * 运行落幕后的系统级收尾：会话同一时刻只允许一个活跃运行，运行结束
   * （完成/失败/中止）后仍处于 in_progress 的任务不可能再有人推进，统一
   * 退回 pending，避免任务面板永远挂着「进行中」。模型下一回合可按状态机
   * 重新标记。这不是模型发起的流转，不走 assertTransition。
   */
  async resetStaleTasks(conversationId?: string): Promise<number> {
    const result = await prisma.agentTask.updateMany({
      where: {
        status: "in_progress",
        ...(conversationId ? { conversationId } : {}),
      },
      data: { status: "pending", updatedAt: new Date() },
    });
    return result.count;
  }

  private findTask(
    db: PrismaTransaction | typeof prisma,
    conversationId: string,
    taskId: string,
  ) {
    return db.agentTask.findFirst({
      where: { conversationId, taskId: parseTaskId(taskId) },
    });
  }
}

export const taskService = new AgentTaskService();
