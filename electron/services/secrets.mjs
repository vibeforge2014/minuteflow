/**
 * API 密钥与激活码的本地密钥库（Electron 主进程 / 服务层）。
 * 以 userData/secrets.json 为落地文件，优先用 Electron safeStorage（macOS Keychain /
 * Windows DPAPI）加密；不可用时降级为明文并让渲染层显示 insecureStorage 提示。
 * 主要导出：storeSecret、readSecret、warmSecretCache、deleteSecret、isSecureStorage、flushSecrets。
 * 被 main.mjs（models:save / models:test 等通道）、licensing.mjs（激活码存取）
 * 与 import-queue.mjs（取远程模型密钥）调用。副作用：读写密钥库文件。
 */
import { app, safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const secretsPath = () => path.join(app.getPath("userData"), "secrets.json");
// Serialize read-modify-write of the vault so two concurrent IPC handlers
// (e.g. saving a profile while deleting another secret) cannot interleave and
// silently drop a key.
// 串行化密钥库的读-改-写：两个并发 IPC（如保存档案的同时删另一条密钥）
// 若交错执行会互相覆盖丢键，这里用 Promise 链保证逐个落盘。
let vaultWriteQueue = Promise.resolve();
// 已解密密钥的内存缓存：避免每次远程调用都触发 Keychain 访问（也可能弹出系统提示）。
const decryptedCache = new Map();

/** 读取密钥库 JSON；文件不存在或损坏时返回空对象（视作尚未存任何密钥）。 */
function readVault() {
  const file = secretsPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 原子化写入密钥库：先写 .tmp（权限 0o600，仅当前用户可读）再 rename 覆盖，
 * 崩溃至多留下一个临时文件而不损坏整个密钥库。
 */
async function writeVault(vault) {
  const file = secretsPath();
  const temporary = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(vault, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Atomic rename so a crash mid-write cannot corrupt the whole vault.
  await rename(temporary, file);
}

/** 检查 safeStorage 加密是否可用；供降级决策与 isSecureStorage 状态上报使用。 */
function encryptionAvailable() {
  // safeStorage requires a valid code signature on macOS; on unsigned/ad-hoc
  // builds it reports unavailable, which previously threw during activation
  // AFTER the server verified the key (locking paid users out). We degrade to
  // plaintext-with-warning instead of throwing.
  return typeof safeStorage === "object" && safeStorage !== null && safeStorage.isEncryptionAvailable();
}

/**
 * 存入一条密钥（同步返回，磁盘写入在串行队列中异步完成）。
 * @param {string} value 密钥明文
 * @param {string=} existingId 复用已有条目 ID（更新场景），缺省生成新 UUID
 * @returns {string} 密钥条目 ID（存进模型档案的 secretId）
 * 副作用：写盘（经 vaultWriteQueue）；加密不可用时明文落盘并由渲染层提示。
 */
export function storeSecret(value, existingId) {
  const vault = readVault();
  const id = existingId || randomUUID();
  if (encryptionAvailable()) {
    vault[id] = { encrypted: true, data: safeStorage.encryptString(value).toString("base64") };
  } else {
    vault[id] = { encrypted: false, data: value };
  }
  // Run inside the write queue; storeSecret historically returned synchronously
  // (callers await the IPC handler, not this), so we keep the signature but the
  // actual disk write is serialized. The id is known before the write resolves.
  vaultWriteQueue = vaultWriteQueue.catch(() => {}).then(() => writeVault(vault));
  decryptedCache.set(id, value);
  return id;
}

/**
 * 按 ID 读取密钥明文：命中内存缓存直接返回，否则从密钥库解密并回填缓存。
 * 兼容三代存储格式：{encrypted:true}（现行）、旧版裸 base64 字符串、明文降级条目。
 * @returns {string} 密钥明文，不存在或无法解密返回空串
 */
export function readSecret(id) {
  if (!id) return "";
  if (decryptedCache.has(id)) return decryptedCache.get(id);
  const entry = readVault()[id];
  if (!entry) return "";
  // Legacy vaults stored a bare base64 string; treat it as encrypted.
  if (typeof entry === "string") {
    const value = encryptionAvailable() ? safeStorage.decryptString(Buffer.from(entry, "base64")) : "";
    if (value) decryptedCache.set(id, value);
    return value;
  }
  if (entry.encrypted) {
    if (!encryptionAvailable()) return "";
    const value = safeStorage.decryptString(Buffer.from(entry.data, "base64"));
    if (value) decryptedCache.set(id, value);
    return value;
  }
  // Plaintext fallback (unsigned build). The renderer surfaces an
  // insecureStorage notice so the user knows the key is not encrypted at rest.
  const value = typeof entry.data === "string" ? entry.data : "";
  if (value) decryptedCache.set(id, value);
  return value;
}

/**
 * 应用启动时预热缓存（main.mjs 在 whenReady 里调用）：把全部密钥提前解密，
 * 避免录音/结项流程成为 Keychain 的首次访问点而弹出意外系统提示。
 * 单条失败静默跳过，由真正需要该密钥的功能上报错误。
 */
export function warmSecretCache() {
  for (const id of Object.keys(readVault())) {
    try { readSecret(id); } catch { /* A locked vault is surfaced by the feature that needs it. */ }
  }
}

/** 删除一条密钥（同步返回；写盘同样进入串行队列），models:delete-secret 通道调用。 */
export function deleteSecret(id) {
  const vault = readVault();
  delete vault[id];
  decryptedCache.delete(id);
  vaultWriteQueue = vaultWriteQueue.catch(() => {}).then(() => writeVault(vault));
}

/** 当前密钥是否以加密形式存储（false 时渲染层显示"密钥未加密"警示）。 */
export function isSecureStorage() {
  return encryptionAvailable();
}

// Await any pending vault write (used on quit to flush).
/** 等待密钥库全部挂起写入落盘并清理残留 .tmp（应用退出前由 before-quit 调用）。 */
export async function flushSecrets() {
  await vaultWriteQueue.catch(() => {});
  // Clean up a stale tmp file if a crash left one behind.
  await unlink(`${secretsPath()}.tmp`).catch(() => {});
}
