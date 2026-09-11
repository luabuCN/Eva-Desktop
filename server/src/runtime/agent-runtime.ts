import { toAISdkStream } from "@mastra/ai-sdk";
import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor } from "@mastra/core/processors";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
} from "ai";
import { config } from "../env.js";
import { prisma } from "../db.js";
import {
  resolveConfiguredSelection,
  type ModelSelection,
} from "../providers/provider-service.js";
import type { ChatUIMessage } from "../chat-types.js";
import { agentConfigService } from "./agents.js";
import { materializeAttachments } from "./attachments.js";
import { DelegationHub, type DelegationNotice } from "./delegation-hub.js";
import { prepareCompactedMessages } from "./compaction.js";
import { getWorkspaceRoot } from "./workspace.js";
import { createModel } from "./model.js";
import { runService } from "./run-service.js";
import { runHub } from "./run-hub.js";
import { loadProjectDocs, projectDocsSection } from "./project-docs.js";
import { skillService } from "./skills.js";
import { subAgentService } from "./subagents.js";
import { isAutoIngestEnabledFor, wikiQueue } from "../wiki/wiki-queue.js";
import {
  parseToolPermissionMap,
  toolProviderRegistry,
  toolRecordService,
  type RunContext,
} from "./tools/index.js";
import {
  THINKING_MODES,
  type PermissionMode,
  type ReasoningEffort,
  type ThinkingMode,
} from "./types.js";

export interface ConversationRunContext {
  conversationId: string;
  projectId?: string;
}

type ChatModel = Awaited<ReturnType<typeof createModel>>;

function truncateError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** 最后一条助手消息是否带非空文本（无文字总结的回合不值得入知识库）。 */
function lastRunHasText(messages: ChatUIMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.parts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    );
  }
  return false;
}

async function projectDefaults(projectId?: string) {
  if (!projectId) return undefined;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      isActive: true,
      rootPath: true,
      defaultAgentId: true,
      defaultProviderId: true,
      defaultModelId: true,
      toolPermissions: true,
    },
  });
  if (!project?.isActive) throw new Error("项目不存在或已被停用");
  return project;
}

