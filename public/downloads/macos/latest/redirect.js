/**
 * 官网「最新版 DMG」跳转页脚本（downloads/macos/latest/index.html 内联加载）：
 * 拉取同站 releases/latest-macos.json 更新清单，校验 assetUrl 只能是
 * github.com 上本仓库 releases/download/ 的 HTTPS 地址，然后自动跳转下载。
 * 与主进程 updates.mjs 共享「只信任官方发布地址」的安全模型。
 */
const statusElement = document.querySelector("#status");
const downloadElement = document.querySelector("#download");

/** 白名单校验：仅接受 github.com 本仓库 release 资产的 HTTPS 链接。 */
function trustedAssetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.pathname.startsWith("/vibeforge2014/minuteflow/releases/download/");
  } catch {
    return false;
  }
}

fetch("../../../releases/latest-macos.json", { headers: { Accept: "application/json" } })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((manifest) => {
    if (!trustedAssetUrl(manifest.assetUrl)) throw new Error("invalid asset URL");
    statusElement.textContent = `MinuteFlow ${manifest.version} 即将开始下载。`;
    downloadElement.textContent = "如果没有自动下载，请点这里";
    downloadElement.href = manifest.assetUrl;
    window.location.assign(manifest.assetUrl);
  })
  .catch(() => {
    statusElement.textContent = "暂时无法读取最新版本，请返回官网下载页后重试。";
  });
