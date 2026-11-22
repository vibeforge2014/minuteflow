/**
 * 桌面工作台专用渲染层入口（desktop.html）。
 *
 * 与官网入口 main.tsx 物理隔离：这里只引入 App 与工作台样式 styles.css，
 * 不引入 MarketingSite / marketing.css / qrcode 等官网依赖。Vite 多入口构建
 * 会把两者各自专属的代码留在各自的 chunk，Forge 打包时再剔除官网产物，
 * 桌面启动因此无需下载、解析约 1.5MB 官网 JS 与 199KB 官网 CSS。
 *
 * permission helper 小窗口同样加载本入口，通过 ?surface=permission-helper 只渲染拖拽引导。
 */
import { StrictMode } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { api } from "./lib/api";
import { App } from "./App";
import { PermissionDragHelper } from "./components/PermissionDragHelper";
import "./styles.css";

document.documentElement.dataset.platform = api.system.platform;
const requestedSurface = new URLSearchParams(window.location.search).get("surface");
if (requestedSurface) document.documentElement.dataset.surface = requestedSurface;

function Root() {
  if (requestedSurface === "permission-helper") return <PermissionDragHelper />;
  return <App />;
}

// Vite 热更新可能重新执行入口模块；复用既有 root，避免重复 createRoot 的 React 错误。
const rootWindow = window as typeof window & { __MINUTEFLOW_REACT_ROOT__?: ReactRoot };
const reactRoot = rootWindow.__MINUTEFLOW_REACT_ROOT__
  ?? (rootWindow.__MINUTEFLOW_REACT_ROOT__ = createRoot(document.getElementById("root")!));

reactRoot.render(
  <StrictMode>
    <Root />
  </StrictMode>
);
