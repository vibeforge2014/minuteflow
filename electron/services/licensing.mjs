import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deleteSecret, readSecret, storeSecret } from "./secrets.mjs";

const productId = "minuteflow-desktop";
const licenseSecretId = "minuteflow-desktop-license";
const offlineGraceMs = 30 * 24 * 60 * 60 * 1_000;
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

async function ensureDeviceId(state) {
  if (state.deviceId) return state.deviceId;
  const deviceId = randomUUID();
  await writeState({ ...state, deviceId });
  return deviceId;
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
    verificationConfigured: Boolean(config.verificationUrl),
    checkoutConfigured: Boolean(config.checkoutUrl),
    ...overrides
  };
}

async function verifyRemotely(licenseKey, deviceId, config) {
  const verificationUrl = config.verificationUrl;
  if (!verificationUrl) {
    throw new Error("授权验证服务尚未配置，请联系 xhdp123@126.com。");
  }
  const url = new URL(verificationUrl);
  if (url.protocol !== "https:") throw new Error("授权验证地址必须使用 HTTPS。");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      licenseKey,
      deviceId,
      productId,
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch
    }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? "激活码无效或已超过设备限制。"
    : "暂时无法连接授权验证服务，请稍后再试。");
  const result = await response.json();
  if (result.valid !== true) throw new Error(result.message || "激活码无效或已被撤销。");
  return result;
}

export async function getLicenseStatus({ refresh = false } = {}) {
  const config = await getConfig();
  const state = await readState();
  if (state.status !== "licensed") return publicStatus(state, config);
  const lastVerified = Date.parse(state.lastVerifiedAt || "");
  if (!refresh && Number.isFinite(lastVerified) && Date.now() - lastVerified < 72 * 60 * 60 * 1_000) {
    return publicStatus(state, config);
  }
  const licenseKey = readSecret(licenseSecretId);
  if (!licenseKey) {
    await writeState({ deviceId: state.deviceId });
    return publicStatus({ deviceId: state.deviceId }, config);
  }
  try {
    const result = await verifyRemotely(licenseKey, state.deviceId, config);
    const next = {
      ...state,
      status: "licensed",
      customerEmail: result.customerEmail || state.customerEmail,
      entitlementId: result.entitlementId || state.entitlementId,
      lastVerifiedAt: new Date().toISOString()
    };
    await writeState(next);
    return publicStatus(next, config);
  } catch (error) {
    if (Number.isFinite(lastVerified) && Date.now() - lastVerified <= offlineGraceMs) {
      return publicStatus(state, config, { offline: true, message: "当前离线，已使用最近一次有效授权。" });
    }
    return publicStatus(state, config, { state: "error", message: error instanceof Error ? error.message : "授权验证失败。" });
  }
}

export async function activateLicense(licenseKey) {
  const config = await getConfig();
  const normalized = String(licenseKey || "").trim();
  if (normalized.length < 8 || normalized.length > 256) throw new Error("请输入有效的激活码。");
  const state = await readState();
  const deviceId = await ensureDeviceId(state);
  const result = await verifyRemotely(normalized, deviceId, config);
  storeSecret(normalized, licenseSecretId);
  const now = new Date().toISOString();
  const next = {
    deviceId,
    status: "licensed",
    entitlementId: result.entitlementId,
    customerEmail: result.customerEmail,
    activatedAt: state.activatedAt || now,
    lastVerifiedAt: now
  };
  await writeState(next);
  return publicStatus(next, config);
}

export async function deactivateLicense() {
  const config = await getConfig();
  const state = await readState();
  deleteSecret(licenseSecretId);
  await writeState({ deviceId: state.deviceId });
  return publicStatus({ deviceId: state.deviceId }, config);
}

export async function requireLicense() {
  const status = await getLicenseStatus();
  if (status.state !== "licensed") {
    const error = new Error("此功能需要解锁 MinuteFlow。");
    error.code = "LICENSE_REQUIRED";
    throw error;
  }
  return status;
}

export async function checkoutUrl() {
  const config = await getConfig();
  const candidate = config.checkoutUrl || "https://vibeforge2014.github.io/meeting-assistant-site/pricing/";
  const url = new URL(candidate);
  if (url.protocol !== "https:") throw new Error("购买地址必须使用 HTTPS。");
  return url.toString();
}
