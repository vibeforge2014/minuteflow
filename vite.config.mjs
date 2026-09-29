/**
 * Vite 配置（渲染层构建）：
 * - base 默认 "./"：相对路径产物，兼容 Electron file:// 加载；部署官网时用
 *   SITE_BASE_PATH=/minuteflow 构建出绝对子路径资源（深层路由如 /pricing/ 需要）。
 * - outDir dist/client：配合 scripts/prepare-sites-build.mjs 组装 Sites 交付物。
 * - dev server 允许 terminal.local 主机名（局域网预览），Electron 开发模式依赖此服务。
 * - watch.ignored：根目录内的发布产物（.build 3GB+）、iOS 构建等不属于渲染层源码，
 *   排除后避免 dev server 监听上万无关文件导致句柄与内存膨胀（曾触发 Vite OOM）。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const siteBasePath = process.env.SITE_BASE_PATH?.replace(/\/$/, "");

export default defineConfig({
  base: siteBasePath ? `${siteBasePath}/` : "./",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    watch: {
      ignored: ["**/.build/**", "**/artifacts/**", "**/release/**", "**/out/**", "**/dist/**", "**/ios/**"],
    },
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
});
