import { wikiService } from "./wiki-service.js";
import { extractWikiLinks } from "./wiki-service.js";
import type { WikiGraphData } from "./wiki-types.js";

/**
 * 知识图谱构建（llm-wiki 的图谱思路）：
 * - 节点 = 页面（index/log/overview 系统页不参与，避免全连通的星型中心）
 * - 边   = [[wikilink]] 引用（link） + 共同来源页面（source：A 与 B 都被
 *           同一 source/query 页引用时连边，对应 llm_wiki 的 source-overlap 信号）
 * - 社区 = label propagation（异步更新，按度降序遍历），同社区同色
 */
export async function buildWikiGraph(scopeId: string): Promise<WikiGraphData> {
  const pages = await wikiService.allPages(scopeId);
  const contentPages = pages.filter(
    (page) => !["index", "log", "overview"].includes(page.type),
  );

  // 标题/路径基名 → 节点 id 的映射（wikilink 支持标题与路径两种写法）。
  const byTitle = new Map<string, string>();
  const byBaseName = new Map<string, string>();
  const nodeIds = new Set<string>();
  for (const page of contentPages) {
    nodeIds.add(page.path);
    byTitle.set(page.title.toLowerCase(), page.path);
    byBaseName.set(page.path.split("/").pop()!.replace(/\.md$/i, "").toLowerCase(), page.path);
  }
  const resolveTarget = (raw: string): string | undefined => {
    const key = raw.trim().toLowerCase().replace(/\.md$/i, "");
    if (nodeIds.has(raw)) return raw;
    return byTitle.get(key) ?? byBaseName.get(key.includes("/") ? key.split("/").pop()! : key);
  };

  const edgeSet = new Map<string, { source: string; target: string; kind: "link" | "source" }>();
  const addEdge = (source: string, target: string, kind: "link" | "source") => {
    if (source === target) return;
    const key = `${source}\u0000${target}`;
    const reverse = `${target}\u0000${source}`;
    if (!edgeSet.has(key) && !edgeSet.has(reverse)) edgeSet.set(key, { source, target, kind });
  };

  // wikilink 边 + 记录每个 source/query 页引用的内容页（用于共同来源边）。
  const referenceLists: string[][] = [];
  for (const page of contentPages) {
    const links = extractWikiLinks(page.content);
    const resolved: string[] = [];
    for (const link of links) {
      const target = resolveTarget(link);
      if (!target) continue;
      addEdge(page.path, target, page.type === "source" || page.type === "query" ? "source" : "link");
      resolved.push(target);
    }
    if (page.type === "source" || page.type === "query") referenceLists.push(resolved);
  }
  // 共同来源：同一 source/query 页引用的两两内容页之间连弱边。
  for (const references of referenceLists) {
    for (let i = 0; i < references.length; i += 1) {
      for (let j = i + 1; j < references.length; j += 1) {
        addEdge(references[i], references[j], "source");
      }
    }
  }

  const edges = [...edgeSet.values()];
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push(edge.target);
    adjacency.get(edge.target)!.push(edge.source);
  }
  const communities = labelPropagation([...nodeIds], adjacency);

  return {
    nodes: contentPages.map((page) => ({
      id: page.path,
      title: page.title,
      type: page.type as WikiGraphData["nodes"][number]["type"],
      community: communities.get(page.path) ?? 0,
      degree: degree.get(page.path) ?? 0,
    })),
    edges,
    communities: Math.max(1, new Set(communities.values()).size),
    stats: {
      pages: contentPages.length,
      links: edges.length,
      isolated: contentPages.filter((page) => !adjacency.has(page.path)).length,
    },
  };
}

/** Label propagation：按度降序遍历，每轮取邻居中最频繁的社区标签。 */
function labelPropagation(nodes: string[], adjacency: Map<string, string[]>): Map<string, number> {
  const labels = new Map<string, number>();
  nodes.forEach((node, index) => labels.set(node, index));
  const ordered = [...nodes].sort(
    (a, b) => (adjacency.get(b)?.length ?? 0) - (adjacency.get(a)?.length ?? 0),
  );

  for (let round = 0; round < 24; round += 1) {
    let changed = false;
    for (const node of ordered) {
      const neighbors = adjacency.get(node);
      if (!neighbors?.length) continue;
      const counts = new Map<number, number>();
      for (const neighbor of neighbors) {
        const label = labels.get(neighbor);
        if (label === undefined) continue;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      let bestLabel = labels.get(node)!;
      let bestCount = -1;
      for (const [label, count] of counts) {
        // 平票时取编号小的（含自身标签优先），保证收敛稳定。
        if (count > bestCount || (count === bestCount && label < bestLabel)) {
          bestLabel = label;
          bestCount = count;
        }
      }
      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 压缩标签为 0..k-1（按社区规模降序编号，0 号社区最大）。
  const sizes = new Map<number, number>();
  for (const label of labels.values()) sizes.set(label, (sizes.get(label) ?? 0) + 1);
  const rank = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  const remap = new Map(rank.map((label, index) => [label, index]));
  const result = new Map<string, number>();
  for (const [node, label] of labels) result.set(node, remap.get(label) ?? 0);
  return result;
}
