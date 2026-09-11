import { useCallback, useEffect, useState } from "react";
import { Loader2, Wrench } from "lucide-react";

import { listTools, type ToolCatalogInfo } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CommandRulesSection } from "./CommandRulesSection";

const RISK_LABEL = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
} as const;

export function ToolsSection() {
  const [tools, setTools] = useState<ToolCatalogInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    setLoading(true);
    listTools()
      .then(setTools)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "加载工具失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <div className="p-4 text-base font-semibold">工具</div>
      {error ? <p className="px-4 text-xs text-destructive">{error}</p> : null}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            加载中...
          </p>
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {tools.map((tool) => (
              <Item variant="outline" key={tool.name}>
                <ItemContent>
                  <ItemTitle>
                    <Wrench size={16} />
                    <span>{tool.label}</span>
                    <code className="text-xs text-muted-foreground">{tool.name}</code>
                    <Badge
                      variant={
                        tool.risk === "high"
                          ? "destructive"
                          : tool.risk === "medium"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {RISK_LABEL[tool.risk]}
                    </Badge>
                  </ItemTitle>
                  <p className="text-xs text-muted-foreground">{tool.description}</p>
                </ItemContent>
              </Item>
            ))}
          </div>
        )}
        <div className="px-4 pb-4 pt-2">
          <CommandRulesSection />
        </div>
      </ScrollArea>
    </div>
  );
}
