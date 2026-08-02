import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { api, isElectronRuntime } from "./lib/api";
import { MarketingSite } from "./MarketingSite";
import "./styles.css";
import "./marketing.css";

const DesktopApp = lazy(() => import("./App").then((module) => ({ default: module.App })));

document.documentElement.dataset.platform = api.system.platform;

function Root() {
  useEffect(() => {
    if (!isElectronRuntime && window.location.hash.startsWith("#/app")) {
      window.history.replaceState(null, "", "#/");
    }
  }, []);

  if (isElectronRuntime) return <DesktopApp />;
  return <MarketingSite />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="site-loading">正在打开会议助手…</div>}>
      <Root />
    </Suspense>
  </StrictMode>
);
