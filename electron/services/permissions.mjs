/**
 * Electron 媒体权限来源校验。
 *
 * 打包后的渲染器从 file:// 加载，Chromium 在部分版本会把媒体权限检查的
 * requestingOrigin 报成不透明的 "null"。因此不能只检查 origin：优先使用
 * requestingUrl，缺失时才回退到受信任主窗口 URL；子框架始终拒绝。
 */

export function isTrustedRendererUrl(url, developmentServerUrl = "", expectedFileUrl = "") {
  if (typeof url !== "string" || !url || url === "null") return false;
  if (developmentServerUrl) {
    try {
      return new URL(url).origin === new URL(developmentServerUrl).origin;
    } catch {
      return false;
    }
  }
  // 打包后不能把「任意 file:// 页面」都当作可信渲染层：那样磁盘上任何本地
  // HTML 都能借 preload 调用全部 IPC。这里精确比对应用自己的 index.html。
  // 只比 protocol + pathname，保留 query/hash（如权限引导浮层的 ?surface=...）。
  if (expectedFileUrl) {
    try {
      const candidate = new URL(url);
      const expected = new URL(expectedFileUrl);
      return candidate.protocol === expected.protocol && candidate.pathname === expected.pathname;
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
  developmentServerUrl = "",
  expectedFileUrl = ""
} = {}) {
  if (!isMainFrame) return false;

  // 精确 file URL 模式下，Chromium 常把 requestingOrigin 报成不透明的 "null"、
  // requestingUrl 报成裸 file://，拿它们做路径比对会误拒正常录音。此时只认
  // BrowserWindow 当前加载的真实地址（同样经过精确路径比对）。
  if (expectedFileUrl && !developmentServerUrl) {
    return isTrustedRendererUrl(webContentsUrl, developmentServerUrl, expectedFileUrl);
  }

  // requestingUrl identifies the actual frame and is reliable for packaged
  // file:// pages even when Chromium exposes an opaque security origin.
  if (requestingUrl && requestingUrl !== "null") {
    return isTrustedRendererUrl(requestingUrl, developmentServerUrl, expectedFileUrl);
  }

  const concreteOrigin = [requestingOrigin, securityOrigin]
    .find((value) => value && value !== "null");
  if (concreteOrigin) {
    return isTrustedRendererUrl(concreteOrigin, developmentServerUrl, expectedFileUrl);
  }

  // Opaque file:// origin: only a trusted top-level BrowserWindow may fall
  // back to its current URL. Cross-origin/embedded frames were rejected above.
  return isTrustedRendererUrl(webContentsUrl, developmentServerUrl, expectedFileUrl);
}
