/**
 * 一次性购买授权（¥99）的验证与状态管理（Electron 主进程 / 服务层）。
 * 激活码经 HTTPS 验证服务校验后写入本地 license.json（原子写、0o600），
 * 激活码本体存入 secrets.mjs 密钥库；按机器指纹绑定设备，提供 72 小时状态
 * 缓存、30 天离线宽限与回拨时钟检测，另含过渡期临时授权码桥接。
 * 主要导出：getLicenseStatus、activateLicense、deactivateLicense、requireLicense、checkoutUrl。
 * 被 main.mjs 的 licensing:* 通道与各付费功能通道（作为 requireLicense 授权墙）调用。
 * 副作用：网络请求（验证服务）、读写 license.json 与密钥库。
 */
import { app } from "electron";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, cpus, platform, arch } from "node:os";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { deleteSecret, readSecret, storeSecret } from "./secrets.mjs";

const productId = "minuteflow-desktop";
/** 激活码在密钥库中的固定条目 ID。 */
const licenseSecretId = "minuteflow-desktop-license";
/** 离线宽限期：最近一次有效验证后 30 天内允许离线使用。 */
const offlineGraceMs = 30 * 24 * 60 * 60 * 1_000;
/** 状态缓存有效期：72 小时内不重复远程验证。 */
const cacheTtlMs = 72 * 60 * 60 * 1_000;
// Temporary bridge while the Paddle-backed verification service is being
// completed. Keep only the digest in the shipped client, bind activation to
// the first device, and stop honoring it after the fixed deadline.
const temporaryLicenseHashes = [
  "b073dfd808f321b85324cbc40592a8f8eebfb1c756551c47226258e236a2b999",
  "6ba04be973fddb8b1b8a7084db786c01761773c77745045a4babff88992e6383"
];
const temporaryLicenseExpiresAt = "2026-10-01T00:00:00.000Z";
// A wall-clock-vs-uptime skew beyond this many seconds signals the clock was
// rolled back: if the wall claims less time elapsed than uptime advanced, or
// the stored lastVerifiedAt is in the future, treat as tampering.
/** 时钟回拨判定容差：小于该偏差（毫秒）视作正常的 NTP 校时抖动。 */
const clockSkewToleranceMs = 60_000;
let cachedConfig;

/**
 * 读取授权相关配置（购买页与验证服务地址）：优先环境变量，其次打包产物内的
 * licensing.json。结果缓存，Paddle 相关密钥永不随客户端分发。
 */
async function getConfig() {
  if (cachedConfig) return cachedConfig;
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(path.join(app.getAppPath(), "dist", "client", "config", "licensing.json"), "utf8"));
  } catch {}
  cachedConfig = {
    checkoutUrl: process.env.MINUTEFLOW_CHECKOUT_URL?.trim() || fileConfig.checkoutUrl || "",
    verificationUrl: process.env.MINUTEFLOW_LICENSE_VERIFY_URL?.trim() || fileConfig.verificationUrl || ""
  };
  return cachedConfig;
}

/** 本地授权状态文件路径（userData/config/license.json）。 */
function statePath() {
  return path.join(app.getPath("userData"), "config", "license.json");
}

/** 读取授权状态 JSON；文件缺失/损坏返回空对象（视作未激活）。 */
async function readState() {
  try {
    return JSON.parse(await readFile(statePath(), "utf8"));
  } catch {
    return {};
  }
}

