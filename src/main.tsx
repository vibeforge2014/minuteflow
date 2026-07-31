import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isElectronRuntime } from "./lib/api";
import { MarketingSite } from "./MarketingSite";
import "./styles.css";
import "./marketing.css";

const DesktopApp = lazy(() => import("./App").then((module) => ({ default: module.App })));

function Root() {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (isElectronRuntime) return <DesktopApp />;
  if (hash === "#/app") {
    return (
      <div className="site-demo-wrapper">
        <a className="demo-exit" href="#/">返回产品官网</a>
        <DesktopApp />
      </div>
    );
  }
  return <MarketingSite />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="site-loading">正在打开会议助手…</div>}>
      <Root />
    </Suspense>
  </StrictMode>
);
