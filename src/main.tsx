import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { api, isElectronRuntime } from "./lib/api";
import { MarketingSite } from "./MarketingSite";
import "./styles.css";
import "./marketing.css";

const DesktopApp = lazy(() => import("./App").then((module) => ({ default: module.App })));

document.documentElement.dataset.platform = api.system.platform;

function Root() {
  const isLocalDesktopPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "desktop";

  useEffect(() => {
    if (!isElectronRuntime && !isLocalDesktopPreview && window.location.hash.startsWith("#/app")) {
      window.history.replaceState(null, "", "#/");
    }
  }, [isLocalDesktopPreview]);

  if (isElectronRuntime || isLocalDesktopPreview) return <DesktopApp />;
  return <MarketingSite />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="site-loading">正在打开MinuteFlow…</div>}>
      <Root />
    </Suspense>
  </StrictMode>
);
