import { config } from "../../env.js";
import { AskUserToolProvider } from "./ask-provider.js";
import { BuiltinToolProvider } from "./builtin-provider.js";
import { CronToolProvider } from "./cron-provider.js";
import { DelegationToolProvider } from "./delegation-provider.js";
import { GitToolProvider } from "./git-provider.js";
import { resolveToolPolicies } from "./policies.js";
import { createRunContext, type RunContext } from "./run-context.js";
import { TaskToolProvider } from "./task-provider.js";
import { WebSearchToolProvider } from "./websearch-provider.js";
import { WorkspaceToolProvider } from "./workspace-provider.js";
import type {
  ApprovalBridge,
  AskUserBridge,
  DelegationBridge,
  PermissionMode,
  RuntimeTool,
  ToolPermissionMap,
  ToolPolicy,
  ToolRisk,
} from "./types.js";

/** Static metadata for one tool. Mirrors aime-chat's BaseTool declaration:
 * the provider that implements a tool also declares its catalog entry, so new
 * capabilities (MCP, knowledge base, ...) appear everywhere by registering. */
export interface ToolDescriptor {
  name: string;
  label: string;
  description: string;
  risk: ToolRisk;
  mutating: boolean;
  defaultPolicy: ToolPolicy;
  providerId: string;
}

/**
 * A pluggable source of tools (aime-chat's toolkit equivalent). Future
 * providers: MCP servers, knowledge-base search, skill loading.
 */
export interface ToolProvider {
  /** Stable provider id, e.g. "builtin", "workspace", "mcp", "knowledge". */
  readonly id: string;
  /** Human label for grouping in the UI. */
  readonly label: string;
  /** Catalog metadata for every tool this provider can contribute. */
  listTools(): ToolDescriptor[];
  /** Build executable tools for one run. */
  createTools(run: RunContext): Record<string, RuntimeTool>;
}

async function requestApproval(
  approvals: ApprovalBridge,
  toolName: string,
  input: unknown,
) {
  const decision = await approvals.request(
    toolName,
    JSON.stringify(input, null, 2).slice(0, 20_000),
  );
  if (decision.kind === "approved") return;
  if (decision.kind === "aborted") {
    throw new Error(`${toolName} approval was cancelled because the run stopped.`);
  }
  if (decision.kind === "timeout") {
    throw new Error(`${toolName} approval timed out.`);
  }
  throw new Error(
    decision.reason
      ? `User rejected ${toolName}: ${decision.reason}`
      : `User rejected ${toolName}.`,
  );
}

/**
 * Wrap a tool's execute with the approval gate. Applied by the registry so
 * every provider (including future MCP tools that cannot embed approval
 * logic) gets identical gating from the resolved policy.
 */
function wrapWithApproval(
  toolName: string,
  tool: RuntimeTool,
  approvals: ApprovalBridge,
): RuntimeTool {
  const inner = tool.execute;
  if (typeof inner !== "function") return tool;
  // createTool() returns a class instance, so preserve the prototype while
  // cloning own fields and swapping only execute.
  const wrapped: RuntimeTool = Object.create(Object.getPrototypeOf(tool));
  Object.assign(wrapped, tool);
  wrapped.execute = async (input: any, context: any) => {
    await requestApproval(approvals, toolName, input);
    return inner(input, context);
  };
  return wrapped;
}

export interface PoliciesForInput {
  mode: PermissionMode;
  readOnly?: boolean;
  overrides?: ToolPermissionMap;
  disabledTools?: ReadonlySet<string>;
}

export class ToolProviderRegistry {
  private readonly providers = new Map<string, ToolProvider>();
  private readonly toolOwners = new Map<string, string>();

