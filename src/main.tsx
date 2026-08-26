/**
 * 渲染层入口：挂载 React 根组件，并根据运行环境在「桌面工作台」与「产品官网」之间切换。
 *
 * 所属层：渲染层入口（React root / 路由分流）。
 * 主要导出：无（副作用模块）；内部渲染 Root 组件，按需 lazy 加载 App（桌面端）或 MarketingSite（官网）。
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
