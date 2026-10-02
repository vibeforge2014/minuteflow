/**
 * 支付宝通道（零依赖实现）：当面付 precreate 扫码 + 电脑网站支付 page.pay 跳转。
 * - 系统参数组装 + 应用私钥 RSA2（SHA256-with-RSA）签名；
 * - 异步通知（form 表单）用支付宝公钥验签；
 * - 网关可切沙箱（ALIPAY_GATEWAY）。
 * 参考：https://opendocs.alipay.com/open/02ekfg
 */
import { createSign, createVerify } from "node:crypto";
import { config } from "./config.mjs";

function asPem(text, label) {
  return text.includes("BEGIN") ? text : `-----BEGIN ${label}-----\n${text.replace(/\s+/g, "")}\n-----END ${label}-----\n`;
}

/** 支付宝网关要求 yyyy-MM-dd HH:mm:ss（东八区、零填充）；toLocaleString("zh-CN") 会产出斜杠格式被 invalid-timestamp 拒绝。 */
function alipayTimestamp() {
  const d = new Date(Date.now() + 8 * 3_600_000); // 平移到东八区后按 UTC 字段读取
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 支付宝签名串：所有业务与公共参数（不含 sign/sign_type）按 key 字典序 k=v& 拼接。 */
function canonicalQuery(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== "" && key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

function signParams(params) {
  return createSign("RSA-SHA256")
    .update(canonicalQuery(params), "utf8")
    .sign(asPem(config.alipay.privateKey, "PRIVATE KEY"), "base64");
}

/**
 * 调用支付宝 OpenAPI（GET，参数走 query）。返回去除了 alipay 壳的业务响应，
 * 业务码非 10000 时抛错。
 */
async function openApi(method, bizContent, extra = {}) {
  const params = {
    app_id: config.alipay.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTimestamp(),
    version: "1.0",
    notify_url: `${config.publicBaseUrl}/api/license/webhooks/alipay`,
    ...extra,
    biz_content: JSON.stringify(bizContent)
  };
  params.sign = signParams(params);
  const query = Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
  const response = await fetch(`${config.alipay.gateway}/gateway.do?${query}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  const shellKey = method.replace(/\./g, "_") + "_response";
  const body = payload[shellKey];
  if (!response.ok || !body) throw new Error(`支付宝接口请求失败（HTTP ${response.status}）。`);
  if (body.code && body.code !== "10000") {
    throw new Error(`支付宝接口失败（${body.code} ${body.msg}${body.sub_msg ? "：" + body.sub_msg : ""}）。`);
  }
  return body;
}

/** 当面付预下单：返回二维码内容 qr_code。 */
export async function createPrecreateOrder({ outTradeNo, subject, amountFen, expiresAt }) {
  const body = await openApi("alipay.trade.precreate", {
    out_trade_no: outTradeNo,
    total_amount: (amountFen / 100).toFixed(2),
    subject,
    timeout_express: `${Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000))}m`
  });
  if (!body.qr_code) throw new Error("支付宝未返回二维码链接（qr_code）。");
  return body.qr_code;
}

/**
 * 电脑网站支付（alipay.trade.page.pay）：返回已签名的收银台跳转 URL。
 * 用户浏览器整页跳转到支付宝收银台（桌面端内呈现扫码/登录），付款后经
 * return_url 回购买页继续轮询，落账仍以 notify_url 异步通知 + 主动查单为准。
 */
export function createPagePayUrl({ outTradeNo, subject, amountFen, returnUrl }) {
  const params = {
    app_id: config.alipay.appId,
    method: "alipay.trade.page.pay",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTimestamp(),
    version: "1.0",
    notify_url: `${config.publicBaseUrl}/api/license/webhooks/alipay`,
    return_url: returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      product_code: "FAST_INSTANT_TRADE_PAY",
      total_amount: (amountFen / 100).toFixed(2),
      subject
    })
  };
  params.sign = signParams(params);
  const query = Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
  return `${config.alipay.gateway}/gateway.do?${query}`;
}

/** 主动查单（对账补偿）。 */
export async function queryOrderByOutTradeNo(outTradeNo) {
  return openApi("alipay.trade.query", { out_trade_no: outTradeNo });
}

/** 全额退款（alipay.trade.refund）。同 out_request_no 重复调用幂等。 */
export async function createRefund({ outTradeNo, refundNo, amountFen, reason }) {
  return openApi("alipay.trade.refund", {
    out_trade_no: outTradeNo,
    refund_amount: (amountFen / 100).toFixed(2),
    out_request_no: refundNo,
    refund_reason: reason || "用户退款"
  });
}

/**
 * 异步通知验签：form 表单里的全部字段（除 sign、sign_type）按字典序拼接，
 * 用支付宝公钥验 sign。任何字段缺失或验签失败返回 false。
 */
export function verifyNotifySignature(form) {
  const sign = form?.sign;
  if (!sign) return false;
  try {
    return createVerify("RSA-SHA256")
      .update(canonicalQuery(form), "utf8")
      .verify(asPem(config.alipay.alipayPublicKey, "PUBLIC KEY"), sign, "base64");
  } catch {
    return false;
  }
}