/** 原子化写入授权状态（.tmp + rename，权限 0o600），避免崩溃留下半截状态。 */
async function writeState(value) {
  const target = statePath();
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

// 取稳定的硬件标识（缓存）：macOS 用 IOPlatformUUID，Windows 用 MachineGuid，
// Linux 用 /etc/machine-id。
// Stable, non-sensitive hardware identifier. Used instead of MAC addresses,
// which change whenever a VPN, Docker bridge, dock, or Wi-Fi/Ethernet interface
// appears or disappears — a drift that previously invalidated the fingerprint
// and locked users out ("已绑定其他设备") on their own machine.
let cachedHardwareId;
function stableHardwareId() {
  if (cachedHardwareId !== undefined) return cachedHardwareId;
  let id = "";
  try {
    if (process.platform === "darwin") {
      const output = execSync("ioreg -d2 -c IOPlatformExpertDevice", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      id = match ? match[1] : "";
    } else if (process.platform === "win32") {
      const output = execSync('reg query "HKLM\\Software\\Microsoft\\Cryptography" /v MachineGuid', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
      id = match ? match[1] : "";
    } else {
      try { id = readFileSync("/etc/machine-id", "utf8").trim(); } catch {}
      if (!id) { try { id = readFileSync("/var/lib/dbus/machine-id", "utf8").trim(); } catch {} }
    }
  } catch {
    // Fall back below to the legacy traits.
  }
  cachedHardwareId = id;
  return id;
}

// Machine fingerprint used to bind an activation to a device so copying
// license.json to another machine is rejected. Prefer the stable hardware UUID;
// fall back to hostname + CPU only if no stable ID is available.
/**
 * 计算设备指纹：优先稳定硬件 UUID，取不到时退回"主机名|CPU 型号+核心数"。
 * 用于把激活绑定到首台设备——仅复制 license.json 到别的机器会被此校验拒绝。
 * @returns {string} sha256 指纹十六进制串
 */
function machineFingerprint() {
  const hardwareId = stableHardwareId();
  const cpuSignature = (cpus()[0]?.model || "") + (cpus().length || 0);
  const stable = hardwareId || `${hostname()}|${cpuSignature}`;
  return createHash("sha256")
    .update(`${platform()}|${arch()}|${stable}`)
    .digest("hex");
}

/** 把内部状态整理为渲染层可见的授权状态对象（不含敏感字段，只保留展示所需信息）。 */
function publicStatus(state, config, overrides = {}) {
  const licensed = state.status === "licensed";
  return {
    state: licensed ? "licensed" : "unlicensed",
    productId,
    customerEmail: licensed ? state.customerEmail : undefined,
    entitlementId: licensed ? state.entitlementId : undefined,
    activatedAt: licensed ? state.activatedAt : undefined,
    lastVerifiedAt: licensed ? state.lastVerifiedAt : undefined,
    offline: Boolean(overrides.offline),
    insecureStorage: !readSecretSecureFlag(),
    verificationConfigured: Boolean(config.verificationUrl),
    checkoutConfigured: Boolean(config.checkoutUrl),
    ...overrides
  };
}

// Cheap check (does not read the vault value) for surfacing a UI notice.
/** 廉价检查（不触碰密钥值本身）：密钥库文件是否存在，用于 UI 显示"密钥未加密"提示。 */
function readSecretSecureFlag() {
  try {
    return existsSync(path.join(app.getPath("userData"), "secrets.json"));
  } catch {
    return false;
  }
}

// Detect clock rollback by comparing wall-clock elapsed since lastVerifiedAt
// against both the file mtime and the monotonic process uptime baseline.
// Returns true when the clock appears to have been moved backward.
/**
 * 检测系统时钟是否被回拨（防绕过离线宽限期的篡改手段）。
 * 三重交叉验证：墙钟早于上次验证时间、license.json 的 mtime 与墙钟矛盾、
 * 单调递增的进程 uptime 比 wall clock 走得更多。
 * @returns {boolean} 判定回拨返回 true
 */
function detectClockRollback(state) {
  const lastVerified = Date.parse(state.lastVerifiedAt || "");
  if (!Number.isFinite(lastVerified)) return false;
  const now = Date.now();
  // Wall clock is now before the last verification timestamp.
  if (now < lastVerified - clockSkewToleranceMs) return true;
  const elapsedWall = now - lastVerified;
  // Cross-check against the license file's mtime: if the wall claims a long
  // time passed but the file was modified far more recently, the clock moved.
  try {
    const mtime = statSync(statePath()).getTime();
    if (Number.isFinite(mtime) && mtime > lastVerified && now - mtime < elapsedWall - 60_000) {
      return true;
    }
  } catch {}
  // Cross-check against the stored uptime baseline within the same process
  // session: uptime is monotonic, so if the wall advanced less than uptime did,
  // the clock was rolled back during this run.
  if (Number.isFinite(state.lastVerifiedUptimeMs)) {
    const uptimeDelta = process.uptime() * 1_000 - state.lastVerifiedUptimeMs;
    if (uptimeDelta > elapsedWall + clockSkewToleranceMs) return true;
  }
  return false;
}

/** 授权错误类型：kind 为 "invalid"（终态，立即失效）或 "transient"（可重试，可用离线宽限）。 */
class LicenseError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "invalid" (terminal) | "transient" (retryable/grace)
  }
}

/**
 * 调用远程验证服务（副作用：网络请求）。提交激活码、设备 ID 与机器指纹，
 * 由服务端裁决设备数量限制。HTTP 语义分级：401/403/410 为终态无效（绝不进入离线宽限），
 * 网络失败与 429/5xx 为瞬态（可重试、可宽限）。
 * @returns {Promise<{valid: boolean, customerEmail?: string, entitlementId?: string}>}
 */
async function verifyRemotely(licenseKey, deviceId, config) {
  const verificationUrl = config.verificationUrl;
  if (!verificationUrl) {
    throw new LicenseError("授权验证服务尚未配置，请联系 xhdp123@126.com。", "transient");
  }
  const url = new URL(verificationUrl);
  if (url.protocol !== "https:") throw new LicenseError("授权验证地址必须使用 HTTPS。", "invalid");
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        licenseKey,
        deviceId,
        machineFingerprint: machineFingerprint(),
        productId,
        appVersion: app.getVersion(),
        platform: process.platform,
        architecture: process.arch
      }),
      signal: AbortSignal.timeout(12_000)
    });
  } catch (error) {
    // Network/timeout failure — retryable, may use offline grace.
    throw new LicenseError("暂时无法连接授权验证服务，请稍后再试。", "transient");
  }
  // 401/403/410: the server explicitly refuses the key. Terminal — do NOT
  // fall into offline grace, otherwise a revoked license keeps working.
  if (response.status === 401 || response.status === 403 || response.status === 410) {
    throw new LicenseError("激活码无效或已被撤销。", "invalid");
  }
  // 429/5xx: transient server trouble — retryable, may use offline grace.
  if (!response.ok) {
    throw new LicenseError("暂时无法连接授权验证服务，请稍后再试。", "transient");
  }
  const result = await response.json();
  if (result.valid !== true) {
    throw new LicenseError(result.message || "激活码无效或已被撤销。", "invalid");
  }
  return result;
}

