import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import FileViewer from "@file-viewer/react";
import officePreset from "@file-viewer/preset-office";
import { useAppTheme } from "@/components/wiki/DocumentFilePreview";

interface OfficeFilePreviewProps {
  /** /preview 静态路由地址，按原始字节取回文件。 */
  url: string;
  /** 带扩展名的文件名（预览器按扩展名选择渲染链路）。 */
  filename: string;
}

/** 聊天文件链接的 office 预览：与知识库的 DocumentFilePreview 同一
 * @file-viewer（preset-office：PDF/Word/Excel/PowerPoint）渲染链路，
 * 以 url + 文件名为输入，挂在右侧浏览器面板的内容区，高度撑满面板。 */
export function OfficeFilePreview({ url, filename }: OfficeFilePreviewProps) {
  const theme = useAppTheme();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`文件加载失败（${response.status}）`);
        const bytes = await response.arrayBuffer();
        if (!cancelled) setFile(new File([bytes], filename));
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "文件加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, filename]);

  // PPT 渲染器会无条件创建「▶开始放映」按钮，向其 Shadow DOM 注入样式
  // 隐藏；预览器初始化会替换宿主节点，存活期间每秒自愈补样式。
  useEffect(() => {
    if (!file) return;
    const timer = window.setInterval(() => {
      const root = shellRef.current?.firstElementChild?.shadowRoot;
      if (!root || root.querySelector("style[data-fv-hide-slideshow]")) return;
      const style = window.document.createElement("style");
      style.setAttribute("data-fv-hide-slideshow", "");
      style.textContent = ".pptx-slideshow-button{display:none!important}";
      root.appendChild(style);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [file]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">正在加载文件…</p>
      </div>
    );
  }

  return (
    <div ref={shellRef} className="h-full w-full bg-background">
      <FileViewer
        file={file}
        name={filename}
        options={{
          theme,
          locale: "zh-CN",
          preset: officePreset,
          rendererMode: "replace",
          // 整条工具栏（搜索/翻页/缩放/主题切换）全部关闭，预览区保持纯净。
          toolbar: false,
        }}
      />
    </div>
  );
}

export default OfficeFilePreview;
