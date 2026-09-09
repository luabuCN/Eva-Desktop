import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  DEFAULT_WIKI_SCOPE,
  projectScopeId,
  wikiService,
} from "../../wiki/wiki-service.js";
import type { RunContext } from "./run-context.js";
import type { ToolDescriptor, ToolProvider } from "./registry.js";
import type { RuntimeTool } from "./types.js";

/** 知识库工具：对话「读」知识库的唯一入口。wikiSearch 检索当前项目与默认
 * 知识库，wikiRead 读取页面全文（来源页带原文档）。结果统一带 wiki:// 链接，
 * 模型按提示词以 markdown 链接引用，前端点击跳转知识库对应页面。 */

const MAX_SEARCH_RESULTS_PER_SCOPE = 8;
const READ_CONTENT_LIMIT = 30_000;

/** 知识库跳转链接：/wiki/<scopeId>/<path> 形式（逐段 encodeURIComponent）。
 * 必须以 "/" 开头：前端 Streamdown 管道里的 rehype-harden 只放行绝对/相对
 * 路径形式的 URL（"/"、"./"、"../" 前缀），"wiki://" 协议与裸 "wiki/" 前缀
 * 都会被按未知协议拦截。 */
export function encodeWikiLink(scopeId: string, path: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/wiki/${encodeURIComponent(scopeId)}/${encodedPath}`;
}

const WIKISEARCH_DESCRIPTION = `Search the user's personal knowledge base (wiki), which is built automatically from past conversations and uploaded project documents (API specs, requirement docs, notes).

- Use it FIRST for any question about the user's own projects, past decisions, uploaded documents, or previously discussed topics — before answering from general knowledge or searching the web.
- Keywords work in Chinese or English; the match is substring-based, so prefer short distinctive terms.
- Each result has title, type (entity/concept/source/query), snippet, and a link.
- When a snippet is not enough, call wikiRead with that result's path (and scope) for the full content.
- When your answer uses knowledge base content, cite the pages as markdown links using their link field (e.g. [页面标题](wiki/...)) so the user can click to open the wiki page.`;

const WIKIREAD_DESCRIPTION = `Read one knowledge base page in full by its path (taken from a wikiSearch result).

- Source pages (type=source) return the original uploaded document text plus its summary; entity/concept/query pages return the distilled wiki page.
- Very long content is truncated; the truncated flag is set when that happens.
- Cite this page in your answer as a markdown link using the returned link field.`;

export class WikiToolProvider implements ToolProvider {
  readonly id = "wiki";
  readonly label = "知识库工具";

  listTools(): ToolDescriptor[] {
    return [
      {
        name: "wikiSearch",
        label: "Wiki search",
        description: "Search the user's knowledge base (past conversations + uploaded documents).",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
      {
        name: "wikiRead",
        label: "Wiki read",
        description: "Read one knowledge base page in full by path.",
        risk: "low",
        mutating: false,
        defaultPolicy: { enabled: true, requireApproval: false },
        providerId: this.id,
      },
    ];
  }

  createTools(run: RunContext): Record<string, RuntimeTool> {
    // 检索范围：当前对话的项目知识库（若有）+ 默认知识库，按序去重。
    const scopes = [
      ...(run.projectId ? [projectScopeId(run.projectId)] : []),
      DEFAULT_WIKI_SCOPE,
    ].filter((scopeId, index, all) => all.indexOf(scopeId) === index);

    const wikiSearch: RuntimeTool = createTool({
      id: "wikiSearch",
      description: WIKISEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().min(1).describe("Search keywords (Chinese or English)"),
      }),
      execute: async ({ query }) => {
        try {
          const results: Array<{
            title: string;
            path: string;
            type: string;
            scope: string;
            snippet: string;
            link: string;
          }> = [];
          for (const scopeId of scopes) {
            // 项目可能已被归档/删除：该 scope 跳过而不是让整个工具失败。
            try {
              const hits = await wikiService.search(scopeId, query, MAX_SEARCH_RESULTS_PER_SCOPE);
              for (const hit of hits) {
                results.push({
                  title: hit.title,
                  path: hit.path,
                  type: hit.type,
                  scope: scopeId,
                  snippet: hit.snippet,
                  link: encodeWikiLink(scopeId, hit.path),
                });
              }
            } catch {
              continue;
            }
          }
          if (results.length === 0) {
            return { query, results, note: "知识库中没有匹配内容" };
          }
          return { query, results };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    });

    const wikiRead: RuntimeTool = createTool({
      id: "wikiRead",
      description: WIKIREAD_DESCRIPTION,
      inputSchema: z.object({
        path: z.string().min(1).describe("Page path from a wikiSearch result, e.g. sources/api-doc.md"),
        scope: z.string().optional().describe("Scope id from the search result; omit to use the current default"),
      }),
      execute: async ({ path, scope }) => {
        try {
          const scopeId = scope ?? scopes[0];
          const page = await wikiService.page(scopeId, path);
          // 来源页优先给原文档全文；其余页面给 wiki 正文。
          const full = page.document?.text ?? page.content;
          const truncated = full.length > READ_CONTENT_LIMIT;
          return {
            title: page.title,
            path: page.path,
            scope: scopeId,
            type: page.type,
            summary: page.meta.summary ?? undefined,
            isOriginalDocument: Boolean(page.document),
            truncated,
            content: truncated
              ? `${full.slice(0, READ_CONTENT_LIMIT)}\n\n[内容过长已截断]`
              : full,
            link: encodeWikiLink(scopeId, page.path),
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    });

    return { wikiSearch, wikiRead };
  }
}
