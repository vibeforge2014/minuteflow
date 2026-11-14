/**
 * 自动更新下载会话的纯状态机（无 electron 依赖，可单测）。
 *
 * 背景（用户反馈）：macOS electron-updater 的 HTTP 下载在慢速线路上可能长时间
 * 没有任何 download-progress 事件，UI 就永远停在同一个百分比；取消后也不会
 * 收到 cancelled 结果。这里把「进度合并 / 停滞判定 / 快照」抽成纯函数，
 * auto-update.mjs 只负责驱动事件与滑窗计时，测试锁定判定边界。
 */

/** fraction 达到该值即认为 HTTP 传输完成、进入 Squirrel.Mac 本地安装准备阶段。 */
export const FINALIZE_FRACTION = 0.98;

/** 连续多久没有进度事件算「停滞」。 */
export const DEFAULT_STALL_MS = 90_000;

/** 进入安装准备阶段后，多久还没收到 update-downloaded 算失败（不可重试）。 */
export const DEFAULT_FINALIZE_MS = 180_000;

/**
 * 新建一次下载会话。
 * @param {{version?: string, now?: number, attempt?: number}} input
 */
export function createDownloadSession({ version = "", now = Date.now(), attempt = 1 } = {}) {
  return {
    version,
    attempt,
    startedAt: now,
    lastProgressAt: now,
    receivedBytes: 0,
    totalBytes: 0,
    fraction: 0,
    finalizing: false,
    cancelRequested: false,
    cancelledEmitted: false,
    readyEmitted: false,
    errorEmitted: false
  };
}

/**
 * 合并一次 download-progress 事件（electron-updater 的 transferred/total）。
 * 返回会话自身，便于链式调用。
 */
export function mergeProgress(session, payload = {}, now = Date.now()) {
  const received = Number(payload.transferred ?? payload.receivedBytes ?? 0);
  const total = Number(payload.total ?? payload.totalBytes ?? 0);
  if (Number.isFinite(received)) session.receivedBytes = Math.max(0, Math.round(received));
  if (Number.isFinite(total) && total > 0) session.totalBytes = Math.round(total);
  const fraction = Number(payload.fraction);
  if (Number.isFinite(fraction)) {
    session.fraction = Math.min(1, Math.max(0, fraction));
  } else if (session.totalBytes > 0) {
    session.fraction = Math.min(1, session.receivedBytes / session.totalBytes);
  }
  if (session.fraction >= FINALIZE_FRACTION) session.finalizing = true;
  session.lastProgressAt = now;
  return session;
}

/**
 * 停滞判定：
 * - 已请求取消 → 永远 "ok"（取消是用户意图，不是故障）；
 * - 安装准备阶段（finalizing）没有进度事件属正常，只允许超时 `"fail"`（不可重试）；
 * - 下载阶段连续 stallMs 无进度：第 1 次 → `"retry"`，第 2 次 → `"fail"`。
 * @returns {"ok" | "retry" | "fail"}
 */
export function evaluateDownloadHealth(session, now = Date.now(), {
  stallMs = DEFAULT_STALL_MS,
  finalizeMs = DEFAULT_FINALIZE_MS
} = {}) {
  if (session.cancelRequested) return "ok";
  const idleFor = now - session.lastProgressAt;
  if (session.finalizing) return idleFor > finalizeMs ? "fail" : "ok";
  if (idleFor <= stallMs) return "ok";
  return session.attempt <= 1 ? "retry" : "fail";
}

/**
 * 供 updates:get-state 与事件推送复用的进度快照（渲染层 AppUpdateDownloadProgress 同构）。
 */
export function progressSnapshot(session, status = "downloading", message = "") {
  return {
    status,
    version: session.version,
    receivedBytes: session.receivedBytes,
    totalBytes: session.totalBytes,
    fraction: session.fraction,
    ...(message ? { message } : {})
  };
}
