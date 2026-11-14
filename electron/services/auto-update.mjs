/**
 * macOS 自动更新（electron-updater / Squirrel.Mac，与 ChargePilot 的 Sparkle 同源机制）：
 * 发现新版本后后台静默下载 → 校验（sha512 + 开发者签名 Team ID）→ 退出时自动安装，
 * 或由用户显式触发「立即重启并更新」（quitAndInstall）。绝不自行重启应用。
 *
 * - feed 指向打包时写进 Contents/Resources/app-update.yml 的 zensoft.top 稳定地址；
 * - 仅在 darwin + 打包环境下可用，其余情况返回 null/抛错，调用方回退旧的手动 DMG 流程；
 * - electron-updater 依赖 electron，必须懒加载：纯 Node 侧测试导入本模块不得触发加载。
 *
 * 下载会话（用户反馈修复）：
 * - 进度事件节流转发；`updates:get-state` 通过 macDownloadSnapshot() 暴露进行中快照；
 * - 停滞看门狗：90s 无进度自动重连一次，仍无进展则给出可读错误并停止；
 * - 取消闭环：cancel 立即推送 cancelled 事件，CancellationError 不再当失败；
 * - 下载完成统一走 onReady 回调（主进程发 toast 事件 + 系统通知）。
 */
import { compareVersions } from "./updates.mjs";
import {
  createDownloadSession,
  mergeProgress,
  evaluateDownloadHealth,
  progressSnapshot
} from "./update-download-state.mjs";

/** 进度转发最小间隔（状态转换不受限）。 */
const PROGRESS_THROTTLE_MS = 200;
/** 看门狗检查间隔。 */
const WATCHDOG_INTERVAL_MS = 10_000;
/** 停滞自动重连一次；第二次仍停滞时停下并提示手动下载。 */
const MAX_DOWNLOAD_ATTEMPTS = 2;
const STALL_ERROR_MESSAGE = "更新下载长时间无进展，已停止。可稍后重试，或从官网下载安装包。";
const FINALIZE_ERROR_MESSAGE = "更新已下载，但安装准备超时。可重启应用后重新检查更新。";
const RETRY_MESSAGE = "网络较慢，正在重新连接…";

let updaterInstance = null;
let updaterLoadFailed = false;
/** 已下载待安装的新版本号；空串表示当前没有就绪的更新。 */
let downloadedVersion = "";

/**
 * 当前下载会话：
 * { state, token, listeners:Set<fn>, promise, lastEmitAt, watchdog, retryRequested, failed, abandoned }
 * null 表示空闲。
 */
let downloadSession = null;
// Native Squirrel 没有取消 API。放弃本地准备后，不复用其内部挂起的
// downloadPromise；本次应用生命周期改走经过校验的 DMG 下载兜底。
let nativeRecoveryRequired = false;

/**
 * CJS 互操作加载 electron-updater：其入口用 defineProperty getter 导出具名导出，
 * cjs-module-lexer 静态探测不到，ESM 具名解构会拿到 undefined（0.1.36/0.1.37
 * 「本机暂不支持自动更新」的根因），必须回退到 default（= module.exports）取值。
 */
async function importElectronUpdater() {
  const mod = await import("electron-updater");
  return mod?.autoUpdater !== undefined ? mod : (mod?.default ?? mod);
}

/** 已下载待安装的新版本号；空串表示当前没有就绪的更新。 */
export function macDownloadedUpdateVersion() {
  return downloadedVersion;
}

/** 进行中下载的进度快照（供 updates:get-state 水合设置页）；空闲返回 null。 */
export function macDownloadSnapshot() {
  if (!downloadSession || downloadSession.state.cancelRequested || downloadSession.failed) return null;
  const { state } = downloadSession;
  return progressSnapshot(state, "downloading", downloadSession.retryRequested ? RETRY_MESSAGE : "");
}

