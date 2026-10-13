import { prisma } from "../db.js";

/**
 * 委派式子智能体（参考 PI-Desktop ADR 0062/0089）：主 Agent 通过 Delegate
 * 工具把一段自包含任务交给后台运行的子 Agent，只有最终报告回到主上下文。
 *
 * 定义有两个来源，都落在这张表里：内置六条（planner / explorer /
 * code-reviewer / test-runner / fixer / artist，启动时刷新核心字段），
 * 以及设置页创建的自定义行。
 * 工具白名单在 service 层校验；可写工具（bash/writeFile/editFile/mkdir/git*）
 * 决定子 Agent 派生上下文是否可写。
 */

export interface SubAgentDefinitionInfo {
  id: string;
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  providerId?: string | null;
  modelId?: string | null;
  /** generateImage 工具的固定图片模型；空 = 运行时自动发现。 */
  imageProviderId?: string | null;
  imageModelId?: string | null;
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
  imageProviderId?: string | null;
  imageModelId?: string | null;
  maxTurns?: number | null;
  isActive?: boolean;
}

/** These earn their prompt-token cost by being work the main agent would
 * otherwise do inline at full context cost (PI-Desktop's bar for builtins). */
export const BUILTIN_SUBAGENTS: ReadonlyArray<
  Omit<SubAgentDefinitionInfo, "id" | "createdAt" | "updatedAt">
