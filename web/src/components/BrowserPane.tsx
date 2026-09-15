import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OfficeFilePreview } from "@/components/OfficeFilePreview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 内置浏览器面板的一次导航目标。nonce 保证同一 URL 重复推送（如页面
 * 重新生成）时也会触发加载。 */
export interface PreviewTarget {
  url: string;
  kind?: "file" | "server";
  label?: string;
  nonce: number;
}

/** office 扩展名的 /preview 地址改用 file-viewer 渲染（iframe 显示不了
 * pptx/docx/xlsx，只能触发下载）。 */
const OFFICE_PREVIEW_EXTENSIONS = new Set(["pptx", "docx", "xlsx"]);

function officePreviewFilename(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith("/preview/")) return null;
  const lastSegment = pathname.split("/").at(-1) ?? "";
  if (!lastSegment) return null;
  let filename: string;
  try {
    filename = decodeURIComponent(lastSegment);
  } catch {
    return null;
  }
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return OFFICE_PREVIEW_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase())
    ? filename
    : null;
}

/** 地址栏输入归一化：裸主机默认补 http://，只允许 http/https。 */
function normalizeAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** 内置浏览器：地址栏 + 前进后退/刷新/外部打开 + iframe 内容区。
 * 导航历史只记录本面板发起的跳转（跨域 iframe 内部导航读不到 URL），
 * 面板隐藏期间由 TabsContent forceMount 保持状态与页面存活。 */
export function BrowserPane({ target }: { target: PreviewTarget | null }) {
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState<"file" | "server" | undefined>(target?.kind);
  const [invalidAddress, setInvalidAddress] = useState(false);
  /* cursor 的 ref 镜像：nonce effect 与地址栏提交共用压栈逻辑，
   * 避免 effect 闭包里读到过期下标。 */
  const cursorRef = useRef(-1);
  const lastPushedRef = useRef<string | null>(null);

  const applyCursor = (index: number) => {
    cursorRef.current = index;
    setCursor(index);
  };

  const push = (url: string) => {
    if (url === lastPushedRef.current) {
      setReloadKey((key) => key + 1);
      setLoading(true);
      return;
    }
    lastPushedRef.current = url;
    setHistory((stack) => [...stack.slice(0, cursorRef.current + 1), url]);
    applyCursor(cursorRef.current + 1);
    setLoading(true);
  };

  // 外部推送的新目标（自动打开或重新生成）压入历史栈顶
  useEffect(() => {
    if (!target) return;
    setKind(target.kind);
    push(target.url);
    // 仅在目标变化（nonce 递增）时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.nonce]);

  const currentUrl = cursor >= 0 ? history[cursor] : null;

  useEffect(() => {
    setAddress(currentUrl ? displayUrl(currentUrl) : "");
  }, [currentUrl]);

  const move = (delta: -1 | 1) => {
    const next = cursorRef.current + delta;
    if (next < 0 || next >= history.length) return;
    lastPushedRef.current = history[next];
    applyCursor(next);
    setLoading(true);
  };

  const reload = () => {
    if (!currentUrl) return;
    setReloadKey((key) => key + 1);
    setLoading(true);
  };

  const submitAddress = () => {
    const url = normalizeAddress(address);
    if (!url) {
      setInvalidAddress(true);
      return;
    }
    setInvalidAddress(false);
    push(url);
  };

  const openExternal = async () => {
    if (!currentUrl) return;
    try {
      if (isTauri()) {
        await openUrl(currentUrl);
        return;
      }
    } catch {
      // 打开器不可用时退回 window.open
    }
    window.open(currentUrl, "_blank", "noopener");
  };

  // 加载超时兜底：部分页面不触发 iframe load（如网络不可达时浏览器直接
  // 渲染错误页），10 秒后自动撤掉加载态，避免一直转圈。
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setLoading(false), 10_000);
    return () => clearTimeout(timer);
  }, [loading, reloadKey, currentUrl]);

  // office 文件的预览地址改走 file-viewer（见 officePreviewFilename）。
  const officeFilename = currentUrl ? officePreviewFilename(currentUrl) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => move(-1)}
          disabled={cursor <= 0}
          title="后退"
          aria-label="后退"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => move(1)}
          disabled={cursor >= history.length - 1}
          title="前进"
          aria-label="前进"
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={reload}
          disabled={!currentUrl}
          title="刷新"
          aria-label="刷新"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
        <div className="relative flex min-w-0 flex-1 items-center">
          <GlobeIcon className="pointer-events-none absolute left-2 size-3 text-muted-foreground" />
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalidAddress(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitAddress();
            }}
            placeholder="输入地址，或等待生成的页面自动打开"
            spellCheck={false}
            className={cn(
              "h-7 w-full rounded-md border bg-muted/40 pl-7 pr-2 text-xs outline-none",
              "placeholder:text-muted-foreground/70 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20",
              invalidAddress && "border-destructive/60",
            )}
          />
          {loading ? (
            <LoaderCircleIcon className="absolute right-2 size-3 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void openExternal()}
          disabled={!currentUrl}
          title="在系统浏览器中打开"
          aria-label="在系统浏览器中打开"
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      {currentUrl ? (
        <div className="relative min-h-0 flex-1">
          {officeFilename ? (
            // office 文件：iframe 只会触发下载，改用 file-viewer 预览（与
            // 知识库“原文件预览”同一渲染链路）。absolute inset-0 给预览器
            // 一个尺寸确定的宿主（file-viewer 要求明确高度），key 跟随
            // reloadKey，点刷新时重新拉取字节。
            <div className="absolute inset-0">
              <OfficeFilePreview key={reloadKey} url={currentUrl} filename={officeFilename} />
            </div>
          ) : (
            <>
              {loading ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
                  <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : null}
              <iframe
                key={reloadKey}
                src={currentUrl}
                title="页面预览"
                className="h-full w-full border-0 bg-white"
                onLoad={() => setLoading(false)}
              />
            </>
          )}
          {/* office 预览不再显示“文件预览”角标，保持预览区干净 */}
          {kind && !officeFilename ? (
            <div className="pointer-events-none absolute right-2 bottom-2 rounded-md bg-background/85 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
              {kind === "server" ? "开发服务器" : "文件预览"}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <GlobeIcon className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">内置浏览器</p>
          <p className="max-w-56 text-xs text-muted-foreground/70">
            生成的 HTML 页面或启动的开发服务器会自动在这里打开，也可以在上方输入地址访问
            localhost 服务。
          </p>
        </div>
      )}
    </div>
  );
}
