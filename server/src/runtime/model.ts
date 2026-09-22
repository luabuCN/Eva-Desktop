import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  resolveModelConfig,
  resolveSelectionConfig,
  type ModelSelection,
} from "../providers/provider-service.js";
import { agentProfiles, type ReasoningEffort, type ThinkingMode } from "./types.js";

type ChatModel = ReturnType<
  ReturnType<typeof createOpenAICompatible>["languageModel"]
>;

/**
 * The gateway speaks the OpenAI chat-completions protocol but streams
 * thinking via `delta.reasoning_content`, which @ai-sdk/openai's chat
 * completions path never parses. `@ai-sdk/openai-compatible` (the same
 * provider aime-chat uses for custom endpoints) maps both `reasoning_content`
 * and `reasoning` deltas onto AI SDK reasoning parts, so streamed thinking
 * works out of the box for any OpenAI-compatible model we attach later.
 *
 * The gateway also rejects OpenAI's reasoning-model conventions such as the
 * `developer` system role, so the SDK's forceReasoning provider option cannot
 * be used. Qwen toggles thinking natively via `enable_thinking`, injected at
 * the transport layer so each runtime profile gets the right behavior without
 * forking the SDK.
 *
 * Reasoning effort (off/low/medium/high) rides the same transport injection:
 * `enable_thinking` gates thinking entirely and `reasoning_effort` selects the
 * depth for providers that support it (ignored elsewhere, matching how the
 * OpenAI-compatible ecosystem treats unknown body fields).
 *
 * Base URL / API key / model id are resolved per request-epoch from the
 * saved provider configuration (same idea as aime-chat's ProvidersManager):
 * an explicit selection from the chat prompt input wins, otherwise the first
 * enabled model of the first active provider. .env is never consulted for
 * models.
 */
async function createModelForMode(
  mode: ThinkingMode,
  selection?: ModelSelection,
  effort?: ReasoningEffort,
): Promise<ChatModel> {
  const enableThinking = effort ? effort !== "off" : agentProfiles[mode].enableThinking;
  const resolved = selection
    ? await resolveSelectionConfig(selection)
    : await resolveModelConfig();
  const provider = createOpenAICompatible({
    name: resolved.providerName,
    baseURL: resolved.baseURL,
    apiKey: resolved.apiKey,
    includeUsage: true,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          init = {
            ...init,
            body: JSON.stringify({
              ...body,
              enable_thinking: enableThinking,
              ...(effort && effort !== "off" ? { reasoning_effort: effort } : {}),
            }),
          };
          // 请求体积观测：混合内容按 ~4 字符/token 粗估，帮助定位上下文
          // 膨胀。仅打一行摘要，不打正文。OPENHARNESS_LOG_PROMPT_SIZE 开启。
          if (process.env.OPENHARNESS_LOG_PROMPT_SIZE) {
            const msgs = Array.isArray(body.messages) ? body.messages : [];
            let chars = 0;
            for (const m of msgs) {
              const c = m?.content;
              if (typeof c === "string") chars += c.length;
              else if (Array.isArray(c))
                for (const p of c)
                  chars += typeof p?.text === "string" ? p.text.length : 0;
            }
            const toolsLen = body.tools ? JSON.stringify(body.tools).length : 0;
            console.log(
              `[prompt-size] messages=${msgs.length} msgChars=${chars}(~${Math.round(chars / 4)}tok) toolsChars=${toolsLen}(~${Math.round(toolsLen / 4)}tok)`,
            );
          }
        } catch {
          // Leave unparseable bodies untouched so the provider surfaces the error.
        }
      }
      return fetch(input, init);
    },
  });

  return provider.languageModel(resolved.model);
}

export function createModel(
  mode: ThinkingMode,
  selection?: ModelSelection,
  effort?: ReasoningEffort,
): Promise<ChatModel> {
  return createModelForMode(mode, selection, effort);
}
