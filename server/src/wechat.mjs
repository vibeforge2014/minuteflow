/**
 * 微信支付 APIv3（Native 扫码支付）。零依赖实现：
 * - 请求签名：商户私钥 SHA256-with-RSA，Authorization 头按官方 v3 规范组装；
 * - 回调验签：微信支付公钥模式（或平台证书）验证 Wechatpay-Signature；
 * - 回调解密：AES-256-GCM（APIv3 密钥）解出 resource。
 * 参考：https://pay.weixin.qq.com/docs/merchant/development/interface-rules/basic-rules.html
 */
import { createDecipheriv, createSign, createVerify, randomUUID } from "node:crypto";
import { config } from "./config.mjs";

const API_BASE = "https://api.mch.weixin.qq.com";

function asPem(text, label) {
  return text.includes("BEGIN") ? text : `-----BEGIN ${label}-----\n${text.replace(/\s+/g, "")}\n-----END ${label}-----\n`;
}

/** APIv3 请求签名：串为「METHOD\nURL路径+查询\n时间戳\n随机串\n正文\n」。 */
function buildAuthorization(method, urlPathWithQuery, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID().replace(/-/g, "");
  const message = `${method.toUpperCase()}\n${urlPathWithQuery}\n${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = createSign("RSA-SHA256")
    .update(message)
    .sign(asPem(config.wechat.privateKey, "PRIVATE KEY"), "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.wechat.mchid}",nonce_str="${nonce}",timestamp="${timestamp}",signature="${signature}",serial_no="${config.wechat.serialNo}"`;
}

async function v3Request(method, urlPathWithQuery, bodyObject) {
  const bodyText = bodyObject ? JSON.stringify(bodyObject) : "";
  const response = await fetch(`${API_BASE}${urlPathWithQuery}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "MinuteFlow-License/1.0",
      Authorization: buildAuthorization(method, urlPathWithQuery, bodyText)
    },
    body: bodyText || undefined,
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const detail = payload.message || payload.code || text.slice(0, 200);
    throw new Error(`微信支付接口请求失败（HTTP ${response.status}）：${detail}`);
  }
  return payload;
}

/**
 * Native 下单：返回 weixin:// 二维码内容（code_url）。
 */
export async function createNativeOrder({ outTradeNo, description, amountFen, expiresAt }) {
  const payload = await v3Request("POST", "/v3/pay/transactions/native", {
    appid: config.wechat.appid,
    mchid: config.wechat.mchid,
    description,
    out_trade_no: outTradeNo,
    time_expire: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    notify_url: `${config.publicBaseUrl}/api/license/webhooks/wechat`,
    amount: { total: amountFen, currency: config.currency }
  });
  if (!payload.code_url) throw new Error("微信支付未返回二维码链接（code_url）。");
  return payload.code_url;
}

/** 主动查单：轮询补偿/对账用。返回微信侧订单对象（含 trade_state）。 */
export async function queryOrderByOutTradeNo(outTradeNo) {
  const query = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${config.wechat.mchid}`;
  return v3Request("GET", query, null);
}

/** 全额退款（v3/refund/domestic/refunds）。同 out_refund_no 重复调用幂等。 */
export async function createRefund({ outTradeNo, refundNo, amountFen, reason }) {
  const payload = await v3Request("POST", "/v3/refund/domestic/refunds", {
    out_trade_no: outTradeNo,
    out_refund_no: refundNo,
    reason: reason || "用户退款",
    notify_url: `${config.publicBaseUrl}/api/license/webhooks/wechat`,
    amount: { refund: amountFen, total: amountFen, currency: config.currency }
  });
  return payload; // { refund_id, status: "SUCCESS"|"PROCESSING"|"ABNORMAL", ... }
}

/** AES-256-GCM 解密回调 resource（APIv3 key 必须 32 字节）。密文尾部 16 字节是 auth tag。 */
export function decryptResource(apiv3Key, { nonce, ciphertext, associated_data: associatedData }) {
  if (String(apiv3Key).length !== 32) throw new Error("APIv3 密钥长度必须为 32 字节。");
  const buffer = Buffer.from(ciphertext, "base64");
  const authTag = buffer.subarray(buffer.length - 16);
  const data = buffer.subarray(0, buffer.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiv3Key, "utf8"), Buffer.from(nonce, "utf8"));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData ?? "", "utf8"));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * 回调验签：微信把签名放在 Wechatpay-Signature（裸 base64，不是 k="v" 串——
 * 那是商户请求 Authorization 头的格式），时间戳/nonce 在独立的
 * Wechatpay-Timestamp / Wechatpay-Nonce 头。验签串
 * 「timestamp\nnonce\nbody\n」用微信支付平台公钥做 SHA256-RSA 验证。
 * 头缺失或验签失败一律返回 false（调用方回 401 让微信重投）。
 */
export function verifyNotifySignature(headers, rawBody) {
  const signature = String(headers["wechatpay-signature"] ?? "").trim();
  const timestamp = String(headers["wechatpay-timestamp"] ?? "").trim();
  const nonce = String(headers["wechatpay-nonce"] ?? "").trim();
  if (!signature || !timestamp || !nonce) return false;
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  try {
    return createVerify("RSA-SHA256")
      .update(message)
      .verify(asPem(config.wechat.platformPublicKey, "PUBLIC KEY"), signature, "base64");
  } catch {
    return false;
  }
}
