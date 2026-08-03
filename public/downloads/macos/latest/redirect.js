const statusElement = document.querySelector("#status");
const downloadElement = document.querySelector("#download");

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
