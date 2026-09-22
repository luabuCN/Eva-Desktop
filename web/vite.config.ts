import { fileURLToPath, URL } from "node:url";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

export default defineConfig({
  // pnpm may resolve a second vite copy for @tailwindcss/vite's peer dep;
  // the plugin is runtime-compatible, silence the duplicate-package typing.
  plugins: [
    react(),
    tailwindcss() as unknown as PluginOption,
    // 知识库原文件预览（@file-viewer）：复制 Worker / WASM / vendor 资产
    // 满足桌面离线运行；renderers 由预览组件显式传 options.preset，
    // 关闭 HTML 注入避免启动时预载全部渲染器 chunk（保持按需加载）。
    fileViewerRenderers({ copyAssets: true, inject: false }),
  ],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // @file-viewer 复制的部分 vendor 资产（LICENSE/NOTICE）没有扩展名，
        // 默认模板 assets/[name]-[hash][extname] 会生成以 "." 结尾的文件名，
        // 在 Windows 上非法，Tauri 编译期嵌入资源时读取失败；补上 .txt。
        assetFileNames: (assetInfo) => {
          const raw = assetInfo.names?.[0] ?? (assetInfo as { name?: string }).name ?? "asset";
          const dot = raw.lastIndexOf(".");
          const base = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^\w.-]+/g, "_");
          const ext = dot > 0 ? raw.slice(dot) : ".txt";
          return `assets/${base}-[hash]${ext}`;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 8089,
    strictPort: true,
  },
});
