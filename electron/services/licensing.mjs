import { app } from "electron";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces, cpus, platform, arch } from "node:os";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { deleteSecret, readSecret, storeSecret } from "./secrets.mjs";

const productId = "minuteflow-desktop";
const licenseSecretId = "minuteflow-desktop-license";
const offlineGraceMs = 30 * 24 * 60 * 60 * 1_000;
const cacheTtlMs = 72 * 60 * 60 * 1_000;
// Temporary bridge while the Paddle-backed verification service is being
// completed. Keep only the digest in the shipped client, bind activation to
// the first device, and stop honoring it after the fixed deadline.
const temporaryLicenseHash = "b073dfd808f321b85324cbc40592a8f8eebfb1c756551c47226258e236a2b999";
const temporaryLicenseExpiresAt = "2026-10-01T00:00:00.000Z";
// A wall-clock-vs-uptime skew beyond this many seconds signals the clock was
// rolled back: if the wall claims less time elapsed than uptime advanced, or
// the stored lastVerifiedAt is in the future, treat as tampering.
const clockSkewToleranceMs = 60_000;
let cachedConfig;

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

function statePath() {
  return path.join(app.getPath("userData"), "config", "license.json");
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeState(value) {
  const target = statePath();
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

// Machine fingerprint built from stable, non-sensitive OS traits. Used to bind
// an activation to a device so copying license.json to another Mac is rejected.
function machineFingerprint() {
  const interfaces = networkInterfaces();
  const macs = Object.values(interfaces)
    .flat()
    .filter((item) => item && !item.internal && item.mac && item.mac !== "00:00:00:00:00:00")
    .map((item) => item.mac)
    .sort();
  const cpuSignature = (cpus()[0]?.model || "") + (cpus().length || 0);
  return createHash("sha256")
    .update(`${platform()}|${arch()}|${hostname()}|${cpuSignature}|${macs.join(",")}`)
    .digest("hex");
}

async function ensureDeviceId(state) {
  const fingerprint = machineFingerprint();
  if (state.deviceId) {
    // Re-bind check: if the stored fingerprint no longer matches this machine,
    // the state was copied from another device. Force a fresh activation.
    if (state.machineFingerprint && state.machineFingerprint !== fingerprint) {
      throw new Error("授权已绑定其他设备，请在本机重新激活。");
    }
    return { deviceId: state.deviceId, fingerprint };
  }
  const deviceId = randomUUID();
  await writeState({ ...state, deviceId, machineFingerprint: fingerprint });
  return { deviceId, fingerprint };
}

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

class LicenseError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "invalid" (terminal) | "transient" (retryable/grace)
  }
}

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

function nowUptimeMs() {
  return process.uptime() * 1_000;
}

function isTemporaryLicenseKey(value) {
  const supplied = createHash("sha256").update(value).digest();
  const expected = Buffer.from(temporaryLicenseHash, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function temporaryLicenseIsValid(state) {
  return state.entitlementId === "temporary-paddle-bridge"
    && state.temporaryExpiresAt === temporaryLicenseExpiresAt
    && Date.now() < Date.parse(temporaryLicenseExpiresAt);
}

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

export async function activateLicense(licenseKey) {
  const config = await getConfig();
  const normalized = String(licenseKey || "").trim();
  if (normalized.length < 8 || normalized.length > 256) throw new Error("请输入有效的激活码。");
  const state = await readState();
  const { deviceId, fingerprint } = await ensureDeviceId(state);
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

export async function deactivateLicense() {
  const config = await getConfig();
  const state = await readState();
  deleteSecret(licenseSecretId);
  await writeState({ deviceId: state.deviceId, machineFingerprint: state.machineFingerprint });
  return publicStatus({ deviceId: state.deviceId, machineFingerprint: state.machineFingerprint }, config);
}

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