class AgentRuntimeService {
  async stream(
    mode: ThinkingMode,
    messages: ChatUIMessage[],
    context: ConversationRunContext,
    selection?: ModelSelection,
    requestedAgentId?: string,
    permissionMode: PermissionMode = "confirm",
    reasoningEffort?: ReasoningEffort,
  ) {
    const project = await projectDefaults(context.projectId);
    const definition = await agentConfigService.resolve(
      requestedAgentId ?? project?.defaultAgentId ?? undefined,
    );
    const rootPath = project?.rootPath;
    const workspacePath = rootPath ?? (await getWorkspaceRoot()).path;
    const effectiveSelection =
      selection ??
      await resolveConfiguredSelection(
        project
          ? {
              providerId: project.defaultProviderId,
              modelId: project.defaultModelId,
            }
          : undefined,
        {
          providerId: definition.defaultProviderId,
          modelId: definition.defaultModelId,
        },
      );
    const model = await createModel(mode, effectiveSelection, reasoningEffort);

    // 同一会话同一时刻只允许一个进行中的运行。数据库状态为进行中、但
    // 广播中心里已无对应条目的，说明是服务重启遗留的僵尸记录，就地收尾
    // 后放行新回合。
    const existingRun = await runService.activeRun(context.conversationId);
    if (existingRun) {
      if (runHub.has(existingRun.id)) {
        throw new Error("该对话已有正在进行的回合，请等待完成或先停止");
      }
      await runService.finish(existingRun.id, "failed", "服务重启导致运行中断");
    }

    const run = await runService.start({
      conversationId: context.conversationId,
      messages,
      projectId: context.projectId,
      thinkingMode: mode,
      permissionMode,
      selection: effectiveSelection,
      agentId: definition.id,
    });
    const activeRun = runService.registerAbortSource(run.id, context.projectId);

    try {
      // Global permission mode sets the baseline; read-only agents cannot mutate;
      // project grants from "always allow" win over both; the tools-page kill
      // switch wins over everything. Unknown tools (future MCP/skill entries)
      // default to enabled-but-approval-required.
      const projectOverrides = parseToolPermissionMap(project?.toolPermissions);
      const disabledTools = await toolRecordService.disabledToolNames();
      const runContext = toolProviderRegistry.createRunContext({
        conversationId: context.conversationId,
        runId: run.id,
        projectId: context.projectId,
        workspacePath,
        agentId: definition.id,
        mode: permissionMode,
        readOnly: definition.readOnly,
        overrides: projectOverrides,
        disabledTools,
        approvals: activeRun.approvals,
        askUser: activeRun.asks,
        planApprovals: activeRun.plans,
        // plan 模式门控：主智能体与所有委派共享同一对象；ExitPlanMode
        // 获批后置 approved，整个运行的变更类工具即刻放开。
        planGate: permissionMode === "plan" ? { approved: false } : undefined,
        signal: activeRun.signal,
      });
      // 计划获批后把整个运行的策略就地重解析为升级后的权限模式
      // （policyFor 闭包引用同一 map，就地合并即可生效）。委派在获批
      // 之后派生的会直接按新模式解析；之前派生的靠共享门控放开，其
      // 审批要求保持派生时的安全默认。
      if (permissionMode === "plan") {
        runContext.escalateFromPlan = (mode) => {
          Object.assign(
            runContext.toolPolicies,
            toolProviderRegistry.policiesFor({
              mode,
              readOnly: runContext.readOnly,
              overrides: runContext.permissionOverrides,
              disabledTools: runContext.disabledTools,
            }),
          );
          runContext.permissionMode = mode;
        };
      }
      // 项目指令文件（AGENTS.md / CLAUDE.md / EVA.md）：每回合读取一次，
      // 注入主智能体系统提示，并随委派传给子智能体，保证项目约定全链路生效。
      const projectDocs = await loadProjectDocs(workspacePath);

      // 委派中心：Delegate 工具的后端。定义来自子智能体目录（内置 + 自定义），
      // 每个运行一个实例；运行结束（完成或中止）时停掉所有仍在跑的委派。
      // 注意必须在 createToolSet 之前注入：DelegationToolProvider 依据桥是否存在决定贡献哪些工具。
      const subAgentDefinitions = await subAgentService.activeList();
      const delegationHub = new DelegationHub({
        definitions: subAgentDefinitions,
        workspacePath,
        projectDocs,
        runContext,
        mode,
        effort: reasoningEffort,
        sessionSelection: effectiveSelection,
        signal: activeRun.signal,
      });
      if (subAgentDefinitions.length > 0) {
        runContext.delegate = delegationHub;
      }

      const tools = await toolProviderRegistry.createToolSet(runContext);
      const maxSteps = mode === "deep" ? 120 : 80;

      // 显式推理等级优先；旧客户端的 thinkingMode=deep 视为开启深度思考。
      const deepThinking = reasoningEffort ? reasoningEffort !== "off" : mode === "deep";

      // plan 模式的行为指引：先只读调研、用 ExitPlanMode 呈交计划，获批
      // 前变更类工具会被门控拦下（返回引导性错误而不是异常）。
      const planModeInstructions =
        permissionMode === "plan"
          ? "Plan mode is active: research first, then present your plan with the " +
            "ExitPlanMode tool before changing anything. Every tool that modifies " +
            "files, runs commands, or mutates state is blocked until the user " +
            "approves; read, search, task-list, delegation, and askUser tools work " +
            "normally. Build the plan from evidence you verified yourself (read " +
            "the files, run searches) — do not speculate about code you have not " +
            "seen. The plan is concise markdown: the goal, ordered steps, files to " +
            "create or edit, commands to run, and how you will verify. If the user " +
            "rejects it, incorporate the feedback and present a revised plan."
          : undefined;

      // 已启用技能逐目录注入：Mastra 负责注入 <available_skills> 目录与
      // skill / skill_read 工具；同名冲突已在服务层按来源优先级去重。
      const activeSkills = await skillService.activeSkills();

      const agent = new Agent({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        instructions: [
          definition.instructions,
          deepThinking
            ? "Think carefully before acting; reason through edge cases and verify assumptions when useful."
            : undefined,
          planModeInstructions,
          projectDocs ? projectDocsSection(projectDocs) : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
        model,
        tools,
        skills: activeSkills.map((skill) => skill.dir),
        maxRetries: 3,
        inputProcessors: [new TokenLimiterProcessor({ limit: config.contextWindow })],
        defaultOptions: { maxSteps },
      });

      // 非图片附件（PDF/Word/表格等）先落盘到工作区 attachments/，模型
      // 副本里替换为路径提示；UI 消息保持原 file part，回显不受影响。
      const { messages: attachmentBound } = await materializeAttachments(
        messages,
        workspacePath,
      );
      // "/<技能 id> 参数" 的显式调用同样只展开在模型副本里，历史回显保持
      // 紧凑的斜杠命令文本。
      const modelBoundMessages = await skillService.applyInvocation(attachmentBound);

      // 上下文压缩：估算 token 超过阈值时，把较早消息总结成持久摘要
      // （会话级压缩点），模型副本变为「摘要 + 近期消息」；UI 历史、
      // 回放与 wiki 总结区间都基于完整消息数组，不受影响。摘要用会话
      // 模型关闭思考生成；任何失败都退回完整历史，由 TokenLimiterProcessor
      // 硬截断兜底。
      let compactedMessages = modelBoundMessages;
      try {
        const outcome = await prepareCompactedMessages({
          conversationId: context.conversationId,
          messages: modelBoundMessages,
          contextWindow: config.contextWindow,
          summarize: async (system, prompt) => {
            const { text } = await generateText({
              model: await createModel(mode, effectiveSelection, "off"),
              system,
              prompt,
            });
            return text;
          },
        });
        compactedMessages = outcome.messages;
      } catch (error) {
        console.error("context compaction failed, falling back to full history", error);
      }

      const modelMessages = await convertToModelMessages(compactedMessages, {
        ignoreIncompleteToolCalls: true,
      });
      const mastraStream = await agent.stream(modelMessages, {
        abortSignal: activeRun.signal,
        maxSteps,
      });
      const sourceChunks = toAISdkStream(mastraStream, {
        from: "agent",
        version: "v6",
        sendReasoning: true,
        sendStart: true,
        sendFinish: true,
      });
      const turnStartedAt = Date.now();

      let released = false;
      let releaseOwnership!: () => void;
      const ownershipComplete = new Promise<void>((resolve) => {
        releaseOwnership = () => {
          if (released) return;
          released = true;
          resolve();
        };
      });

      const persistedTitle = messages
        .filter((message) => message.role === "user")
        .at(-1)?.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .trim()
        .slice(0, 80);

      const uiStream = createUIMessageStream<ChatUIMessage>({
        originalMessages: messages,
        execute: async ({ writer }) => {
          // 工具通过 run.notifyPreview 请求打开面板预览（生成 HTML、启动
          // 开发服务器等场景）；在进入流读取循环前注入 writer 引用。
          runContext.notifyPreview = (data) => {
            writer.write({
              type: "data-oh:preview.open",
              id: crypto.randomUUID(),
              data,
            });
          };
          // 委派直播：子智能体的启动/每步工具/完成事件以 data-oh:subagent.*
          // 部件推入主流，前端折叠为 PI 式实时卡片。等待 DelegateWait 期间
          // 界面因此仍有活动，而不是看起来阻塞。
          delegationHub.notify = (notice: DelegationNotice) => {
            const type = `data-oh:subagent.${notice.kind}` as const;
            writer.write({ type, id: crypto.randomUUID(), data: notice });
          };
          const reader = sourceChunks.getReader();
          // Persisting every chunk used to await inside the read loop, which
          // throttled streaming and hammered SQLite on long runs. The chain
          // keeps event order (sequence assignment stays serialized) without
          // blocking the stream.
          let persistChain = Promise.resolve();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
            persistChain = persistChain
              .then(() => runService.appendTransition(run.id, value.type, value))
              .catch(console.error);
          }

          // Turn-level token usage for the client's usage panel. Mastra's
          // stream exposes the accumulated provider usage once streaming has
          // ended; reading it may reject when the run aborted early, so the
          // part is still emitted with timing-only data in that case.
          let totalUsage: unknown;
          try {
            totalUsage = await mastraStream.totalUsage;
          } catch {
            totalUsage = undefined;
          }
          const usageRecord =
            totalUsage && typeof totalUsage === "object"
              ? (totalUsage as {
                  inputTokens?: number;
                  outputTokens?: number;
                  totalTokens?: number;
                  inputTokenDetails?: {
                    cacheReadTokens?: number;
                    cacheWriteTokens?: number;
                  };
                  outputTokenDetails?: { reasoningTokens?: number };
                })
              : undefined;
          const usagePart = {
            type: "data-oh:usage" as const,
            id: crypto.randomUUID(),
            data: {
              inputTokens: usageRecord?.inputTokens ?? 0,
              outputTokens: usageRecord?.outputTokens ?? 0,
              totalTokens: usageRecord?.totalTokens ?? 0,
              cacheReadTokens: usageRecord?.inputTokenDetails?.cacheReadTokens ?? 0,
              cacheWriteTokens: usageRecord?.inputTokenDetails?.cacheWriteTokens ?? 0,
              reasoningTokens:
                usageRecord?.outputTokenDetails?.reasoningTokens ?? 0,
              durationMs: Date.now() - turnStartedAt,
              providerId: effectiveSelection?.providerId,
              modelId: effectiveSelection?.modelId,
            },
          };
          writer.write(usagePart);
        },
        onStepFinish: ({ messages: stepMessages }) =>
          runService.saveStep(
            context.conversationId,
            stepMessages as ChatUIMessage[],
            persistedTitle,
          ),
        onFinish: async ({ messages: finalMessages, isAborted }) => {
          // 先落盘消息、再结束运行状态：保证客户端一旦观察到运行不再是
          // 进行中，快照里就一定已包含最终消息（重连判定依赖这一顺序）。
          await runService.saveStep(
            context.conversationId,
            finalMessages as ChatUIMessage[],
            persistedTitle,
          );
          await runService.finish(run.id, isAborted ? "aborted" : "completed");
          releaseOwnership();
          // 知识库自动总结：回合正常完成且产生了文字总结时入队（串行队列
          // 后台消费，与聊天流完全解耦；同会话排队任务自动合并窗口）。
          if (!isAborted && lastRunHasText(finalMessages as ChatUIMessage[])) {
            void (async () => {
              try {
                if (!(await isAutoIngestEnabledFor(context.projectId))) return;
                await wikiQueue.enqueueTurn({
                  conversationId: context.conversationId,
                  projectId: context.projectId ?? null,
                  fromSeq: messages.length,
                  toSeq: finalMessages.length,
                  trigger: "auto",
                });
              } catch (error) {
                console.error("wiki auto ingest enqueue failed", error);
              }
            })();
          }
        },
        onError: (error) => {
          console.error(error);
          return "The local agent run failed.";
        },
      });

      // Some transport failures end before an AI SDK finish callback; release
      // the run's controller ownership when ownership work has stopped, and
      // stop every delegation the run left running.
      void ownershipComplete.finally(() => {
        delegationHub.dispose();
        activeRun.cleanup();
      });
      activeRun.signal.addEventListener("abort", () => {
        setTimeout(releaseOwnership, 1_000);
      }, { once: true });

      // 后台运行：把 UI 流一分为二。clientBranch 给当前 HTTP 客户端，
      // 断开即止、不影响运行；pumpBranch 由常驻泵消费——它驱动
      // onStepFinish/onFinish 的持久化（这些回调只在流被读取时触发），
      // 并把每个 chunk 写入 runHub，供切换回来/刷新后的客户端通过
      // GET /api/chat/:conversationId/stream 重连回放。
      runHub.open(run.id);
      const [clientBranch, pumpBranch] = uiStream.tee();
      void (async () => {
        const reader = pumpBranch.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            runHub.publish(run.id, value);
          }
        } catch (error) {
          console.error("run stream pump failed", error);
        } finally {
          runHub.close(run.id);
        }
      })();

      return createUIMessageStreamResponse({
        stream: clientBranch,
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    } catch (error) {
      activeRun.cleanup();
      await runService.finish(run.id, "failed", truncateError(error));
      throw error;
    }
  }

  describe() {
    // Tool availability does not vary by thinking mode; policies are listed
    // for the default permission posture (read-only capability overview).
    const tools = Object.entries(
      toolProviderRegistry.policiesFor({ mode: "confirm", readOnly: true }),
    )
      .filter(([, policy]) => policy.enabled)
      .map(([name]) => name);
    return THINKING_MODES.map((mode) => ({ mode, tools }));
  }
}

export const agentRuntime = new AgentRuntimeService();
