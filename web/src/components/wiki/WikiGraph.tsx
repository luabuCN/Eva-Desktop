import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NetworkIcon, RotateCcw, Search } from "lucide-react";
import type { WikiGraphData } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 类型配色（图例）：实体/概念/来源/查询。 */
const TYPE_COLORS: Record<string, string> = {
  entity: "#3b82f6",
  concept: "#8b5cf6",
  source: "#f59e0b",
  query: "#10b981",
};

/** 社区配色（label propagation 输出，超过 10 个社区循环取色）。 */
const COMMUNITY_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#06b6d4", "#a3a3a3",
];

interface SimNode {
  id: string;
  title: string;
  type: string;
  community: number;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  fixed: boolean;
}

interface SimEdge {
  source: SimNode;
  target: SimNode;
  kind: "link" | "source";
}

export interface WikiGraphProps {
  data: WikiGraphData;
  /** 点击节点 → 打开对应页面预览。 */
  onSelectNode: (id: string) => void;
}

/**
 * 知识图谱（canvas 力导向）：节点=页面，边=[[wikilink]] 与共同来源，
 * 社区检测着色可切换为类型着色。支持缩放/平移/拖拽/hover 高亮/搜索。
 */
export function WikiGraph({ data, onSelectNode }: WikiGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [colorMode, setColorMode] = useState<"type" | "community">("type");
  const [query, setQuery] = useState("");

  // 模拟状态放 ref：渲染循环每帧读写，不触发 React 重渲染。
  const simRef = useRef<{ nodes: SimNode[]; edges: SimEdge[]; alpha: number }>({
    nodes: [],
    edges: [],
    alpha: 0,
  });
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const pointerRef = useRef({
    down: false,
    dragged: false,
    panning: false,
    node: null as SimNode | null,
    lastX: 0,
    lastY: 0,
    hover: null as SimNode | null,
  });

  const neighborIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of data.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [data]);

  const colorOf = useCallback(
    (node: SimNode) =>
      colorMode === "community"
        ? COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]
        : TYPE_COLORS[node.type] ?? "#64748b",
    [colorMode],
  );

  const queryLower = query.trim().toLowerCase();
  const matchesQuery = useCallback(
    (node: SimNode) =>
      !queryLower || node.title.toLowerCase().includes(queryLower) || node.id.toLowerCase().includes(queryLower),
    [queryLower],
  );

  // 数据变化 → 重建节点（保留旧位置便于布局连续性），alpha 重置。
  useEffect(() => {
    const previous = new Map(simRef.current.nodes.map((node) => [node.id, node]));
    const maxDegree = Math.max(1, ...data.nodes.map((node) => node.degree));
    const nodes: SimNode[] = data.nodes.map((node, index) => {
      const old = previous.get(node.id);
      const angle = (index / Math.max(1, data.nodes.length)) * Math.PI * 2;
      return {
        ...node,
        x: old?.x ?? Math.cos(angle) * 180 + (Math.random() - 0.5) * 40,
        y: old?.y ?? Math.sin(angle) * 180 + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
        radius: 5 + (node.degree / maxDegree) * 8,
        fixed: false,
      };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges: SimEdge[] = data.edges
      .map((edge) => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        return source && target ? { source, target, kind: edge.kind } : null;
      })
      .filter((edge): edge is SimEdge => edge !== null);
    simRef.current = { nodes, edges, alpha: 1 };
  }, [data]);

  useEffect(() => {
    simRef.current.alpha = Math.max(simRef.current.alpha, 0.5);
  }, [colorMode]);

  const resetLayout = useCallback(() => {
    const { nodes } = simRef.current;
    nodes.forEach((node, index) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
      node.x = Math.cos(angle) * 180 + (Math.random() - 0.5) * 40;
      node.y = Math.sin(angle) * 180 + (Math.random() - 0.5) * 40;
      node.vx = 0;
      node.vy = 0;
      node.fixed = false;
    });
    simRef.current.alpha = 1;
    viewRef.current = { x: 0, y: 0, scale: 1 };
  }, []);

  // 主循环：力导向步进 + 绘制（devicePixelRatio 适配）。
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = container.clientWidth;
    let height = container.clientHeight;
    const applySize = () => {
      width = container.clientWidth;
      height = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(container);

    let frame = 0;
    const step = () => {
      const { nodes, edges } = simRef.current;
      const sim = simRef.current;
      if (sim.alpha > 0.01 && nodes.length > 0) {
        // 斥力（O(n²)，节点量级 < 1000 可接受）。
        for (let i = 0; i < nodes.length; i += 1) {
          for (let j = i + 1; j < nodes.length; j += 1) {
            const a = nodes[i];
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 1) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              distSq = 1;
            }
            const dist = Math.sqrt(distSq);
            const force = 2600 / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
        // 弹簧引力（边）。
        for (const edge of edges) {
          const dx = edge.target.x - edge.source.x;
          const dy = edge.target.y - edge.source.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const target = 90;
          const force = (dist - target) * 0.015;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          edge.source.vx += fx;
          edge.source.vy += fy;
          edge.target.vx -= fx;
          edge.target.vy -= fy;
        }
        // 向心引力 + 阻尼积分。
        const damping = 0.82;
        for (const node of nodes) {
          node.vx -= node.x * 0.0015;
          node.vy -= node.y * 0.0015;
          if (!node.fixed) {
            node.x += Math.max(-24, Math.min(24, node.vx)) * sim.alpha;
            node.y += Math.max(-24, Math.min(24, node.vy)) * sim.alpha;
          }
          node.vx *= damping;
          node.vy *= damping;
        }
        sim.alpha *= 0.994;
      }

      // ---- 绘制 ----
      const view = viewRef.current;
      const hover = pointerRef.current.hover;
      const hoverNeighbors = hover ? neighborIds.get(hover.id) : undefined;
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(width / 2 + view.x, height / 2 + view.y);
      context.scale(view.scale, view.scale);

      const nodeVisible = (node: SimNode) => {
        if (!queryLower) return true;
        if (matchesQuery(node)) return true;
        const neighbors = neighborIds.get(node.id);
        return !!neighbors && [...neighbors].some((id) => {
          const match = sim.nodes.find((candidate) => candidate.id === id);
          return match && matchesQuery(match);
        });
      };

      for (const edge of sim.edges) {
        const highlighted =
          (hover && (edge.source === hover || edge.target === hover)) ||
          (queryLower && nodeVisible(edge.source) && nodeVisible(edge.target) &&
            (matchesQuery(edge.source) || matchesQuery(edge.target)));
        context.strokeStyle = highlighted ? colorOf(edge.source) : "rgba(148,163,184,0.25)";
        context.lineWidth = highlighted ? 1.6 / view.scale : 1 / view.scale;
        if (edge.kind === "source" && !highlighted) {
          context.setLineDash([4 / view.scale, 3 / view.scale]);
        }
        context.beginPath();
        context.moveTo(edge.source.x, edge.source.y);
        context.lineTo(edge.target.x, edge.target.y);
        context.stroke();
        context.setLineDash([]);
      }

      context.font = "11px AlibabaPuHuiTi-3, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "top";
      for (const node of sim.nodes) {
        const visible = nodeVisible(node);
        const isHover = node === hover;
        const isNeighbor = !!hoverNeighbors?.has(node.id);
        const active = !queryLower || matchesQuery(node) || isHover;
        context.globalAlpha = !visible ? 0.08 : active ? 1 : 0.35;

        context.beginPath();
        context.arc(node.x, node.y, node.radius + (isHover ? 2 : 0), 0, Math.PI * 2);
        context.fillStyle = isNeighbor && !isHover ? colorOf(hover ?? node) : colorOf(node);
        context.fill();
        if (isHover || isNeighbor) {
          context.lineWidth = 2 / view.scale;
          context.strokeStyle = colorOf(node);
          context.stroke();
        }

        const showLabel =
          (view.scale >= 0.85 || isHover || isNeighbor || (queryLower && matchesQuery(node))) && visible;
        if (showLabel) {
          const label = node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title;
          context.globalAlpha = active ? 0.95 : 0.35;
          context.fillStyle = isHover ? "#0f172a" : "#475569";
          context.fillText(label, node.x, node.y + node.radius + 4);
        }
      }
      context.globalAlpha = 1;
      context.restore();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [colorOf, matchesQuery, neighborIds, queryLower]);

  // ---- 指针交互：拖节点/平移/hover；滚轮缩放 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const view = viewRef.current;
      return {
        x: (clientX - rect.left - rect.width / 2 - view.x) / view.scale,
        y: (clientY - rect.top - rect.height / 2 - view.y) / view.scale,
      };
    };
    const pick = (clientX: number, clientY: number): SimNode | null => {
      const { x, y } = toWorld(clientX, clientY);
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const node of simRef.current.nodes) {
        const dist = Math.hypot(node.x - x, node.y - y);
        if (dist < node.radius + 6 && dist < bestDist) {
          best = node;
          bestDist = dist;
        }
      }
      return best;
    };

    const onPointerDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      const pointer = pointerRef.current;
      pointer.down = true;
      pointer.dragged = false;
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      const node = pick(event.clientX, event.clientY);
      pointer.node = node;
      pointer.panning = !node;
      if (node) {
        node.fixed = true;
        simRef.current.alpha = Math.max(simRef.current.alpha, 0.35);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (pointer.down) {
        const dx = event.clientX - pointer.lastX;
        const dy = event.clientY - pointer.lastY;
        pointer.lastX = event.clientX;
        pointer.lastY = event.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 1) pointer.dragged = true;
        if (pointer.node) {
          const world = toWorld(event.clientX, event.clientY);
          pointer.node.x = world.x;
          pointer.node.y = world.y;
          pointer.node.vx = 0;
          pointer.node.vy = 0;
        } else if (pointer.panning) {
          viewRef.current.x += dx;
          viewRef.current.y += dy;
        }
        return;
      }
      pointer.hover = pick(event.clientX, event.clientY);
      canvas.style.cursor = pointer.hover ? "pointer" : "grab";
    };

    const onPointerUp = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (pointer.node) {
        // 单击（未拖动）→ 打开页面；拖动后释放但不永久固定。
        if (!pointer.dragged) onSelectNode(pointer.node.id);
        pointer.node.fixed = false;
      }
      pointer.down = false;
      pointer.panning = false;
      pointer.node = null;
      void event;
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = viewRef.current;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const factor = Math.exp(-event.deltaY * 0.0012);
      const nextScale = Math.min(4, Math.max(0.2, view.scale * factor));
      const applied = nextScale / view.scale;
      view.x = px - (px - view.x) * applied;
      view.y = py - (py - view.y) * applied;
      view.scale = nextScale;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [onSelectNode]);

  const legendItems =
    colorMode === "type"
      ? [
          { label: "实体", color: TYPE_COLORS.entity },
          { label: "概念", color: TYPE_COLORS.concept },
          { label: "来源", color: TYPE_COLORS.source },
          { label: "查询", color: TYPE_COLORS.query },
        ]
      : Array.from({ length: Math.min(data.communities, COMMUNITY_COLORS.length) }, (_, index) => ({
          label: `社区 ${index + 1}`,
          color: COMMUNITY_COLORS[index],
        }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏：搜索 / 着色切换 / 重置布局 / 统计 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点…"
            className="h-8 w-44 pl-7 text-xs"
          />
        </div>
        <div className="flex items-center rounded-md border p-0.5 text-xs">
          {(["type", "community"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setColorMode(mode)}
              className={cn(
                "rounded px-2 py-1 transition-colors",
                colorMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "type" ? "类型" : "社区"}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={resetLayout}>
          <RotateCcw className="size-3.5" />
          重置布局
        </Button>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <NetworkIcon className="size-3.5" />
            {data.stats.pages} 页面 · {data.stats.links} 链接 · {data.stats.isolated} 孤立
          </span>
        </div>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0 cursor-grab touch-none" />
        {data.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            暂无图谱数据：完成一轮对话总结后自动生成
          </div>
        ) : null}
        {/* 图例 */}
        <div className="absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg border bg-card/90 px-3 py-2 shadow-sm backdrop-blur">
          {legendItems.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
        <div className="absolute right-3 bottom-3 text-[10px] text-muted-foreground">
          滚轮缩放 · 拖拽平移 · 单击节点打开页面
        </div>
      </div>
    </div>
  );
}