/** 会话内广播一条进度。 */
function emitProgress(session, payload, { force = false } = {}) {
  const now = Date.now();
  if (!force && payload.status === "downloading" && now - session.lastEmitAt < PROGRESS_THROTTLE_MS) {
    return;
  }
  session.lastEmitAt = now;
  for (const listener of session.listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.warn("[auto-update] 进度回调失败：", error?.message || error);
    }
  }
}

/** 会话内广播一次 status=ready（幂等）。 */
function emitReady(session, version) {
  if (session.state.readyEmitted) return;
  session.state.readyEmitted = true;
  downloadedVersion = version || downloadedVersion;
  emitProgress(session, { status: "ready", version: downloadedVersion, receivedBytes: 0, totalBytes: 0, fraction: 1 }, { force: true });
  session.onReady?.(downloadedVersion);
}

/** 会话内广播一次 status=cancelled（幂等）。 */
function emitCancelled(session) {
  if (session.state.cancelledEmitted) return;
  session.state.cancelledEmitted = true;
  emitProgress(session, progressSnapshot(session.state, "cancelled", "已取消下载。"), { force: true });
}

/** 会话内广播一次 status=error（幂等）。 */
function emitError(session, message) {
  if (session.state.errorEmitted) return;
  session.state.errorEmitted = true;
  emitProgress(session, progressSnapshot(session.state, "error", message || "自动更新下载失败。"), { force: true });
}

