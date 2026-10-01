/**
 * 激活码：生成、归一、哈希索引与 AES-GCM 静态加密。
 * 形态 MF-XXXX-XXXX-XXXX-XXXX（Crockford base32，16 位有效字符 ≈ 80 bit 熵）。
 * 数据库里只存 SHA-256（查找）与密文（成功页重显/邮件），服务端文件泄露也无法
 * 直接拿到可用明文（叠加 LICENSE_MASTER_KEY）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { db, nowIso, transaction } from "./db.mjs";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 生成一段去掉易混字符的 base32 随机串。 */
function crockfordBlock(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CROCKFORD[bytes[index] % CROCKFORD.length];
  }
  return out;
}

export function generateLicenseKey() {
  return `MF-${crockfordBlock(4)}-${crockfordBlock(4)}-${crockfordBlock(4)}-${crockfordBlock(4)}`;
}

/** 输入归一：大写、去空白与分隔符后重新按标准形态分组；非法字符返回 null。
 * 接受带 MF 前缀（18 字符）或裸 16 字符两种输入。 */
export function normalizeLicenseKey(value) {
  const compact = String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
  const body = compact.length === 18 && compact.startsWith("MF") ? compact.slice(2) : compact;
  if (!/^[0-9A-Z]{16}$/.test(body)) return null;
  if (body.split("").some((ch) => !CROCKFORD.includes(ch))) return null;
  return `MF-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

export function licenseKeyHash(normalizedKey) {
  return createHash("sha256").update(normalizedKey).digest("hex");
}

/** 32 字节主密钥：短口吻做 SHA-256 拉伸，保证 AES-256-GCM 可用。 */
function masterKeyBytes() {
  const raw = Buffer.from(config.masterKey || "minuteflow-default-master-key", "utf8");
  return raw.length === 32 ? raw : createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKeyBytes(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(packed) {
  const [ivText, tagText, dataText] = String(packed ?? "").split(":");
  const decipher = createDecipheriv("aes-256-gcm", masterKeyBytes(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
}

/**
 * 为已支付订单签发激活码（订单事务内幂等：同订单重复调用返回同一张码）。
 */
export function issueLicenseForOrder(order) {
  return transaction(() => {
    const existing = db.prepare("SELECT * FROM licenses WHERE order_id = ?").get(order.id);
    if (existing) return existing;
    const id = randomUUID();
    const key = generateLicenseKey();
    const issued = db.prepare(`
      INSERT INTO licenses (id, key_hash, key_encrypted, order_id, state, issued_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(id, licenseKeyHash(key), encryptSecret(key), order.id, nowIso());
    db.prepare("UPDATE orders SET license_id = ?, updated_at = ? WHERE id = ?")
      .run(id, nowIso(), order.id);
    void issued;
    return db.prepare("SELECT * FROM licenses WHERE id = ?").get(id);
  });
}

export function findLicenseByNormalizedKey(normalizedKey) {
  return db.prepare("SELECT * FROM licenses WHERE key_hash = ?").get(licenseKeyHash(normalizedKey));
}

export function licensePlaintext(license) {
  try {
    return decryptSecret(license.key_encrypted);
  } catch {
    return "";
  }
}
