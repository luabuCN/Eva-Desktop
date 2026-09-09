import { useCallback, useEffect, useState } from "react";
import { BookOpen, Download } from "lucide-react";

import {
  fetchWikiSettings,
  listWikiScopes,
  updateWikiSettings,
  wikiExportUrl,
  type WikiScopeInfo,
  type WikiSettings,
} from "@/api";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 设置页的知识库分区：自动总结 / 默认知识库 / 导出 Obsidian。
 * 知识库页只保留浏览与上传等操作，配置集中在这里。 */
export function WikiSection() {
  const [settings, setSettings] = useState<WikiSettings | null>(null);
  const [scopes, setScopes] = useState<WikiScopeInfo[]>([]);
  const [error, setError] = useState<string>();
  const [exportScope, setExportScope] = useState<string>();

  useEffect(() => {
    void Promise.all([fetchWikiSettings(), listWikiScopes()])
      .then(([nextSettings, nextScopes]) => {
        setSettings(nextSettings);
        setScopes(nextScopes);
        setExportScope(
          nextScopes.some((scope) => scope.id === nextSettings.defaultScope)
            ? nextSettings.defaultScope
            : nextScopes[0]?.id,
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "知识库设置加载失败"),
      );
  }, []);

  const scopeLabel = (scope: WikiScopeInfo) =>
    `${scope.kind === "project" ? "项目 · " : ""}${scope.label}`;

  const toggleAutoIngest = useCallback(
    (enabled: boolean) => {
      if (!settings) return;
      const previous = settings;
      setSettings({ ...settings, autoIngest: enabled });
      void updateWikiSettings({ autoIngest: enabled }).catch((cause: unknown) => {
        setSettings(previous);
        setError(cause instanceof Error ? cause.message : "设置保存失败");
      });
    },
    [settings],
  );

  const changeDefaultScope = useCallback(
    (scopeId: string) => {
      if (!settings) return;
      const previous = settings;
      setSettings({ ...settings, defaultScope: scopeId });
      void updateWikiSettings({ defaultScope: scopeId }).catch((cause: unknown) => {
        setSettings(previous);
        setError(cause instanceof Error ? cause.message : "默认知识库设置失败");
      });
    },
    [settings],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6 pb-2">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <BookOpen className="size-5 text-muted-foreground" />
          知识库
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          对话与文档自动沉淀为可长期演进的知识库（默认空间与项目知识库相互独立）。
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 pb-8">
          {error ? (
            <p className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => setError(undefined)}
              >
                关闭
              </button>
            </p>
          ) : null}

          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">总结</h3>
            <SettingRow
              label="对话自动总结"
              description="对话回合完成后自动总结进知识库；关闭后仍可在对话里手动「存入知识库」"
            >
              <Switch
                checked={settings?.autoIngest ?? false}
                disabled={!settings}
                onCheckedChange={toggleAutoIngest}
              />
            </SettingRow>
          </section>
          <Separator className="my-2" />

          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">空间</h3>
            <SettingRow
              label="默认知识库"
              description="打开知识库页面时默认展示的空间（默认空间或项目知识库）；项目对话始终沉淀到对应项目知识库"
            >
              <Select
                value={settings?.defaultScope}
                onValueChange={changeDefaultScope}
                disabled={!settings}
              >
                <SelectTrigger className="w-56" aria-label="默认知识库">
                  <SelectValue placeholder="选择默认知识库" />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((scope) => (
                    <SelectItem key={scope.id} value={scope.id}>
                      {scopeLabel(scope)}（{scope.pageCount}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </section>
          <Separator className="my-2" />

          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">导出</h3>
            <SettingRow
              label="导出 Obsidian"
              description="导出为 Obsidian 兼容 vault（zip）：来源页包含原文档全文，摘要保留在 frontmatter"
            >
              <div className="flex items-center gap-2">
                <Select value={exportScope} onValueChange={setExportScope}>
                  <SelectTrigger className="w-56" aria-label="导出的知识库">
                    <SelectValue placeholder="选择要导出的知识库" />
                  </SelectTrigger>
                  <SelectContent>
                    {scopes.map((scope) => (
                      <SelectItem key={scope.id} value={scope.id}>
                        {scopeLabel(scope)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <a href={exportScope ? wikiExportUrl(exportScope) : undefined} download>
                  <Button variant="outline" disabled={!exportScope}>
                    <Download className="size-4" />
                    导出
                  </Button>
                </a>
              </div>
            </SettingRow>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
