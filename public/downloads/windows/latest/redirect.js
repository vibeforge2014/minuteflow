/**
 * 官网「最新版 Windows 安装包」跳转页脚本（downloads/windows/latest/index.html 内联加载）：
 * 拉取同站 releases/latest-windows.json 更新清单，校验 assetUrl 只能是官网
 * zensoft.top/minuteflow/dl/ 下由 sync-release-assets 同步的安装包，或
 * github.com 本仓库 releases/download/ 的 HTTPS 兜底地址，然后自动跳转下载。
 * 与主进程 updates.mjs 共享「只信任官方发布地址」的安全模型。
 */
const statusElement = document.querySelector("#status");
const downloadElement = document.querySelector("#download");

/** 白名单校验：官网 dl/ 优先，GitHub 本仓库 release 资产作为兜底仍可信。 */
function trustedAssetUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "zensoft.top" && url.pathname.startsWith("/minuteflow/dl/")) return true;
    return url.hostname === "github.com"
      && url.pathname.startsWith("/vibeforge2014/minuteflow/releases/download/");
  } catch {
    return false;
  }
}

fetch("../../../releases/latest-windows.json", { headers: { Accept: "application/json" } })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((manifest) => {
    if (manifest?.schemaVersion !== 1 || manifest.platform !== "win32") {
      throw new Error("invalid Windows manifest");
    }
    if (!trustedAssetUrl(manifest.assetUrl) || !new URL(manifest.assetUrl).pathname.toLowerCase().endsWith(".exe")) {
      throw new Error("invalid Windows asset URL");
    }
    statusElement.textContent = `MinuteFlow ${manifest.version} 即将开始下载。`;
    downloadElement.textContent = "如果没有自动下载，请点这里";
    downloadElement.href = manifest.assetUrl;
    window.location.assign(manifest.assetUrl);
  })
  .catch(() => {
    statusElement.textContent = "暂时无法读取最新版本，请返回官网下载页后重试。";
  });