/** electron-updater 的 CancellationError（builder-util-runtime）只带 message "cancelled"。 */
function isCancellationError(error) {
  return error?.message === "cancelled" || error?.name === "CancellationError";
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
    const [{ app }, updaterModule] = await Promise.all([
      import("electron"),
      importElectronUpdater()
    ]);
    if (!app.isPackaged) return null;
    const autoUpdater = updaterModule?.autoUpdater;
    if (!autoUpdater) {
      console.error("[auto-update] electron-updater 未导出 autoUpdater（CJS 互操作异常），回退手动下载流程");
      updaterLoadFailed = true;
      return null;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (...args) => console.log("[auto-update]", ...args),
      warn: (...args) => console.warn("[auto-update]", ...args),
      error: (...args) => console.error("[auto-update]", ...args)
    };
    updaterInstance = autoUpdater;
    // 保留一个日志监听，避免会话清理后晚到的 error 导致 EventEmitter 抛异常。
    autoUpdater.on("error", (error) => {
      if (!isCancellationError(error)) console.error("[auto-update] 更新器错误：", error?.message || error);
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
 * 调用方据此回退官网清单 + 手动 DMG 流程。只有 feed 版本严格大于当前版本才算可用。
 */
export async function checkMacUpdateFeed() {
  const autoUpdater = await getUpdater();
  if (!autoUpdater) return { available: false, version: "" };
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    const version = String(info?.version || "");
    let currentVersion = "";
    try {
      currentVersion = String((await import("electron")).app.getVersion() || "");
    } catch {
      currentVersion = "";
    }
    let newer = false;
    try {
      newer = Boolean(version) && (!currentVersion || compareVersions(version, currentVersion) > 0);
    } catch {
      newer = Boolean(version) && version !== currentVersion;
    }
    return { available: newer, version };
  } catch (error) {
    console.warn("[auto-update] feed 检查失败，将回退手动下载：", error?.message || error);
    return { available: false, version: "" };
  }
}

/** 启动停滞看门狗（每个会话只跑一个定时器）。 */
function startWatchdog(session) {
  stopWatchdog(session);
  session.watchdog = setInterval(() => {
    if (downloadSession !== session) return stopWatchdog(session);
    const verdict = evaluateDownloadHealth(session.state);
    if (verdict === "retry") {
      session.retryRequested = true;
      emitProgress(session, progressSnapshot(session.state, "downloading", RETRY_MESSAGE), { force: true });
      session.interrupt?.(new Error("__RETRY_DOWNLOAD__"));
      session.token.cancel();
    } else if (verdict === "fail") {
      session.failed = session.state.finalizing ? FINALIZE_ERROR_MESSAGE : STALL_ERROR_MESSAGE;
      emitError(session, session.failed);
      session.interrupt?.(new Error(session.failed));
      session.token.cancel();
    }
  }, WATCHDOG_INTERVAL_MS);
  if (typeof session.watchdog.unref === "function") session.watchdog.unref();
}

function stopWatchdog(session) {
  if (session.watchdog) {
    clearInterval(session.watchdog);
    session.watchdog = null;
  }
}

/**
 * 单会话下载驱动：feed 检查 → downloadUpdate → 失败重连（一次）。
 * 取消时 resolve {cancelled:true} 而不是抛错；失败抛错由调用方处理。
 */
async function runDownloadSession(session) {
  const autoUpdater = await getUpdater();
  if (!autoUpdater || nativeRecoveryRequired) throw new Error(MAC_AUTO_UPDATE_FALLBACK);
  try {
    if (session.state.cancelRequested) return { version: session.state.version, cancelled: true };
    // 检查 feed 和原生安装准备都可能不响应 CancellationToken，应用侧必须有独立出口。
    const interrupted = new Promise((_, reject) => { session.interrupt = reject; });
    const feed = await Promise.race([checkMacUpdateFeed(), interrupted]);
    if (session.state.cancelRequested) return { version: session.state.version, cancelled: true };
    if (!feed.available) throw new Error(MAC_AUTO_UPDATE_FALLBACK);
    session.state.version = feed.version;
    if (downloadedVersion) {
      emitReady(session, downloadedVersion);
      return { version: downloadedVersion };
    }
    startWatchdog(session);
    while (true) {
      let detach = () => {};
      try {
        const attemptInterrupted = new Promise((_, reject) => { session.interrupt = reject; });
        let nativeReady;
        const nativeFinished = new Promise((resolve) => { nativeReady = resolve; });
        const onProgress = (progress) => {
          if (downloadSession !== session || session.state.cancelRequested) return;
          mergeProgress(session.state, progress);
          emitProgress(session, progressSnapshot(session.state, "downloading"));
        };
        const onDownloaded = () => {
          // electron-updater 的事件仅表示 ZIP 已交给本地代理，尚未验证安装就绪。
          session.state.finalizing = true;
          session.state.lastProgressAt = Date.now();
        };
        const onNativeReady = () => nativeReady();
        const onError = (error) => {
          if (!isCancellationError(error)) session.interrupt?.(error);
        };
        autoUpdater.on("download-progress", onProgress);
        autoUpdater.on("update-downloaded", onDownloaded);
        autoUpdater.on("error", onError);
        autoUpdater.nativeUpdater?.on("update-downloaded", onNativeReady);
        detach = () => {
          autoUpdater.removeListener("download-progress", onProgress);
          autoUpdater.removeListener("update-downloaded", onDownloaded);
          autoUpdater.removeListener("error", onError);
          autoUpdater.nativeUpdater?.removeListener("update-downloaded", onNativeReady);
        };
        await Promise.race([
          (async () => {
            await autoUpdater.downloadUpdate(session.token);
            if (autoUpdater.nativeUpdater) await nativeFinished;
          })(),
          attemptInterrupted
        ]);
        emitReady(session, session.state.version);
        return { version: downloadedVersion };
      } catch (error) {
        if (session.state.finalizing) {
          nativeRecoveryRequired = true;
          autoUpdater.closeServerIfExists?.();
        }
        if (session.state.cancelRequested) return { version: session.state.version, cancelled: true };
        if (session.failed) throw new Error(session.failed);
        if (session.retryRequested && session.state.attempt < MAX_DOWNLOAD_ATTEMPTS) {
          // HTTP 阶段取消会使 SDK 清理内部 downloadPromise；先让它完成清理再重试。
          if (autoUpdater.downloadPromise) await autoUpdater.downloadPromise.catch(() => {});
          session.retryRequested = false;
          session.state.attempt += 1;
          session.state.finalizing = false;
          session.state.receivedBytes = 0;
          session.state.totalBytes = 0;
          session.state.fraction = 0;
          session.state.lastProgressAt = Date.now();
          const { CancellationToken } = await importElectronUpdater();
          session.token = new CancellationToken();
          emitProgress(session, progressSnapshot(session.state, "downloading", RETRY_MESSAGE), { force: true });
          continue;
        }
        throw error;
      } finally {
        detach();
      }
    }
  } catch (error) {
    if (session.state.cancelRequested) return { version: session.state.version, cancelled: true };
    emitError(session, error?.message === MAC_AUTO_UPDATE_FALLBACK ? "自动更新暂不可用，可从官网下载安装包。" : error?.message);
    throw error;
  } finally {
    session.interrupt = null;
    stopWatchdog(session);
  }
}

/**
 * 后台静默下载（或复用进行中/已完成的下载）。onProgress 收到与
 * updates:download-progress 相同结构的 payload（status: downloading | ready）。
 * onReady：本次下载被确认就绪时调用一次（主进程据此发 toast/系统通知）。
 * 失败时抛错，由调用方决定是否回退手动 DMG 流程；取消时 resolve {cancelled:true}。
 * updater 本身不可用（模块加载失败等）与 feed 不可用同待遇：抛回退哨兵，
 * 让用户至少拿到官网直链手动下载，而不是「本机暂不支持自动更新」死胡同。
 */
export async function downloadMacUpdate({ version = "", onProgress = null, onReady = null } = {}) {
  if (downloadSession) {
    // 加入进行中的会话：只补挂监听，不打断既有下载。
    if (typeof onProgress === "function") downloadSession.listeners.add(onProgress);
    if (typeof onReady === "function") {
      const previous = downloadSession.onReady;
      downloadSession.onReady = (readyVersion) => {
        previous?.(readyVersion);
        onReady(readyVersion);
      };
    }
    return downloadSession.promise;
  }
  const session = {
    state: createDownloadSession({ version }),
    token: null,
    listeners: new Set(),
    promise: null,
    lastEmitAt: 0,
    watchdog: null,
    retryRequested: false,
    failed: "",
    onReady: typeof onReady === "function" ? onReady : null
  };
  if (typeof onProgress === "function") session.listeners.add(onProgress);
  downloadSession = session;
  session.promise = (async () => {
    const { CancellationToken } = await importElectronUpdater().catch(() => ({}));
    if (!CancellationToken) throw new Error(MAC_AUTO_UPDATE_FALLBACK);
    session.token = new CancellationToken();
    if (session.state.cancelRequested) return { version, cancelled: true };
    return runDownloadSession(session);
  })().finally(() => {
    stopWatchdog(session);
    if (downloadSession === session) downloadSession = null;
    session.listeners.clear();
  });
  return session.promise;
}

/** 中止进行中的自动更新下载（updates:cancel-download 在 macOS 上的落点）。 */
export async function cancelMacDownload() {
  const session = downloadSession;
  if (!session) return { cancelled: false };
  session.state.cancelRequested = true;
  session.retryRequested = false;
  emitCancelled(session);
  session.interrupt?.(new Error("cancelled"));
  session.token?.cancel();
  return { cancelled: true };
}

/** 用户显式触发：原地替换并重启到新版本。仅在更新已就绪时有效。 */
export async function installMacUpdate() {
  const autoUpdater = await getUpdater();
  if (!autoUpdater || !downloadedVersion) throw new Error("更新尚未下载完成。");
  await autoUpdater.quitAndInstall();
}

/** 测试/退出清理：停止看门狗并中止在途下载。 */
export function disposeMacUpdater() {
  if (downloadSession) {
    stopWatchdog(downloadSession);
    downloadSession.state.cancelRequested = true;
    downloadSession.interrupt?.(new Error("cancelled"));
    downloadSession.token?.cancel();
    downloadSession = null;
  }
}

export const MAC_AUTO_UPDATE_FALLBACK = "__FALLBACK_MANUAL__";
