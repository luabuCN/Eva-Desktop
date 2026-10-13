import { Hono } from "hono";
import { z } from "zod";
import type { ChatUIMessage } from "../chat-types.js";
import { prisma } from "../db.js";
import {
  ASPECT_RATIO_IDS,
  IMAGE_STYLE_IDS,
  generateImages,
  inferCountFromPrompt,
  inferRatioFromPrompt,
  inferStyleFromPrompt,
} from "../images/image-service.js";
import { sessionRepository } from "../repositories/session-repository.js";
import { runService } from "../runtime/run-service.js";
import { getWorkspaceRoot } from "../runtime/workspace.js";

/**
 * 对话内直出生图：图像生成模式下前端不经 agent 循环直接调用本端点，
 * 生成结果落盘工作区后构造 user/assistant 两条消息整体持久化（与
 * /api/chat 的全量快照模型一致）。图片网格以 data-oh:imagegen 部件存
 * 工作区相对路径，前端回放时经 /preview 运行时拼地址。
 */

const generateRequestSchema = z.object({
  id: z.string().min(1).optional(),
  messages: z.array(z.custom<ChatUIMessage>()).default([]),
  prompt: z.string().trim().min(1),
  model: z
    .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
    .optional(),
  ratio: z
    .string()
    .refine((value) => ASPECT_RATIO_IDS.includes(value))
    .default("auto"),
  style: z
    .string()
    .refine((value) => IMAGE_STYLE_IDS.includes(value))
    .default("none"),
  /** 1-4 为显式张数；0 表示「自动」，从提示词关键词推断（默认 1）。 */
  count: z.number().int().min(0).max(4).default(0),
  projectId: z.string().uuid().optional(),
});

/** 结果卡 data-oh:imagegen 部件的载荷（前端 ImageGenData 的镜像）。 */
interface ImageGenPartData {
  prompt: string;
  finalPrompt: string;
  model: string;
  ratio: string;
  style: string;
  files: Array<{ path: string; bytes: number }>;
}

export const imageRoutes = new Hono();

imageRoutes.post("/generate", async (c) => {
  const body = generateRequestSchema.parse(await c.req.json());
  const sessionId = body.id ?? crypto.randomUUID();

  // 与 agent 运行互斥：运行中的会话整体快照会被回合收尾覆盖，此时直出
  // 生图追加的消息可能丢失，直接拒绝让前端提示稍后再试。
  const active = await runService.activeRun(sessionId);
  if (active) {
    return c.json({ error: "当前会话有正在进行的运行，请结束后再生成图片。" }, 409);
  }

  // 工作区解析与 agent-runtime 同规则：项目 rootPath 优先，否则全局工作区。
  let workspacePath: string;
  if (body.projectId) {
    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    if (!project?.isActive) {
      return c.json({ error: "项目不存在或已被停用" }, 400);
    }
    workspacePath = project.rootPath;
  } else {
    workspacePath = (await getWorkspaceRoot()).path;
  }

  const userMessage: ChatUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: body.prompt }],
  };

  // 生成前先入库会话与 user 消息：十几秒的生图期间侧栏「最近」即可看到
  // 该对话（标题取提示词），而不是完成后才出现；完成后再整体追加
  // assistant 消息。互斥/工作区校验均在此前完成，不会留下空会话。
  await sessionRepository.ensure(sessionId, "New chat", body.projectId);
  await sessionRepository.saveUIMessages(sessionId, [...body.messages, userMessage]);

  // UI 显式选择优先；参数行为「自动/无」时才从提示词文本推断（“比例3:4”
  // “竖版”“国潮”等关键词），推断结果作为实际生效值写入结果卡参数摘要。
  const ratio =
    body.ratio === "auto" ? (inferRatioFromPrompt(body.prompt) ?? "auto") : body.ratio;
  const style =
    body.style === "none" ? (inferStyleFromPrompt(body.prompt) ?? "none") : body.style;
  const count =
    body.count === 0 ? (inferCountFromPrompt(body.prompt) ?? 1) : body.count;

  // 生成失败也持久化 assistant 错误文本：历史刷新后一致，且不打断会话。
  let assistantMessage: ChatUIMessage;
  try {
    const result = await generateImages({
      prompt: body.prompt,
      ratio,
      style,
      count,
      model: body.model,
      workspacePath,
      conversationId: sessionId,
      projectId: body.projectId,
      signal: c.req.raw.signal,
    });
    const data: ImageGenPartData = {
      prompt: body.prompt,
      finalPrompt: result.finalPrompt,
      model: result.modelLabel,
      ratio,
      style,
      files: result.files.map((file) => ({ path: file.relativePath, bytes: file.bytes })),
    };
    assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "data-oh:imagegen", id: crypto.randomUUID(), data }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: `图片生成失败：${message}` }],
    };
  }

  // 收尾整体落一次全量快照（含 assistant），标题维持提示词提取。
  await sessionRepository.saveUIMessages(sessionId, [
    ...body.messages,
    userMessage,
    assistantMessage,
  ]);
  return c.json({ id: sessionId, messages: [userMessage, assistantMessage] });
});
