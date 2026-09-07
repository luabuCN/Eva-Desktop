import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isValidCronPattern, nextRunFor } from "../cron-utils.js";
import type { PermissionMode } from "../types.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RunContext } from "./run-context.js";
import type { RuntimeTool } from "./types.js";

/**
 * 定时任务管理工具：让对话中的智能体直接创建/查询/修改/删除/试跑定时
 * 任务（"每天早上九点给我讲个笑话" → CronCreate 一次调用）。
 *
 * 写操作默认走审批：用户在聊天里看到 CronCreate 的参数卡片，批准才落库，
 * 天然就是"AI 提案 + 用户确认"的交互。cron-service 通过动态 import 引入，
 * 避免把 cron-service → agent-runtime 的边织进 registry 的模块加载环。
 */

const CRON_FIELD = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Five-field cron expression in local time: "minute hour day month weekday". ' +
      'Examples: "0 9 * * *" daily 09:00, "*/10 * * * *" every 10 minutes, ' +
      '"30 21 * * 1-5" weekdays 21:30. Translate the user\'s wording yourself.',
  );

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadCronService() {
  return import("../cron-service.js");
}

function createCronTools(run: RunContext): Record<string, RuntimeTool> {
  return {
    CronCreate: createTool({
      id: "CronCreate",
      description:
        "Create a scheduled task that runs a prompt automatically on a cron schedule " +
        "(recurring reports, reminders, periodic maintenance). Write the prompt as a " +
        "complete, self-contained instruction for the agent; it runs unattended later.",
      inputSchema: z
        .object({
          name: z.string().trim().min(1).max(120).describe("Unique task name in the user's language"),
          prompt: z.string().trim().min(1).describe("Instruction to execute on each scheduled run"),
          cron: CRON_FIELD,
          description: z.string().trim().max(500).optional().describe("Optional note about the task's purpose"),
          permissionMode: z
            .enum(["confirm", "auto_edit", "full"])
            .optional()
            .describe("Unattended permission posture; default auto_edit (file edits pass, shell still gated)"),
          isActive: z.boolean().optional().describe("Start scheduling immediately; default true"),
          reuseThread: z
            .boolean()
            .optional()
            .describe("Append every run to one conversation instead of a new one; default false"),
        })
        .strict(),
      execute: async (input) => {
        if (!isValidCronPattern(input.cron)) {
          return { error: `Invalid cron expression: "${input.cron}"` };
        }
        try {
          const { cronService } = await loadCronService();
          const job = await cronService.create({
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            description: input.description ?? null,
            // 从当前会话继承上下文：项目决定工作区，智能体决定执行配置。
            projectId: run.projectId ?? null,
            agentId: run.agentId ?? null,
            permissionMode: (input.permissionMode ?? "auto_edit") as PermissionMode,
            isActive: input.isActive ?? true,
            reuseThread: input.reuseThread ?? false,
          });
          return {
            job: { id: job.id, name: job.name, cron: job.cron, isActive: job.isActive },
            nextRunAt: job.isActive ? nextRunFor(job.cron) : null,
          };
        } catch (error) {
          return { error: errorMessage(error) };
        }
      },
    }),
    CronList: createTool({
      id: "CronList",
      description: "List all scheduled tasks with their schedules, active state, and last run outcome.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        try {
          const { cronService } = await loadCronService();
          const jobs = await cronService.list();
          return {
            count: jobs.length,
            jobs: jobs.map((job) => ({
              id: job.id,
              name: job.name,
              cron: job.cron,
              prompt: job.prompt,
              isActive: job.isActive,
              reuseThread: job.reuseThread,
              lastRunAt: job.lastRunAt,
              lastRunStatus: job.lastRunStatus,
              nextRunAt: job.nextRunAt,
            })),
          };
        } catch (error) {
          return { error: errorMessage(error) };
        }
      },
    }),
    CronUpdate: createTool({
      id: "CronUpdate",
      description: "Update an existing scheduled task (rename, rewrite the prompt or schedule, enable/disable).",
      inputSchema: z
        .object({
          id: z.string().min(1).describe("Task id from CronList/CronCreate"),
          name: z.string().trim().min(1).max(120).optional(),
          prompt: z.string().trim().min(1).optional(),
          cron: CRON_FIELD.optional(),
          description: z.string().trim().max(500).nullish(),
          permissionMode: z.enum(["confirm", "auto_edit", "full"]).optional(),
          isActive: z.boolean().optional().describe("Enable or disable scheduling"),
          reuseThread: z.boolean().optional(),
        })
        .strict(),
      execute: async ({ id, ...input }) => {
        if (input.cron !== undefined && !isValidCronPattern(input.cron)) {
          return { error: `Invalid cron expression: "${input.cron}"` };
        }
        try {
          const { cronService } = await loadCronService();
          const job = await cronService.update(id, input);
          return {
            job: { id: job.id, name: job.name, cron: job.cron, isActive: job.isActive },
            nextRunAt: job.isActive ? nextRunFor(job.cron) : null,
          };
        } catch (error) {
          return { error: errorMessage(error) };
        }
      },
    }),
    CronDelete: createTool({
      id: "CronDelete",
      description: "Delete a scheduled task. Previously generated conversations are kept.",
      inputSchema: z.object({ id: z.string().min(1).describe("Task id from CronList") }).strict(),
      execute: async ({ id }) => {
        try {
          const { cronService } = await loadCronService();
          await cronService.remove(id);
          return { deleted: true };
        } catch (error) {
          return { error: errorMessage(error) };
        }
      },
    }),
    CronRunNow: createTool({
      id: "CronRunNow",
      description: "Trigger one scheduled task immediately without waiting for its next slot.",
      inputSchema: z.object({ id: z.string().min(1).describe("Task id from CronList") }).strict(),
      execute: async ({ id }) => {
        try {
          const { cronService } = await loadCronService();
          const result = await cronService.runNow(id);
          return result;
        } catch (error) {
          return { error: errorMessage(error) };
        }
      },
    }),
  };
}

export class CronToolProvider implements ToolProvider {
  readonly id = "crons";
  readonly label = "定时任务工具";

  listTools(): ToolDescriptor[] {
    const mutating = {
      risk: "medium" as const,
      mutating: true,
      defaultPolicy: { enabled: true, requireApproval: true },
      providerId: this.id,
    };
    return [
      {
        name: "CronCreate",
        label: "Create cron task",
        description: "Create a scheduled task from the conversation.",
        ...mutating,
      },
      {
        name: "CronList",
        label: "List cron tasks",
        description: "List scheduled tasks.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
      { name: "CronUpdate", label: "Update cron task", description: "Update a scheduled task.", ...mutating },
      { name: "CronDelete", label: "Delete cron task", description: "Delete a scheduled task.", ...mutating },
      { name: "CronRunNow", label: "Run cron task now", description: "Trigger a scheduled task immediately.", ...mutating },
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    // 定时任务属于主智能体的能力；子智能体不允许擅自创建后台调度。
    if (run.subAgent) return {};
    return createCronTools(run);
  }
}