> = [
  {
    name: "planner",
    description:
      "Turn a fuzzy build request into a complete, self-contained implementation plan: mechanics, exact asset paths, file layout, acceptance criteria. Use as the FIRST stage of any large build (a game, an app, a multi-part deliverable) before implementation starts.",
    tools: ["readFile", "listFiles", "glob", "grep"],
    prompt: [
      "You are the Planner — the first stage of a build pipeline. The main agent",
      "delegates a raw idea or feature request; you return one complete plan the",
      "next stages can execute without further decisions.",
      "",
      "- Look at the workspace enough to ground the plan (existing structure,",
      "  conventions, anything reusable). Do not over-research: the plan, not a",
      "  code survey, is the deliverable.",
      "- Scope honestly to what the task names; propose concrete mechanics, screens",
      "  or sections, and controls — not generic bullet points.",
      "- Default to a single self-contained HTML file for games and small tools",
      "  unless the task or workspace clearly says otherwise.",
      "- The asset manifest is a contract: list every image with its EXACT relative",
      "  path (e.g. assets/snake-head.png), a one-line description, and the shared",
      "  style. The artist generates exactly these paths; the code references",
      "  exactly these paths. Never let the two sides invent their own names.",
      "",
      "Report in this shape:",
      "",
      "<summary>",
      "2-3 sentences: what will be built and the approach.",
      "</summary>",
      "<assets>",
      "- assets/<name>.png — what it depicts; shared style: <one consistent style phrase>",
      "(omit this section when the build needs no generated images)",
      "</assets>",
      "<files>",
      "- <path>: what lives there and its responsibilities",
      "</files>",
      "<acceptance>",
      "- How to verify the build works (run it, click through, checks that pass)",
      "</acceptance>",
    ].join("\n"),
    providerId: null,
    modelId: null,
    maxTurns: 30,
    isActive: true,
    isBuiltIn: true,
  },
  {
    name: "explorer",
    description:
      "Fast workspace search — find files, locate implementations, answer \"where is X?\" / \"how does Y work?\". Use when answering needs a sweep over many files and only the conclusion matters.",
    tools: ["readFile", "listFiles", "glob", "grep", "bash"],
    prompt: [
      "You are Explorer — a fast workspace navigation specialist.",
      "",
      "- Prefer grep for text/regex patterns, glob for file discovery by name, readFile for specific files.",
      "- Fire several searches in parallel when the answer needs more than one place.",
      "- Follow definitions and call sites; do not stop at the first hit if the question implies more than one.",
      "- Quote the few lines that answer the question and cite path:line for each.",
      "",
      "Report in this shape:",
      "",
      "<files>",
      "- src/app.ts:42 — brief description of what's there",
      "</files>",
      "<answer>",
      "Concise answer to the question. If you could not find it, say what you",
      "searched and where the trail went cold — a precise dead end is more useful",
      "than a guess.",
      "</answer>",
    ].join("\n"),
    providerId: null,
    modelId: null,
    maxTurns: 60,
    isActive: true,
    isBuiltIn: true,
  },
  {
    name: "code-reviewer",
    description:
      "Review specific code or a specific change for defects. Use for a second opinion on correctness, edge cases and missing tests before committing.",
    tools: ["readFile", "listFiles", "glob", "grep"],
    prompt: [
      "Review only what the task names, and read enough surrounding code to judge it.",
      "",
      "- Prefer defects that change behavior: wrong results, unhandled failures,",
      "  broken invariants, races, resource leaks, missing test coverage.",
      "- Check the code against how its callers and neighbors actually use it, not",
      "  against a style preference.",
      "- Say nothing about formatting, naming or structure unless it causes a defect.",
      "",
      "Report: each finding as path:line plus one sentence on what breaks and under",
      "what input. Order by severity. If the code is sound, say so plainly and name",
      "the cases you checked — an empty review with no evidence is not a review.",
    ].join("\n"),
    providerId: null,
    modelId: null,
    maxTurns: 50,
    isActive: true,
    isBuiltIn: true,
  },
  {
    name: "test-runner",
    description:
      "Run a specific test or build command and report what failed and why. Use when a command's output is long and only the failures matter.",
    tools: ["readFile", "listFiles", "glob", "grep", "bash"],
    prompt: [
      "Run the command the task names. Do not invent a different one, and do not fix",
      "anything: diagnosis is the deliverable.",
      "",
      "- Run the command once. If it fails to start (missing script, wrong directory),",
      "  find the right invocation and say what you changed.",
      "- For each failure, read the failing test and the code under it far enough to",
      "  name the cause.",
      "",
      "Report: pass/fail counts, then one entry per failure with the test name, the",
      "assertion or error, and the path:line you believe is responsible. Keep the",
      "raw output out of the report except for the lines that carry the failure.",
    ].join("\n"),
    providerId: null,
    modelId: null,
    maxTurns: 40,
    isActive: true,
    isBuiltIn: true,
  },
  {
    name: "fixer",
    description:
      "Implement a complete multi-file change from a spec. Use when a feature or fix spans several files and the work is separable — it can write files inside the workspace while you keep working.",
    tools: ["readFile", "listFiles", "glob", "grep", "bash", "writeFile", "editFile"],
    prompt: [
      "You are Fixer — a fast, focused implementation specialist. The main agent",
      "delegates a complete, self-contained spec; implement it. Do not re-plan and do",
      "not research beyond what the task needs.",
      "",
      "- Read every file you will change first; never edit or write from memory or",
      "  from stale content.",
      "- Keep changes minimal and scoped to the task. Do not touch unrelated code.",
      "- You may write inside the workspace; never write outside it.",
      "- Run the relevant validation when the task names one; otherwise report it",
      "  skipped with a reason.",
      "- Do not delegate and do not ask the user. If the spec lacks context you",
      "  truly need, search for it yourself.",
      "",
      "Report in this shape:",
      "",
      "<summary>",
      "2-3 sentences: what was implemented and the outcome.",
      "</summary>",
      "<changes>",
      "- path/file.ts: what changed (function or line level)",
      "</changes>",
      "<verification>",
      "- Tests: [passed / failed / skipped: reason]",
      "- Validation: [passed / failed / skipped: reason]",
      "</verification>",
    ].join("\n"),
    providerId: null,
    modelId: null,
    maxTurns: 80,
    isActive: true,
    isBuiltIn: true,
  },
  {
    name: "artist",
    description:
      "Generate image assets (game sprites, icons, backgrounds, illustrations) with generateImage and save them at the exact paths a plan specifies. Use as the asset stage of a build pipeline, after the planner and in parallel with code implementation.",
    tools: ["readFile", "listFiles", "generateImage"],
    prompt: [
      "You are the Artist — the asset stage of a build pipeline. The task names a",
      "plan (usually the planner's report) with an asset manifest; you produce",
      "every listed image at exactly the listed path.",
      "",
      "- The manifest's paths and style are a contract: same path, same style",
      "  phrase in every prompt, so the set looks like one product.",
      "- Write a precise prompt per asset: subject, composition, orientation,",
      "  palette, and the shared style wording from the manifest.",
      "- Generate each asset with generateImage at its exact filePath; verify with",
      "  listFiles that the file exists before reporting it done.",
      "- When the manifest is missing or ambiguous, choose sensible paths under",
      "  assets/ and a coherent style yourself — do not stall, and say what you",
      "  chose.",
      "- If no image model is available (the tool errors about model discovery),",
      "  report that plainly and list the assets still missing — never claim a",
      "  file you could not create.",
      "",
      "Report in this shape:",
      "",
      "<assets>",
      "- assets/<name>.png — generated: what it depicts, model used",
      "</assets>",
      "<missing>",
      "- paths that failed or were skipped, with the reason",
      "(omit when nothing is missing)",
      "</missing>",
    ].join("\n"),
    providerId: null,
    modelId: null,
    maxTurns: 40,
    isActive: true,
    isBuiltIn: true,
  },
];

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TURNS_LIMIT = 200;

