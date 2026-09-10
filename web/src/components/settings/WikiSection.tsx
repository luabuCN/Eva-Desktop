import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BookOpen, Download, FolderOpen, Loader2, RefreshCw } from "lucide-react";

import {
  fetchWikiSettings,
  listProviders,
  listWikiScopes,
  resyncWikiStorage,
  updateWikiSettings,
  wikiExportUrl,
  type ProviderInfo,
  type WikiScopeInfo,
  type WikiSettings,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const EMBEDDING_OFF = "__off__";

/** 设置页的知识库分区：自动总结 / 默认知识库 / 文件存放路径 / 导出 Obsidian。
 * 知识库页只保留浏览与上传等操作，配置集中在这里。 */
export function WikiSection() {
  const [settings, setSettings] = useState<WikiSettings | null>(null);
  const [scopes, setScopes] = useState<WikiScopeInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string>();
  const [exportScope, setExportScope] = useState<string>();
  const [storageDraft, setStorageDraft] = useState("");
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string>();
  const [embeddingProvider, setEmbeddingProvider] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [embeddingNotice, setEmbeddingNotice] = useState<string>();

  useEffect(() => {
    void Promise.all([fetchWikiSettings(), listWikiScopes(), listProviders()])
      .then(([nextSettings, nextScopes, nextProviders]) => {
        setSettings(nextSettings);
        setScopes(nextScopes);
        setProviders(nextProviders);
        setStorageDraft(nextSettings.storagePath);
        setEmbeddingProvider(nextSettings.embeddingProviderId ?? "");
        setEmbeddingModel(nextSettings.embeddingModelId ?? "");
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

  useEffect(() => {
    if (!storageNotice && !embeddingNotice) return;
    const timer = window.setTimeout(() => {
      setStorageNotice(undefined);
      setEmbeddingNotice(undefined);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [storageNotice, embeddingNotice]);

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

  /** 浏览选择镜像目录（仅 Tauri 桌面端有系统文件夹对话框）。 */
  const pickStorageDir = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) setStorageDraft(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择文件夹失败");
    }
  }, []);

  /** 保存镜像目录：服务端校验可写并立即触发全量同步。 */
  const saveStoragePath = useCallback(
    async (input: { storagePath: string | null }) => {
      setStorageBusy(true);
      try {
        const next = await updateWikiSettings(input);
        setSettings(next);
        setStorageDraft(next.storagePath);
        setStorageNotice(`存放路径已更新为 ${next.storagePath}，正在同步全部页面`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "存放路径保存失败");
      } finally {
        setStorageBusy(false);
      }
    },
    [],
  );

  const runResync = useCallback(async () => {
    setStorageBusy(true);
    try {
      const result = await resyncWikiStorage();
      setStorageNotice(`已重新同步 ${result.synced} 个页面到 ${settings?.storagePath ?? ""}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新同步失败");
    } finally {
      setStorageBusy(false);
    }
  }, [settings?.storagePath]);

  /** 保存语义检索配置：供应商留空 = 关闭；保存后服务端自动入队重建索引。 */
  const saveEmbedding = useCallback(async () => {
    setEmbeddingBusy(true);
    try {
      const next = await updateWikiSettings({
        embeddingProviderId: embeddingProvider || null,
        embeddingModelId: embeddingProvider ? embeddingModel.trim() || null : null,
      });
      setSettings(next);
      setEmbeddingProvider(next.embeddingProviderId ?? "");
      setEmbeddingModel(next.embeddingModelId ?? "");
      setEmbeddingNotice(
        next.embeddingProviderId
          ? "语义检索已启用，正在后台重建全部知识库的向量索引"
          : "语义检索已关闭（回退纯关键词检索）",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语义检索配置保存失败");
    } finally {
      setEmbeddingBusy(false);
    }
  }, [embeddingModel, embeddingProvider]);

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
              description="对话回合完成后自动总结进知识库；项目可在其设置里单独覆盖此开关；关闭后仍可在对话里手动「存入知识库」"
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
            <h3 className="py-2 text-xs font-medium text-muted-foreground">检索</h3>
            <div className="py-3">
              <div className="text-sm font-medium">语义检索（embedding）</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                选择任一已配置供应商并填写其 embedding 模型 id（如 text-embedding-3-small，
                不要求出现在聊天模型列表）。启用后搜索为混合模式：关键词命中优先，
                语义相似补足召回（同义改写也能搜到）。留空则仅关键词检索。
                保存后自动在后台重建全部知识库的向量索引。
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <Select
                  value={embeddingProvider || EMBEDDING_OFF}
                  onValueChange={(next) => {
                    setEmbeddingProvider(next === EMBEDDING_OFF ? "" : next);
                  }}
                >
                  <SelectTrigger className="h-8 w-44 text-xs" aria-label="embedding 供应商">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMBEDDING_OFF}>关闭（仅关键词）</SelectItem>
                    {providers
                      .filter((provider) => provider.isActive)
                      .map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Input
                  value={embeddingModel}
                  onChange={(event) => setEmbeddingModel(event.target.value)}
                  placeholder="embedding 模型 id"
                  className="h-8 flex-1 text-xs"
                  spellCheck={false}
                  disabled={!embeddingProvider}
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={
                    embeddingBusy ||
                    !embeddingProvider ||
                    !embeddingModel.trim() ||
                    (embeddingProvider === (settings?.embeddingProviderId ?? "") &&
                      embeddingModel.trim() === (settings?.embeddingModelId ?? ""))
                  }
                  onClick={() => void saveEmbedding()}
                >
                  {embeddingBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  保存
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs">
                {settings?.embeddingProviderId && settings.embeddingModelId ? (
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                    disabled={embeddingBusy}
                    onClick={() => {
                      setEmbeddingProvider("");
                      setEmbeddingModel("");
                      void saveEmbedding();
                    }}
                  >
                    关闭语义检索
                  </button>
                ) : null}
                {embeddingNotice ? (
                  <span className="text-primary">{embeddingNotice}</span>
                ) : null}
              </div>
            </div>
          </section>
          <Separator className="my-2" />

          <section>
            <h3 className="py-2 text-xs font-medium text-muted-foreground">文件</h3>
            <div className="py-3">
              <div className="text-sm font-medium">wiki 文件存放路径</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                所有知识库页面实时写为 Markdown 文件（带 frontmatter，来源页含原文档全文，
                可直接用 Obsidian 打开）；每个知识库一个子文件夹。镜像只新增与覆盖文件，
                不会删除目录里的其他内容。
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <Input
                  value={storageDraft}
                  onChange={(event) => setStorageDraft(event.target.value)}
                  placeholder={settings?.storagePath ?? "选择或输入文件夹路径"}
                  className="h-8 text-xs"
                  spellCheck={false}
                />
                {isTauri() ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    disabled={storageBusy}
                    onClick={() => void pickStorageDir()}
                  >
                    <FolderOpen className="size-3.5" />
                    浏览
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={storageBusy || !storageDraft.trim() || storageDraft === settings?.storagePath}
                  onClick={() => void saveStoragePath({ storagePath: storageDraft.trim() })}
                >
                  {storageBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  保存
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs">
                <button
                  type="button"
                  className="flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                  disabled={storageBusy}
                  onClick={() => void runResync()}
                >
                  <RefreshCw className="size-3" />
                  立即重新同步
                </button>
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                  disabled={storageBusy}
                  onClick={() => void saveStoragePath({ storagePath: null })}
                >
                  恢复默认目录
                </button>
                {storageNotice ? (
                  <span className="text-primary">{storageNotice}</span>
                ) : null}
              </div>
            </div>
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
