/** 图片下载结果：saved 已保存（或已交给浏览器下载流程），cancelled
 *  用户在系统「另存为」里主动取消——调用方据此决定是否显示完成反馈。 */
export type ImageDownloadResult = "saved" | "cancelled";

/** 图片下载统一入口。
 *  Tauri 桌面端：Rust 命令弹系统「另存为」对话框（默认定位系统下载目录、
 *  预填文件名），用户选好位置后由 Rust 侧写文件；取消则原样返回。
 *  浏览器端：blob URL 与页面同源，a[download] 交给浏览器下载流程
 *  （是否弹保存位置由浏览器自身设置决定）。 */
export async function downloadImage(
  src: string,
  filename: string,
): Promise<ImageDownloadResult> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const saved = await invoke<boolean>("save_image_with_dialog", {
        bytes,
        fileName: filename,
      });
      return saved ? "saved" : "cancelled";
    } catch {
      // 旧版桌面端（Rust 侧没有该命令）回退 blob 下载，避免“点了没反应”。
    }
  }

  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return "saved";
}