  register(provider: ToolProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Tool provider "${provider.id}" is already registered.`);
    }
    for (const descriptor of provider.listTools()) {
      const owner = this.toolOwners.get(descriptor.name);
      if (owner) {
        throw new Error(
          `Tool "${descriptor.name}" from provider "${provider.id}" conflicts with provider "${owner}".`,
        );
      }
    }
    this.providers.set(provider.id, provider);
    for (const descriptor of provider.listTools()) {
      this.toolOwners.set(descriptor.name, provider.id);
    }
  }

  list(): ToolProvider[] {
    return [...this.providers.values()];
  }

  providerIdOf(toolName: string): string | undefined {
    return this.toolOwners.get(toolName);
  }

  descriptors(): ToolDescriptor[] {
    return [...this.providers.values()].flatMap((provider) => provider.listTools());
  }

  /** Open-set policy resolution over all registered descriptors. */
  policiesFor(input: PoliciesForInput): ToolPermissionMap {
    const policies = resolveToolPolicies({
      descriptors: this.descriptors(),
      mode: input.mode,
      readOnly: input.readOnly,
      overrides: input.overrides,
      disabledTools: input.disabledTools,
    });
    // Deployment flag keeps bash available even when project grants disabled it.
    if (config.enableBash && policies.bash) {
      policies.bash = { ...policies.bash, enabled: true };
    }
    return policies;
  }

  createRunContext(input: {
    conversationId: string;
    runId?: string;
    projectId?: string;
    workspacePath: string;
    agentId?: string;
    mode: PermissionMode;
    readOnly?: boolean;
    overrides?: ToolPermissionMap;
    disabledTools?: ReadonlySet<string>;
    approvals?: ApprovalBridge;
    askUser?: AskUserBridge;
    delegate?: DelegationBridge;
    signal?: AbortSignal;
  }): RunContext {
    const readOnly = input.readOnly ?? false;
    const permissionOverrides = input.overrides ?? {};
    const disabledTools = input.disabledTools ?? new Set<string>();
    return createRunContext({
      conversationId: input.conversationId,
      runId: input.runId,
      projectId: input.projectId,
      workspacePath: input.workspacePath,
      agentId: input.agentId,
      permissionMode: input.mode,
      readOnly,
      permissionOverrides,
      disabledTools,
      toolPolicies: this.policiesFor({
        mode: input.mode,
        readOnly,
        overrides: permissionOverrides,
        disabledTools,
      }),
      approvals: input.approvals,
      askUser: input.askUser,
      delegate: input.delegate,
      signal: input.signal,
    });
  }

  /** Derive a sub-agent context from a parent run, re-resolving policies for
   * the sub-agent's own readOnly posture. Sub-agents share approvals and the
   * abort signal but skip per-conversation task tools. */
  deriveContext(parent: RunContext, changes: { readOnly: boolean }): RunContext {
    if (changes.readOnly === parent.readOnly && parent.subAgent) return parent;
    return createRunContext({
      ...parent,
      readOnly: changes.readOnly,
      subAgent: true,
      // 子智能体不能阻塞在用户输入上，也不能再生委派：
      // askUser 和 Delegate 只属于主智能体回合。
      askUser: undefined,
      delegate: undefined,
      toolPolicies: this.policiesFor({
        mode: parent.permissionMode,
        readOnly: changes.readOnly,
        overrides: parent.permissionOverrides,
        disabledTools: parent.disabledTools,
      }),
    });
  }

  /** Merge every provider's tools for one run, filtered by policy and gated
   * by the approval wrapper. This is the single merge point for builtin,
   * workspace, and future MCP/skill/knowledge tools. */
  createToolSet(run: RunContext): Record<string, RuntimeTool> {
    const tools: Record<string, RuntimeTool> = {};
    for (const provider of this.providers.values()) {
      for (const [name, tool] of Object.entries(provider.createTools(run))) {
        const policy = run.policyFor(name);
        if (!policy.enabled) continue;
        tools[name] =
          policy.requireApproval && run.approvals
            ? wrapWithApproval(name, tool, run.approvals)
            : tool;
      }
    }
    return tools;
  }
}

/** Process-wide registry. Providers register once at import; dynamic sources
 * (MCP, skills) will call register()/unregister() at runtime. */
export const toolProviderRegistry = new ToolProviderRegistry();

toolProviderRegistry.register(new BuiltinToolProvider());
toolProviderRegistry.register(new WorkspaceToolProvider());
toolProviderRegistry.register(new GitToolProvider());
toolProviderRegistry.register(new TaskToolProvider());
toolProviderRegistry.register(new AskUserToolProvider());
toolProviderRegistry.register(new DelegationToolProvider());
toolProviderRegistry.register(new WebSearchToolProvider());
toolProviderRegistry.register(new CronToolProvider());
