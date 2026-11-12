/**
 * 官网渲染层入口（index.html）：静态渲染产品官网，桌面工作台按需 lazy 加载。
 *
 * 所属层：渲染层入口（React root / 路由分流）。
 * 打包后的桌面应用走独立入口 desktop.html / desktop-main.tsx，不加载本模块，
 * 因此官网的 MarketingSite 与 marketing.css 不会进入桌面运行时。
 * 本入口保留 isElectronRuntime 与 ?preview=desktop 分支，供 Vite dev server
 * 与浏览器本地预览工作台使用（开发期才需要，不进桌面生产包）。
 */
import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { api, isElectronRuntime } from "./lib/api";
import { MarketingSite } from "./MarketingSite";
import { PermissionDragHelper } from "./components/PermissionDragHelper";
import "./styles.css";
import "./marketing.css";

// 桌面工作台体量较大，用 React.lazy 拆成独立 chunk，首屏（官网）不加载它。
const DesktopApp = lazy(() => import("./App").then((module) => ({ default: module.App })));

// 把平台标识写到 <html data-platform> 上，供 CSS 按平台做差异化样式（如 macOS 红绿灯留白）。
document.documentElement.dataset.platform = api.system.platform;
const requestedSurface = new URLSearchParams(window.location.search).get("surface");
if (requestedSurface) document.documentElement.dataset.surface = requestedSurface;

function Root() {
  if (requestedSurface === "permission-helper") {
    return <PermissionDragHelper />;
  }
  // 本地浏览器开发预览桌面 UI 的开关：DEV 模式且 URL 带 ?preview=desktop 时也渲染桌面工作台。
  const isLocalDesktopPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "desktop";

  useEffect(() => {
    // 纯浏览器访问 #/app 深链时没有桌面能力，重定向回官网首页，避免渲染一个不可用的空壳。
    if (!isElectronRuntime && !isLocalDesktopPreview && window.location.hash.startsWith("#/app")) {
      window.history.replaceState(null, "", "#/");
    }
  }, [isLocalDesktopPreview]);

  if (isElectronRuntime || isLocalDesktopPreview) return <DesktopApp />;
  return <MarketingSite />;
}

// Vite 热更新可能重新执行入口模块；复用既有 root，避免重复 createRoot 的 React 错误。
const rootWindow = window as typeof window & { __MINUTEFLOW_REACT_ROOT__?: ReactRoot };
const reactRoot = rootWindow.__MINUTEFLOW_REACT_ROOT__
  ?? (rootWindow.__MINUTEFLOW_REACT_ROOT__ = createRoot(document.getElementById("root")!));

reactRoot.render(
  <StrictMode>
    <Suspense fallback={<div className="site-loading">正在打开MinuteFlow…</div>}>
      <Root />
    </Suspense>
  </StrictMode>
);