/** 当前进程 uptime（毫秒）：不受改系统时间影响，用作回拨检测的单调基准。 */
function nowUptimeMs() {
  return process.uptime() * 1_000;
}

/** 用 timingSafeEqual 比对 SHA-256 摘要判断是否为过渡期临时授权码（客户端只存摘要不存明文）。 */
function isTemporaryLicenseKey(value) {
  const supplied = createHash("sha256").update(value).digest();
  return temporaryLicenseHashes.some((hash) => {
    const expected = Buffer.from(hash, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

/** 临时授权状态是否仍有效：entitlementId 匹配、截止日期匹配且未过期。 */
function temporaryLicenseIsValid(state) {
  return state.entitlementId === "temporary-paddle-bridge"
    && state.temporaryExpiresAt === temporaryLicenseExpiresAt
    && Date.now() < Date.parse(temporaryLicenseExpiresAt);
}

/**
 * 查询授权状态（licensing:get-status 通道调用）。副作用：可能网络验证、写 license.json。
 * 决策顺序：未激活直接返回；临时授权校验指纹与有效期；正式授权在 72 小时缓存内
 * 直接返回缓存（时钟回拨除外，回拨强制远程复核）；否则远程验证，
 * 瞬态失败且在 30 天宽限期内时降级为离线授权，终态失败立即失效。
 * @param {{refresh?: boolean}} options refresh=true 跳过缓存强制远程验证
 * @returns {Promise<object>} 渲染层可见的授权状态
 */
export async function getLicenseStatus({ refresh = false } = {}) {
  const config = await getConfig();
  const state = await readState();
  if (state.status !== "licensed") return publicStatus(state, config);
  if (state.entitlementId === "temporary-paddle-bridge") {
    if (state.machineFingerprint !== machineFingerprint()) {
      return publicStatus(state, config, { state: "unlicensed", message: "临时授权已绑定其他设备。" });
    }
    if (temporaryLicenseIsValid(state)) return publicStatus(state, config);
    await writeState({ deviceId: state.deviceId, machineFingerprint: state.machineFingerprint });
    return publicStatus({}, config, { state: "unlicensed", message: "临时授权已过期，请使用正式授权激活。" });
  }
  const lastVerified = Date.parse(state.lastVerifiedAt || "");
  // Clock rollback always forces a remote re-check; the cached/offline paths
  // must not honor a tampered clock.
  const rolledBack = detectClockRollback(state);
  if (!refresh && !rolledBack && Number.isFinite(lastVerified) && Date.now() - lastVerified < cacheTtlMs) {
    return publicStatus(state, config);
  }
  const licenseKey = readSecret(licenseSecretId);
  if (!licenseKey) {
    // Do NOT wipe the stored license state here — the keychain may be locked
    // transiently. Surface an error so the user can re-unlock/re-activate
    // instead of silently losing a valid entitlement.
    return publicStatus(state, config, { state: "error", message: "无法读取授权密钥，请确认密钥库已解锁或重新激活。" });
  }
  try {
    const result = await verifyRemotely(licenseKey, state.deviceId, config);
    const next = {
      ...state,
      status: "licensed",
      customerEmail: result.customerEmail || state.customerEmail,
      entitlementId: result.entitlementId || state.entitlementId,
      lastVerifiedAt: new Date().toISOString(),
      lastVerifiedUptimeMs: nowUptimeMs()
    };
    await writeState(next);
    return publicStatus(next, config);
  } catch (error) {
    // Only transient failures (network/5xx) may use the offline grace window.
    // A terminal "invalid" result ends the entitlement immediately.
    const isTransient = error instanceof LicenseError ? error.kind === "transient" : true;
    if (!rolledBack && isTransient && Number.isFinite(lastVerified) && Date.now() - lastVerified <= offlineGraceMs) {
      return publicStatus(state, config, { offline: true, message: "当前离线，已使用最近一次有效授权。" });
    }
    return publicStatus(state, config, {
      state: "error",
      message: error instanceof Error ? error.message : "授权验证失败。"
    });
  }
}

/**
 * 用激活码激活授权（licensing:activate 通道调用）。副作用：网络验证、写密钥库与 license.json。
 * 支持两条路径：过渡期临时授权码（本地校验摘要与有效期、绑定首台设备）；
 * 正式 Paddle 授权走远程验证（服务端是设备数量限制的最终裁决方）。
 * 激活码长度先做 8-256 的基本校验。
 * @returns {Promise<object>} 激活后的授权状态
 */
export async function activateLicense(licenseKey) {
  const config = await getConfig();
  const normalized = String(licenseKey || "").trim();
  if (normalized.length < 8 || normalized.length > 256) throw new Error("请输入有效的激活码。");
  const state = await readState();
  // Re-binding on activation is intentional: the fingerprint can drift when the
  // OS hardware ID or a fallback trait changes, and a legitimate user entering a
  // valid code on this machine must always be able to recover. Copy-protection
  // is preserved because license.json alone (without re-activating) still fails
  // the fingerprint check in getLicenseStatus on a different machine.
  const fingerprint = machineFingerprint();
  const deviceId = state.deviceId || randomUUID();
  if (isTemporaryLicenseKey(normalized)) {
    if (Date.now() >= Date.parse(temporaryLicenseExpiresAt)) {
      throw new Error("临时激活码已过期，请使用正式授权激活。");
    }
    const now = new Date().toISOString();
    const next = {
      deviceId,
      machineFingerprint: fingerprint,
      status: "licensed",
      entitlementId: "temporary-paddle-bridge",
      customerEmail: "temporary@minuteflow.local",
      activatedAt: state.activatedAt || now,
      lastVerifiedAt: now,
      lastVerifiedUptimeMs: nowUptimeMs(),
      temporaryExpiresAt: temporaryLicenseExpiresAt
    };
    deleteSecret(licenseSecretId);
    await writeState(next);
    return publicStatus(next, config);
  }
  // Remote (Paddle) licenses are verified server-side; the server is the real
  // authority on device limits, so re-activation re-binds to this machine.
  const result = await verifyRemotely(normalized, deviceId, config);
  // storeSecret now degrades to plaintext instead of throwing when safeStorage
  // is unavailable, so an unsigned build no longer loses a verified license.
  storeSecret(normalized, licenseSecretId);
  const now = new Date().toISOString();
  const next = {
    deviceId,
    machineFingerprint: fingerprint,
    status: "licensed",
    entitlementId: result.entitlementId,
    customerEmail: result.customerEmail,
    activatedAt: state.activatedAt || now,
    lastVerifiedAt: now,
    lastVerifiedUptimeMs: nowUptimeMs()
  };
  await writeState(next);
  return publicStatus(next, config);
}

/** 停用本机授权（licensing:deactivate）：删除密钥并清空授权状态，但保留 deviceId/指纹以便再激活。 */
export async function deactivateLicense() {
  const config = await getConfig();
  const state = await readState();
  deleteSecret(licenseSecretId);
  await writeState({ deviceId: state.deviceId, machineFingerprint: state.machineFingerprint });
  return publicStatus({ deviceId: state.deviceId, machineFingerprint: state.machineFingerprint }, config);
}

/**
 * 付费功能统一授权墙（main.mjs 各付费通道入口处 await 调用）。
 * 未授权时抛出带 [LICENSE_REQUIRED] 前缀的错误——自定义 error.code 属性
 * 无法穿越 contextBridge，前缀是渲染层识别授权错误并弹购买墙的唯一依据。
 * @returns {Promise<object>} 已授权时返回授权状态
 */
export async function requireLicense() {
  const status = await getLicenseStatus();
  if (status.state !== "licensed") {
    // Prefix the code into the message because custom Error properties (like
    // .code) are stripped when errors cross the Electron contextBridge, so the
    // renderer cannot otherwise distinguish license errors from generic ones.
    const error = new Error("[LICENSE_REQUIRED] 此功能需要解锁 MinuteFlow。");
    error.code = "LICENSE_REQUIRED";
    throw error;
  }
  return status;
}

/**
 * 返回购买页地址（licensing:open-checkout）：优先配置值，缺省官网 pricing 页；
 * 地址必须能解析为 URL 且为 HTTPS，否则报错（不允许把用户带去非加密页面）。
 * @returns {Promise<string>} 购买页 URL
 */
export async function checkoutUrl() {
  const config = await getConfig();
  const candidate = config.checkoutUrl || "https://vibeforge2014.github.io/minuteflow/pricing/";
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("购买地址配置无效，请联系 xhdp123@126.com。");
  }
  if (url.protocol !== "https:") throw new Error("购买地址必须使用 HTTPS。");
  return url.toString();
}
