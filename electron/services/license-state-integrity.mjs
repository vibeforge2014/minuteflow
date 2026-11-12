/**
 * 授权状态文件的完整性原语（纯函数，便于单测）。
 * 密钥由调用方从加密密钥库取；状态文件本身只存签名，不存密钥。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** 键名排序后序列化，避免属性顺序变化让同一份状态算出不同签名。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function signLicenseState(payload, key) {
  if (!key) return "";
  return createHmac("sha256", key).update(stableStringify(payload)).digest("hex");
}

export function verifyLicenseStateSignature(payload, signature, key) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = signLicenseState(payload, key);
  if (!expected) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** 把读到的 JSON 拆成「被签名内容」与签名本身。 */
export function splitSignedState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { payload: {}, signature: "" };
  const { signature, ...payload } = raw;
  return { payload, signature: typeof signature === "string" ? signature : "" };
}
