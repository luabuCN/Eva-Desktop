import { createTool } from "@mastra/core/tools";
import { mcpManager, type McpToolInfo } from "../mcp-manager.js";
import type { RunContext } from "./run-context.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RuntimeTool } from "./types.js";

/**
 * 把已连接 MCP 服务器的工具并入运行工具集（registry 预留的动态 Provider）。
 * listTools() 反映当前已连接缓存（工具目录页用）；createTools() 在装配运行时
 * 按项目可见性连接服务器并构造 mcp__<server>__<tool> 工具。MCP 工具风险未知，
 * 默认按「可用但需审批」处理，与 policies 的 UNKNOWN_TOOL_POLICY 一致。
 */

/** 把 MCP 的 JSON Schema 包成 StandardSchemaWithJSON：校验放行（服务器自会校验），
 * 只借 JSON Schema 让模型看到参数结构。 */
function jsonSchemaWrapper(schema: Record<string, unknown>) {
  return {
    "~standard": {
      version: 1,
      vendor: "openharness-mcp",
      validate: (value: unknown) => ({ value }),
      types: undefined,
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  } as never;
}

function descriptorFor(serverLabel: string, tool: McpToolInfo): ToolDescriptor {
  return {
    name: tool.fullName,
    label: `${serverLabel} · ${tool.toolName}`,
    description: tool.description,
    risk: "medium",
    mutating: true,
    defaultPolicy: { enabled: true, requireApproval: true },
    providerId: "mcp",
  };
}

export class McpToolProvider implements ToolProvider {
  readonly id = "mcp";
  readonly label = "MCP";

  listTools(): ToolDescriptor[] {
    return mcpManager.listRecords().flatMap((server) =>
      mcpManager
        .serverToolsOf(server.id)
        .map((tool) => descriptorFor(server.label, tool)),
    );
  }

  async createTools(run: RunContext): Promise<Record<string, RuntimeTool>> {
    const groups = await mcpManager.toolsForProject(run.projectId);
    const tools: Record<string, RuntimeTool> = {};
    for (const { server, tools: serverTools } of groups) {
      for (const tool of serverTools) {
        const fullName = tool.fullName;
        tools[fullName] = createTool({
          id: fullName,
          description: `[${server.label}] ${tool.description}`,
          inputSchema: jsonSchemaWrapper(tool.inputSchema),
          execute: async (args) => {
            try {
              return (await mcpManager.callTool(
                fullName,
                (args ?? {}) as Record<string, unknown>,
              )) as unknown;
            } catch (error) {
              return {
                error: `MCP 调用失败（${server.label}/${tool.toolName}）：${
                  error instanceof Error ? error.message : String(error)
                }`,
              };
            }
          },
        }) as RuntimeTool;
      }
    }
    return tools;
  }
}
