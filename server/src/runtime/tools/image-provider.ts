import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  fetchImages,
  resolveImageModel,
  saveImageToWorkspace,
  type ImageModelRef,
} from "../../images/image-service.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RunContext } from "./run-context.js";
import type { RuntimeTool } from "./types.js";

/**
 * 图片生成工具：调用已配置 Provider 中的图片模型（OpenAI 兼容
 * /images/generations），落盘到工作区后把相对路径交回模型。供"美术"
 * 子智能体在游戏/交付物流水线里批量产出素材；图片模型按启用列表里的
 * 命名特征自动发现，也可在调用时显式指定。
 *
 * 底层实现（模型发现 / 接口调用 / 落盘登记）在 images/image-service.ts，
 * 与对话内直出端点共用；本文件只保留工具 schema 与错误语义。
 */

const IMAGE_SIZES = [
  "auto",
  "512x512",
  "768x768",
  "1024x1024",
  "1024x1536",
  "1536x1024",
] as const;

function errorResult(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

export class ImageToolProvider implements ToolProvider {
  readonly id = "image";
  readonly label = "图片生成";

  listTools(): ToolDescriptor[] {
    return [
      {
        name: "generateImage",
        label: "Generate image",
        description:
          "Generate an image with a configured image model and save it into the workspace (assets/ by default). Returns the file path for the page or code to reference.",
        risk: "medium",
        mutating: true,
        defaultPolicy: { enabled: true, requireApproval: true },
        providerId: this.id,
      },
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    const tool: RuntimeTool = createTool({
      id: "generateImage",
      description:
        "Generate one image from a text prompt and save it into the workspace, defaulting to assets/. " +
        "The image model resolves in order: this call's providerId/modelId arguments, the default pinned in the running subagent's configuration, then auto-discovery from enabled providers (gpt-image / qwen-image / cogview / seedream / flux families). " +
        "Describe the image precisely: subject, style, palette, and for game assets also the orientation and whether the background must be transparent-friendly flat color. " +
        "Reuse the same style wording across calls so a set of assets stays consistent.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("The image to generate: subject, style, palette, constraints."),
        filePath: z
          .string()
          .optional()
          .describe("Workspace-relative output path (default assets/image-<timestamp>.png). Use the exact path the plan specifies."),
        size: z.enum(IMAGE_SIZES).optional().describe("Image dimensions; defaults to auto."),
        providerId: z.string().optional().describe("Pin the provider for the image model."),
        modelId: z.string().optional().describe("Pin the image model id."),
      }),
      execute: async ({ prompt, filePath, size = "auto", providerId, modelId }) => {
        if (run.signal?.aborted) return { error: "运行已中止，图片生成取消。" };
        // 默认模型解析顺序：调用参数显式指定 > 运行上下文固定项
        // （子智能体定义的图片模型）> 按命名特征自动发现。
        const pinned =
          providerId && modelId
            ? { providerId, modelId }
            : run.imageModel;
        let model: ImageModelRef | undefined;
        try {
          model = await resolveImageModel(pinned);
        } catch (error) {
          return errorResult(error);
        }
        if (!model) {
          return {
            error:
              "没有可用的图片生成模型：请在设置中启用一个图片模型（如 gpt-image / qwen-image / cogview / seedream 系列），或在调用参数里显式指定 providerId 与 modelId。",
          };
        }

        let bytes: Buffer;
        try {
          [bytes] = await fetchImages(
            model,
            prompt,
            size === "auto" ? undefined : size,
            1,
            run.signal,
          );
        } catch (error) {
          return errorResult(error);
        }

        try {
          const saved = await saveImageToWorkspace({
            workspacePath: run.workspacePath,
            bytes,
            target: filePath?.trim() || undefined,
            runId: run.runId,
            conversationId: run.conversationId,
            projectId: run.projectId,
          });
          return {
            filePath: saved.absolutePath,
            relativePath: saved.relativePath,
            bytes: saved.bytes,
            model: `${model.providerName}/${model.modelId}`,
            prompt,
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    });
    return { generateImage: tool };
  }
}
