import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CheckIcon, DownloadIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { downloadImage } from "@/lib/download-image";

interface ImageLightboxProps {
  src: string;
  filename?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 全屏图片预览（参考 PI-Desktop）：点遮罩或 ESC 关闭，图片本体不触发关闭。 */
export function ImageLightbox({ src, filename, open, onOpenChange }: ImageLightboxProps) {
  // 保存按钮反馈：busy 转圈防重复点击，done 短暂显示对勾。
  const [saving, setSaving] = useState<"idle" | "busy" | "done">("idle");

  const handleSave = () => {
    if (saving !== "idle") return;
    setSaving("busy");
    void downloadImage(src, filename ?? "image.png")
      .then((result) => {
        // 「另存为」里取消：静默复位，不显示完成反馈。
        if (result === "cancelled") {
          setSaving("idle");
          return;
        }
        setSaving("done");
        setTimeout(() => setSaving("idle"), 2000);
      })
      .catch(() => setSaving("idle"));
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/80 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 grid place-items-center p-6 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
          onClick={() => onOpenChange(false)}
        >
          <DialogPrimitive.Title className="sr-only">
            {filename ?? "图片预览"}
          </DialogPrimitive.Title>
          <figure className="relative" onClick={(event) => event.stopPropagation()}>
            <img
              src={src}
              alt={filename ?? "图片预览"}
              className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            />
            <div className="absolute -top-3 right-0 flex translate-y-[-100%] items-center gap-1">
              <button
                type="button"
                title="保存图片"
                aria-label="保存图片"
                onClick={handleSave}
                className="flex size-8 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
              >
                {saving === "done" ? (
                  <CheckIcon className="size-4 text-green-400" />
                ) : saving === "busy" ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <DownloadIcon className="size-4" />
                )}
              </button>
              <button
                type="button"
                aria-label="关闭预览"
                title="关闭预览"
                className="flex size-8 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
                onClick={() => onOpenChange(false)}
              >
                <XIcon className="size-4" />
              </button>
            </div>
            {filename ? (
              <figcaption className="absolute inset-x-0 -bottom-3 translate-y-[100%] truncate text-center text-xs text-white/70">
                {filename}
              </figcaption>
            ) : null}
          </figure>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
