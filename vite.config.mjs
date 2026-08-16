/**
 * Vite 配置（渲染层构建）：
 * - base "./"：相对路径产物，兼容 GitHub Pages 子路径与 Electron file:// 加载。
 * - outDir dist/client：配合 scripts/prepare-sites-build.mjs 组装 Sites 交付物。
 * - dev server 允许 terminal.local 主机名（局域网预览），Electron 开发模式依赖此服务。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
