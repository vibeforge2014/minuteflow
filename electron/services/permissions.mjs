/**
 * Electron 媒体权限来源校验。
 *
 * 打包后的渲染器从 file:// 加载，Chromium 在部分版本会把媒体权限检查的
 * requestingOrigin 报成不透明的 "null"。因此不能只检查 origin：优先使用
 * requestingUrl，缺失时才回退到受信任主窗口 URL；子框架始终拒绝。
 */

export function isTrustedRendererUrl(url, developmentServerUrl = "") {
  if (typeof url !== "string" || !url || url === "null") return false;
  if (developmentServerUrl) {
    try {
      return new URL(url).origin === new URL(developmentServerUrl).origin;
    } catch {
      return false;
    }
  }
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

export function isTrustedPermissionRequest({
  webContentsUrl = "",
  requestingOrigin = "",
  securityOrigin = "",
  requestingUrl = "",
  isMainFrame = false,
  developmentServerUrl = ""
} = {}) {
  if (!isMainFrame) return false;

  // requestingUrl identifies the actual frame and is reliable for packaged
  // file:// pages even when Chromium exposes an opaque security origin.
  if (requestingUrl && requestingUrl !== "null") {
    return isTrustedRendererUrl(requestingUrl, developmentServerUrl);
  }

  const concreteOrigin = [requestingOrigin, securityOrigin]
    .find((value) => value && value !== "null");
  if (concreteOrigin) {
    return isTrustedRendererUrl(concreteOrigin, developmentServerUrl);
  }

  // Opaque file:// origin: only a trusted top-level BrowserWindow may fall
  // back to its current URL. Cross-origin/embedded frames were rejected above.
  return isTrustedRendererUrl(webContentsUrl, developmentServerUrl);
}
