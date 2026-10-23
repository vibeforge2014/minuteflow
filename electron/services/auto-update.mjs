/**
 * macOS 自动更新（electron-updater / Squirrel.Mac，与 ChargePilot 的 Sparkle 同源机制）：
 * 发现新版本后后台静默下载 → 校验（sha512 + 开发者签名 Team ID）→ 退出时自动安装，
 * 或由用户显式触发「立即重启并更新」（quitAndInstall）。绝不自行重启应用。
 *
 * - feed 指向打包时写进 Contents/Resources/app-update.yml 的 zensoft.top 稳定地址；
 * - 仅在 darwin + 打包环境下可用，其余情况返回 null/抛错，调用方回退旧的手动 DMG 流程；
 * - electron-updater 依赖 electron，必须懒加载：纯 Node 侧测试导入本模块不得触发加载。
 */

let updaterInstance = null;
let updaterLoadFailed = false;
let downloadInFlight = null;
let downloadedVersion = "";
// electron-updater 事件只注册一次，转发给当前下载会话设置的 onProgress。
let activeProgressHandler = null;
let downloadCancellationToken = null;

/** 已下载待安装的新版本号；空串表示当前没有就绪的更新。 */
export function macDownloadedUpdateVersion() {
  return downloadedVersion;
}

/**
 * 取得配置好的 electron-updater 实例；不可用（非 darwin、非打包、模块缺失）时返回 null。
 * autoDownload=false：是否下载、何时下载由本服务显式驱动；
 * autoInstallOnAppQuit=true：已下载的更新在应用退出时自动安装（录音保护的兜底路径）。
 */
async function getUpdater() {
  if (updaterLoadFailed) return null;
  if (updaterInstance) return updaterInstance;
  if (process.platform !== "darwin") return null;
  try {
    const [{ app }, { autoUpdater }] = await Promise.all([
      import("electron"),
      import("electron-updater")
    ]);
    if (!app.isPackaged) return null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (...args) => console.log("[auto-update]", ...args),
      warn: (...args) => console.warn("[auto-update]", ...args),
      error: (...args) => console.error("[auto-update]", ...args)
    };
    updaterInstance = autoUpdater;
    autoUpdater.on("download-progress", (progress) => {
      activeProgressHandler?.({
        status: "downloading",
        version: "",
        receivedBytes: Math.round(progress.transferred || 0),
        totalBytes: Math.round(progress.total || 0),
        fraction: progress.total ? progress.transferred / progress.total : 0
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      downloadedVersion = String(info?.version || downloadedVersion || "");
      activeProgressHandler?.({ status: "ready", version: downloadedVersion, receivedBytes: 0, totalBytes: 0, fraction: 1 });
    });
    return autoUpdater;
  } catch (error) {
    console.error("[auto-update] electron-updater 不可用，回退手动下载流程：", error);
    updaterLoadFailed = true;
    return null;
  }
}

/**
 * 向 feed 询问一次更新（独立于官网清单检查，作为下载前置步骤）。
 * 返回 { available, version }；feed 不可达或没有更新时 available=false，
 * 调用方据此回退官网清单 + 手动 DMG 流程。
 */
export async function checkMacUpdateFeed() {
  const autoUpdater = await getUpdater();
  if (!autoUpdater) return { available: false, version: "" };
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    return { available: Boolean(info?.version), version: String(info?.version || "") };
  } catch (error) {
    console.warn("[auto-update] feed 检查失败，将回退手动下载：", error?.message || error);
    return { available: false, version: "" };
  }
}

/**
 * 后台静默下载（或复用进行中/已完成的下载）。onProgress 收到与
 * updates:download-progress 相同结构的 payload（status: downloading | ready）。
 * 失败时抛错，由调用方决定是否回退手动 DMG 流程。
 */
export async function downloadMacUpdate({ version = "", onProgress = () => {} } = {}) {
  if (downloadInFlight) return downloadInFlight;
  const autoUpdater = await getUpdater();
  if (!autoUpdater) throw new Error("本机暂不支持自动更新。");
  downloadInFlight = (async () => {
    try {
      const feed = await checkMacUpdateFeed();
      if (!feed.available) throw new Error("__FALLBACK_MANUAL__");
      if (downloadedVersion) {
        // 已下载完成：直接回报 ready，避免重复下载。
        onProgress({ status: "ready", version: downloadedVersion, receivedBytes: 0, totalBytes: 0, fraction: 1 });
        return { version: downloadedVersion };
      }
      activeProgressHandler = (payload) => onProgress({ ...payload, version: payload.version || version || feed.version });
      const { CancellationToken } = await import("electron-updater");
      downloadCancellationToken = new CancellationToken();
      const result = await autoUpdater.downloadUpdate(downloadCancellationToken);
      const resolved = downloadedVersion || String(result || feed.version);
      if (!downloadedVersion) downloadedVersion = resolved;
      return { version: resolved };
    } finally {
      downloadInFlight = null;
      activeProgressHandler = null;
      downloadCancellationToken = null;
    }
  })();
  return downloadInFlight;
}

/** 中止进行中的自动更新下载（updates:cancel-download 在 macOS 上的落点）。 */
export async function cancelMacDownload() {
  if (!downloadInFlight || !downloadCancellationToken) return { cancelled: false };
  downloadCancellationToken.cancel();
  return { cancelled: true };
}

/** 用户显式触发：原地替换并重启到新版本。仅在更新已就绪时有效。 */
export async function installMacUpdate() {
  const autoUpdater = await getUpdater();
  if (!autoUpdater || !downloadedVersion) throw new Error("更新尚未下载完成。");
  await autoUpdater.quitAndInstall();
}

export const MAC_AUTO_UPDATE_FALLBACK = "__FALLBACK_MANUAL__";
