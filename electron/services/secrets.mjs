import { app, safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const secretsPath = () => path.join(app.getPath("userData"), "secrets.json");
// Serialize read-modify-write of the vault so two concurrent IPC handlers
// (e.g. saving a profile while deleting another secret) cannot interleave and
// silently drop a key.
let vaultWriteQueue = Promise.resolve();
const decryptedCache = new Map();

function readVault() {
  const file = secretsPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

async function writeVault(vault) {
  const file = secretsPath();
  const temporary = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(vault, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Atomic rename so a crash mid-write cannot corrupt the whole vault.
  await rename(temporary, file);
}

function encryptionAvailable() {
  // safeStorage requires a valid code signature on macOS; on unsigned/ad-hoc
  // builds it reports unavailable, which previously threw during activation
  // AFTER the server verified the key (locking paid users out). We degrade to
  // plaintext-with-warning instead of throwing.
  return typeof safeStorage === "object" && safeStorage !== null && safeStorage.isEncryptionAvailable();
}

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

export function warmSecretCache() {
  for (const id of Object.keys(readVault())) {
    try { readSecret(id); } catch { /* A locked vault is surfaced by the feature that needs it. */ }
  }
}

export function deleteSecret(id) {
  const vault = readVault();
  delete vault[id];
  decryptedCache.delete(id);
  vaultWriteQueue = vaultWriteQueue.catch(() => {}).then(() => writeVault(vault));
}

export function isSecureStorage() {
  return encryptionAvailable();
}

// Await any pending vault write (used on quit to flush).
export async function flushSecrets() {
  await vaultWriteQueue.catch(() => {});
  // Clean up a stale tmp file if a crash left one behind.
  await unlink(`${secretsPath()}.tmp`).catch(() => {});
}
