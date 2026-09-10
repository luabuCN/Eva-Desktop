import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import FileViewer from "@file-viewer/react";
import officePreset from "@file-viewer/preset-office";
import { fetchWikiDocumentFile, type WikiDocumentInfo } from "@/api";
import { cn } from "@/lib/utils";

interface DocumentFilePreviewProps {
  scopeId: string;
  document: WikiDocumentInfo;
}

/** 跟随应用深浅色（<html class="dark">），切换时重挂预览器应用主题。 */
function useAppTheme(): "light" | "dark" {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark ? "dark" : "light";
}

/**
 * 原始资料原样预览：从服务端取回上传时的原始二进制文件，交给
 * @file-viewer（preset-office：PDF / Word / Excel / PowerPoint）浏览器端
 * 渲染——提取文本入库是为了总结与检索，预览始终看原件。
 */
export function DocumentFilePreview({ scopeId, document }: DocumentFilePreviewProps) {
  const theme = useAppTheme();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    fetchWikiDocumentFile(scopeId, document)
      .then((next) => {
        if (!cancelled) setFile(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "原始文件加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId, document]);

  // PPT 渲染器会无条件创建「▶开始放映」按钮（pptx-slideshow-button，无关闭
  // 选项），向其 Shadow DOM 注入样式隐藏——页面样式穿不透 shadow root。
  // 预览器初始化/渲染器加载中会替换宿主节点，Shadow root 可能晚于首次
  // 检查才出现：存活期间每秒自愈，样式缺失即补（一次 querySelector 的开销）。
  useEffect(() => {
    if (!file) return;
    const timer = window.setInterval(() => {
      const root = shellRef.current?.firstElementChild?.shadowRoot;
      if (!root || root.querySelector("style[data-fv-hide-slideshow]")) return;
      // 参数 document（原文档）遮蔽了全局 document，这里显式走 window。
      const style = window.document.createElement("style");
      style.setAttribute("data-fv-hide-slideshow", "");
      style.textContent = ".pptx-slideshow-button{display:none!important}";
      root.appendChild(style);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [file]);

  if (error) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-xs text-muted-foreground">
          可切换到「提取文本」查看，或重新上传该文档以恢复原件
        </p>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center gap-2 rounded-lg border">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">正在加载原始文件…</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      {/* 预览器默认撑满父容器：必须给明确高度 */}
      <div ref={shellRef} className={cn("h-[70vh] w-full", "bg-background")}>
        <FileViewer
          file={file}
          name={document.filename}
          options={{
            theme,
            locale: "zh-CN",
            preset: officePreset,
            rendererMode: "replace",
            // 工具栏只保留搜索/缩放/主题；下载/打印/HTML 导出/放映在知识库
            // 预览场景均不提供（下载原件仍可经文件路由 ?download=1 访问）。
            toolbar: {
              position: "bottom-right",
              download: false,
              print: false,
              exportHtml: false,
            },
          }}
        />
      </div>
    </div>
  );
}

export default DocumentFilePreview;