function parseTools(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function serialize(row: {
  id: string;
  name: string;
  description: string;
  tools: string;
  prompt: string;
  providerId: string | null;
  modelId: string | null;
  imageProviderId: string | null;
  imageModelId: string | null;
  maxTurns: number | null;
  isActive: boolean;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SubAgentDefinitionInfo {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tools: parseTools(row.tools),
    prompt: row.prompt,
    providerId: row.providerId,
    modelId: row.modelId,
    imageProviderId: row.imageProviderId,
    imageModelId: row.imageModelId,
    maxTurns: row.maxTurns,
    isActive: row.isActive,
    isBuiltIn: row.isBuiltIn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function validateModelPin(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  label = "固定模型",
) {
  if (!providerId && !modelId) return;
  if (!providerId || !modelId) {
    throw new Error(`${label}的供应商和模型必须同时设置`);
  }
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider?.isActive) throw new Error(`${label}的供应商不存在或未启用`);
}

class SubAgentService {
  async list(): Promise<SubAgentDefinitionInfo[]> {
    const rows = await prisma.subAgentDefinition.findMany({
      orderBy: [{ isBuiltIn: "desc" }, { createdAt: "asc" }],
    });
    return rows.map(serialize);
  }

  /** Definitions the runtime exposes to the Delegate tool. */
  async activeList(): Promise<SubAgentDefinitionInfo[]> {
    const rows = await prisma.subAgentDefinition.findMany({
      where: { isActive: true },
      orderBy: [{ isBuiltIn: "desc" }, { createdAt: "asc" }],
    });
    return rows.map(serialize);
  }

  async create(input: SubAgentDefinitionInput): Promise<SubAgentDefinitionInfo> {
    const name = input.name?.trim() ?? "";
    if (!NAME_PATTERN.test(name)) {
      throw new Error("名称只能包含字母、数字、下划线和短横线（最长 64）");
    }
    if (!input.description?.trim()) throw new Error("描述不能为空（模型据此决定何时委派）");
    if (!input.prompt?.trim()) throw new Error("系统提示词不能为空");
    const tools = input.tools ?? [];
    if (tools.length === 0) throw new Error("至少选择一个工具");
    if (await prisma.subAgentDefinition.findUnique({ where: { name } })) {
      throw new Error(`子智能体 "${name}" 已存在`);
    }
    await validateModelPin(input.providerId, input.modelId);
    await validateModelPin(input.imageProviderId, input.imageModelId, "图片生成模型");
    const row = await prisma.subAgentDefinition.create({
      data: {
        name,
        description: input.description.trim(),
        tools: JSON.stringify([...new Set(tools)]),
        prompt: input.prompt.trim(),
        providerId: input.providerId || null,
        modelId: input.providerId ? input.modelId || null : null,
        imageProviderId: input.imageProviderId || null,
        imageModelId: input.imageProviderId ? input.imageModelId || null : null,
        maxTurns: normalizeMaxTurns(input.maxTurns),
        isActive: input.isActive ?? true,
      },
    });
    return serialize(row);
  }

  async update(id: string, input: SubAgentDefinitionInput): Promise<SubAgentDefinitionInfo> {
    const current = await prisma.subAgentDefinition.findUnique({ where: { id } });
    if (!current) throw new Error("子智能体不存在");
    if (current.isBuiltIn && !onlyActivation(input)) {
      throw new Error("内置子智能体不能编辑，可复制为自定义版本后修改");
    }

    const name = input.name === undefined ? current.name : input.name.trim();
    if (!NAME_PATTERN.test(name)) {
      throw new Error("名称只能包含字母、数字、下划线和短横线（最长 64）");
    }
    if (name !== current.name && await prisma.subAgentDefinition.findUnique({ where: { name } })) {
      throw new Error(`子智能体 "${name}" 已存在`);
    }
    const providerId =
      input.providerId === undefined
        ? current.providerId
        : input.providerId || null;
    const modelId =
      input.modelId === undefined
        ? current.modelId
        : input.providerId !== undefined && !input.providerId
          ? null
          : input.modelId || null;
    await validateModelPin(providerId, modelId);
    // 图片模型固定项与思考模型固定项同语义：成对设置、清供应商即整体清除。
    const imageProviderId =
      input.imageProviderId === undefined
        ? current.imageProviderId
        : input.imageProviderId || null;
    const imageModelId =
      input.imageModelId === undefined
        ? current.imageModelId
        : input.imageProviderId !== undefined && !input.imageProviderId
          ? null
          : input.imageModelId || null;
    await validateModelPin(imageProviderId, imageModelId, "图片生成模型");

    const row = await prisma.subAgentDefinition.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.tools !== undefined
          ? { tools: JSON.stringify([...new Set(input.tools)]) }
          : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
        providerId,
        modelId,
        imageProviderId,
        imageModelId,
        ...(input.maxTurns !== undefined ? { maxTurns: normalizeMaxTurns(input.maxTurns) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return serialize(row);
  }

  async remove(id: string): Promise<void> {
    const current = await prisma.subAgentDefinition.findUnique({ where: { id } });
    if (!current) throw new Error("子智能体不存在");
    if (current.isBuiltIn) throw new Error("内置子智能体不能删除，只能停用");
    await prisma.subAgentDefinition.delete({ where: { id } });
  }

  /** 启动时刷新内置定义的核心字段（name 唯一键不允许变，isActive 保留用户选择）。 */
  async seedBuiltins(): Promise<void> {
    for (const builtin of BUILTIN_SUBAGENTS) {
      await prisma.subAgentDefinition.upsert({
        where: { name: builtin.name },
        create: {
          name: builtin.name,
          description: builtin.description,
          tools: JSON.stringify(builtin.tools),
          prompt: builtin.prompt,
          maxTurns: builtin.maxTurns,
          isActive: builtin.isActive,
          isBuiltIn: true,
        },
        update: {
          description: builtin.description,
          tools: JSON.stringify(builtin.tools),
          prompt: builtin.prompt,
          maxTurns: builtin.maxTurns,
          isBuiltIn: true,
        },
      });
    }
  }
}

function onlyActivation(input: SubAgentDefinitionInput): boolean {
  // 内置定义的角色字段（提示词/工具等）不可改；isActive 与图片模型固定项
  // 属于运行配置，与"启用"同级别放行——内置 artist 也要能换生图模型。
  return Object.keys(input).every(
    (key) =>
      key === "isActive" || key === "imageProviderId" || key === "imageModelId",
  );
}

function normalizeMaxTurns(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TURNS_LIMIT);
}

export const subAgentService = new SubAgentService();
