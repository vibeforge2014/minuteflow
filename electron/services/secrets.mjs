import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const secretsPath = () => path.join(app.getPath("userData"), "secrets.json");

function readVault() {
  const file = secretsPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeVault(vault) {
  mkdirSync(path.dirname(secretsPath()), { recursive: true });
  writeFileSync(secretsPath(), `${JSON.stringify(vault, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function storeSecret(value, existingId) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法使用安全存储，API Key 未保存。");
  }
  const vault = readVault();
  const id = existingId || randomUUID();
  vault[id] = safeStorage.encryptString(value).toString("base64");
  writeVault(vault);
  return id;
}

export function readSecret(id) {
  if (!id) return "";
  const encrypted = readVault()[id];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return "";
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

export function deleteSecret(id) {
  const vault = readVault();
  delete vault[id];
  writeVault(vault);
}

