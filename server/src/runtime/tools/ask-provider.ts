import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RuntimeTool } from "./types.js";

/** Bounds mirror the desktop card: a few questions, a few options each —
 * more than that is the model dumping a form on the user instead of asking. */
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

const TOOL_DESCRIPTION =
  "Ask the user one or more multiple-choice questions and return the selected answers. " +
  "Each question carries its own options; the desktop card always adds a free-text choice, " +
  "so do not include one yourself. Before generating a document deliverable (PPT, Word, " +
  "Excel, PDF, poster, chart), call this once to confirm the key open parameters " +
  "(audience, length, language, style) — batch every question into a single call, keep " +
  "options concrete, and put your recommended option first. Also use it when a decision " +
  "genuinely belongs to the user (ambiguous requirements, keep/discard choices, " +
  "trade-offs); pick sensible defaults yourself for trivial choices.";

/** Interactive askUser tool: pauses the run on a pending AskUserPrompt row until
 * the client resolves it (see routes/runs.ts), then returns the answers. */
export class AskUserToolProvider implements ToolProvider {
  readonly id = "ask";
  readonly label = "交互工具";

  listTools(): ToolDescriptor[] {
    return [
      {
        name: "askUser",
        label: "Ask user",
        description:
          "Ask the user multiple-choice questions and return the selected answers.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    const askUser: RuntimeTool = createTool({
      id: "askUser",
      description: TOOL_DESCRIPTION,
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z.string().min(1),
              options: z.array(z.string().min(1)).min(1).max(MAX_OPTIONS),
              multiSelect: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(MAX_QUESTIONS),
      }),
      execute: async ({ questions }) => {
        if (run.subAgent || !run.askUser) {
          return {
            error:
              "askUser is not available in this context. Decide yourself with a reasonable default and state the assumption in your reply.",
          };
        }
        const answers = await run.askUser.ask(questions);
        return {
          answers: questions.map((question, index) => ({
            question: question.question,
            selected: answers[index] ?? [],
          })),
        };
      },
    });
    return { askUser };
  }
}
