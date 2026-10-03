/**
 * 授权/支付后端入口（node:http，零 npm 依赖，Node 22+）。
 * nginx 反代 https://zensoft.top/api/license/* → 127.0.0.1:8787：
 *   POST /api/license/orders          创建订单 {channel:"wechat"|"alipay"|"mock"}
 *   GET  /api/license/orders/:id      购买页轮询（paid 时携带 licenseKey）
 *   POST /api/license/webhooks/wechat 微信支付回调（验签 + AES-GCM 解密 + 幂等落账）
 *   POST /api/license/webhooks/alipay 支付宝异步通知（表单验签 + 幂等落账）
 *   POST /api/license/verify          应用激活验证（协议与客户端 licensing.mjs 一致）
 *   GET  /healthz                     存活探针
 *
 * 状态码语义（客户端将 401/403/410 视为终态无效、不进入离线宽限）：
 *   401 激活码不存在/格式无效；410 已撤销（退款）；设备超限走 200 + valid:false
 *   （客户端只对 200 响应读取 message，这样才能把「已达设备上限」的原因透出）。
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { config, channelReady, mailReady } from "./config.mjs";
import { db, nowIso, transaction } from "./db.mjs";
import { findLicenseByNormalizedKey, licensePlaintext, normalizeLicenseKey } from "./licenses.mjs";
import { createOrder, getOrderView, handlePaidNotification, normalizeEmail, maskEmail } from "./orders.mjs";
import { sendMail } from "./mail.mjs";
import { decryptResource, verifyNotifySignature as verifyWechatSignature } from "./wechat.mjs";
import { verifyNotifySignature as verifyAlipaySignature } from "./alipay.mjs";

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

/** 本地联调放行：官网与 API 生产同域不需要 CORS；仅回显 localhost 源（vite 开发服务器）。 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return {};
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 下单接口按 IP 限流（内存即可：单进程 systemd 服务，窗口短）。 */
const orderHitsByIp = new Map();
function allowOrderFromIp(ip) {
  const now = Date.now();
  const { windowMs, max } = config.orderRateLimit;
  const hits = (orderHitsByIp.get(ip) ?? []).filter((time) => now - time < windowMs);
  if (hits.length >= max) {
    orderHitsByIp.set(ip, hits);
    return false;
  }
  hits.push(now);
  orderHitsByIp.set(ip, hits);
  if (orderHitsByIp.size > 10_000) {
    for (const [key, list] of orderHitsByIp) {
      if (list.every((time) => now - time >= windowMs)) orderHitsByIp.delete(key);
    }
  }
  return true;
}

/** 测试钩子：清空限流窗口。 */
export function resetOrderRateLimiter() {
  orderHitsByIp.clear();
}

/** 滑动窗口通用限流（内存，单进程服务够用；超出阈值返回 false 并记账）。 */
function slidingWindowAllow(map, key, max, windowMs) {
  const now = Date.now();
  const hits = (map.get(key) ?? []).filter((time) => now - time < windowMs);
  if (hits.length >= max) {
    map.set(key, hits);
    return false;
  }
  hits.push(now);
  map.set(key, hits);
  if (map.size > 10_000) {
    for (const [k, list] of map) {
      if (list.every((time) => now - time >= windowMs)) map.delete(k);
    }
  }
  return true;
}

// 反激活释放限流：每激活码 24h 最多 4 次，防止持码者无限轮换设备占用绑定槽。
const releaseHitsByKey = new Map();
function allowReleaseForKey(keyHash) {
  return slidingWindowAllow(releaseHitsByKey, keyHash, 4, 24 * 3_600_000);
}

// 找回限流：每 IP 每小时 5 次、每邮箱每小时 3 次（找回邮件是外发副作用，须防刷）。
const recoverHitsByIp = new Map();
const recoverHitsByEmail = new Map();
function allowRecoverFromIp(ip) {
  return slidingWindowAllow(recoverHitsByIp, ip, 5, 3_600_000);
}
function allowRecoverForEmail(email) {
  return slidingWindowAllow(recoverHitsByEmail, email, 3, 3_600_000);
}

/** 测试钩子：清空 release/recover 限流窗口。 */
export function resetRecoveryLimiters() {
  releaseHitsByKey.clear();
  recoverHitsByIp.clear();
  recoverHitsByEmail.clear();
}

/** 找回邮件正文：全部 active 激活码 + 签发日期 + 支持邮箱。 */
function recoveryEmailHtml(email, licenses) {
  const rows = licenses.map((license) => {
    const key = licensePlaintext(license) || "（读取失败，请回复本邮件人工处理）";
    return `<tr><td style="padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:.5px;color:#b3502f;font-weight:600;">${key}</td><td style="padding:8px 12px;color:#6b625c;">${license.issued_at.slice(0, 10)}</td></tr>`;
  }).join("");
  return `
<div style="max-width:520px;margin:0 auto;padding:24px;font-family:-apple-system,'PingFang SC','Helvetica Neue',sans-serif;color:#2a2320;">
  <h2 style="margin:0 0 4px;font-size:18px;">MinuteFlow 激活码找回</h2>
  <p style="margin:0 0 16px;color:#6b625c;font-size:13px;">应 ${email} 的请求发送。若非本人操作请忽略本邮件。</p>
  <table style="border-collapse:collapse;width:100%;background:#fdf6f2;border:1px solid #f3ddd2;border-radius:8px;">
    <tr><th align="left" style="padding:8px 12px;color:#9a8f88;font-size:12px;font-weight:500;">激活码</th><th align="left" style="padding:8px 12px;color:#9a8f88;font-size:12px;font-weight:500;">签发日期</th></tr>
    ${rows}
  </table>
  <p style="margin:16px 0 0;font-size:13px;line-height:1.7;color:#4a423d;">
    在 MinuteFlow 桌面应用「解锁 → 输入激活码」中粘贴即可。每个激活码最多绑定 2 台设备；
    换设备时先在「设置 → 通用 → 授权」停用本机。如有问题联系
    <a href="mailto:xhdp123@126.com" style="color:#b3502f;">xhdp123@126.com</a>。
  </p>
</div>`;
}

function clientIp(req) {
  // nginx 反代注入 X-Forwarded-For；直连（本地/健康检查）时用 socket 地址。
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ---------------------------------------------------------------------------
// POST /api/license/verify —— 与 electron/services/licensing.mjs 的协议逐字段对齐
// ---------------------------------------------------------------------------
function handleVerify(res, bodyText) {
  let body = {};
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    sendJson(res, 400, { valid: false, message: "请求格式错误。" });
    return;
  }
  const { licenseKey, deviceId, machineFingerprint, productId, appVersion, platform, architecture } = body;
  if (!licenseKey || !machineFingerprint) {
    sendJson(res, 400, { valid: false, message: "缺少激活码或设备指纹。" });
    return;
  }
  if (productId && productId !== config.productId) {
    sendJson(res, 403, { valid: false, message: "激活码与当前产品不匹配。" });
    return;
  }
  const normalized = normalizeLicenseKey(licenseKey);
  const license = normalized ? findLicenseByNormalizedKey(normalized) : null;
  if (!license) {
    sendJson(res, 401, { valid: false, message: "激活码无效。" });
    return;
  }
  if (license.state === "revoked") {
    sendJson(res, 410, { valid: false, message: "激活码已被撤销（订单已退款）。" });
    return;
  }
  if (license.state !== "active") {
    sendJson(res, 410, { valid: false, message: "激活码状态异常。" });
    return;
  }
  const fingerprint = String(machineFingerprint).slice(0, 256);
  let overLimit = false;
  transaction(() => {
    const existing = db.prepare(
      "SELECT * FROM device_bindings WHERE license_id = ? AND machine_fingerprint = ?"
    ).get(license.id, fingerprint);
    if (existing) {
      // 同机重装/重激活：指纹复用同一绑定槽，只刷新心跳与设备信息。
      db.prepare(`
        UPDATE device_bindings
        SET device_id = ?, app_version = ?, platform = ?, architecture = ?, last_seen_at = ?
        WHERE id = ?
      `).run(String(deviceId ?? existing.device_id).slice(0, 256), String(appVersion ?? "").slice(0, 64),
        String(platform ?? "").slice(0, 32), String(architecture ?? "").slice(0, 32), nowIso(), existing.id);
      return;
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM device_bindings WHERE license_id = ?").get(license.id).n;
    if (count >= config.maxDevicesPerLicense) {
      overLimit = true;
      return;
    }
    db.prepare(`
      INSERT INTO device_bindings (id, license_id, machine_fingerprint, device_id, platform, architecture, app_version, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), license.id, fingerprint, String(deviceId ?? "").slice(0, 256),
      String(platform ?? "").slice(0, 32), String(architecture ?? "").slice(0, 32),
      String(appVersion ?? "").slice(0, 64), nowIso(), nowIso());
  });
  if (overLimit) {
    // 200 + valid:false：客户端会展示服务器的 message（状态码 403 会丢弃原因）。
    sendJson(res, 200, {
      valid: false,
      message: `该激活码已绑定 ${config.maxDevicesPerLicense} 台设备，达到上限。请在已绑定的设备上使用，或联系 xhdp123@126.com 换绑。`
    });
    return;
  }
  sendJson(res, 200, {
    valid: true,
    customerEmail: license.customer_email || undefined,
    entitlementId: license.id,
    message: "ok"
  });
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------
async function route(req, res) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const pathname = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (pathname === "/healthz" || pathname === "/api/license/healthz")) {
    // 购买页据此渲染可用通道与当前售价（不含任何商户信息）。
    sendJson(res, 200, {
      ok: true,
      productId: config.productId,
      amountFen: config.amountFen,
      channels: { wechat: channelReady("wechat"), alipay: channelReady("alipay"), mock: channelReady("mock") }
    }, cors);
    return;
  }

  if (method === "POST" && pathname === "/api/license/orders") {
    if (!allowOrderFromIp(clientIp(req))) {
      sendJson(res, 429, { error: "下单过于频繁，请稍后再试。" }, cors);
      return;
    }
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const channel = body.channel;
      if (channel !== "wechat" && channel !== "alipay" && channel !== "mock") {
        sendJson(res, 400, { error: "不支持的支付通道。" }, cors);
        return;
      }
      if (!channelReady(channel)) {
        const label = channel === "mock" ? "沙箱通道未开放。" : `${channel === "wechat" ? "微信支付" : "支付宝"}通道尚未配置商户密钥，暂不可用。`;
        sendJson(res, 503, { error: label }, cors);
        return;
      }
      const view = await createOrder(channel, body.email);
      console.log(`[order] created ${view.orderId} channel=${channel} state=${view.state}`);
      sendJson(res, 201, view, cors);
    } catch (error) {
      console.error("[order] create failed:", error.message);
      sendJson(res, 502, { error: `下单失败：${error.message}` }, cors);
    }
    return;
  }

  const orderMatch = pathname.match(/^\/api\/license\/orders\/([0-9a-f-]{36})$/i);
  if (method === "GET" && orderMatch) {
    const view = await getOrderView(orderMatch[1]);
    if (!view) {
      sendJson(res, 404, { error: "订单不存在。" }, cors);
      return;
    }
    sendJson(res, 200, view, cors);
    return;
  }

  if (method === "POST" && pathname === "/api/license/webhooks/wechat") {
    let raw = "";
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, { code: "FAIL", message: "请求体无效。" });
      return;
    }
    if (!verifyWechatSignature(req.headers, raw)) {
      console.error("[webhook:wechat] 验签失败");
      // 4xx/5xx 微信会按衰减策略重投。
      sendJson(res, 401, { code: "FAIL", message: "签名验证失败。" });
      return;
    }
    let notification = {};
    try {
      notification = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { code: "FAIL", message: "通知格式错误。" });
      return;
    }
    try {
      if (notification.event_type === "TRANSACTION.SUCCESS" && notification.resource) {
        const resource = JSON.parse(decryptResource(config.wechat.apiv3Key, notification.resource));
        if (resource.trade_state === "SUCCESS") {
          const order = handlePaidNotification({
            channel: "wechat",
            eventId: notification.id,
            outTradeNo: resource.out_trade_no,
            transactionId: resource.transaction_id
          });
          if (!order) console.error(`[webhook:wechat] 未知商户单号：${resource.out_trade_no}`);
          else console.log(`[webhook:wechat] paid order=${order.id} txn=${resource.transaction_id}`);
        }
      }
      sendJson(res, 200, { code: "SUCCESS", message: "成功" });
    } catch (error) {
      console.error("[webhook:wechat] 处理失败:", error.message);
      sendJson(res, 500, { code: "FAIL", message: "处理失败。" });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/license/webhooks/alipay") {
    let raw = "";
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("failure");
      return;
    }
    const form = Object.fromEntries(new URLSearchParams(raw));
    if (!verifyAlipaySignature(form)) {
      console.error("[webhook:alipay] 验签失败");
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("failure");
      return;
    }
    try {
      if (form.trade_status === "TRADE_SUCCESS" || form.trade_status === "TRADE_FINISHED") {
        const order = handlePaidNotification({
          channel: "alipay",
          eventId: form.notify_id || `${form.out_trade_no}:${form.trade_no}`,
          outTradeNo: form.out_trade_no,
          transactionId: form.trade_no
        });
        if (!order) console.error(`[webhook:alipay] 未知商户单号：${form.out_trade_no}`);
        else console.log(`[webhook:alipay] paid order=${order.id} txn=${form.trade_no}`);
      }
      // 支付宝要求纯文本 success，否则最多重投 8 次。
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("success");
    } catch (error) {
      console.error("[webhook:alipay] 处理失败:", error.message);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("failure");
    }
    return;
  }

  if (method === "POST" && pathname === "/api/license/verify") {
    try {
      handleVerify(res, await readBody(req));
    } catch (error) {
      console.error("[verify] 处理失败:", error.message);
      sendJson(res, 500, { valid: false, message: "验证服务暂时不可用，请稍后再试。" }, cors);
    }
    return;
  }

  // 反激活：停用本机授权时释放服务端设备绑定槽位（换新机器不被 2 台上限卡住）。
  if (method === "POST" && pathname === "/api/license/release") {
    let body = {};
    try {
      body = JSON.parse(await readBody(req) || "{}");
    } catch {
      sendJson(res, 400, { error: "请求格式错误。" }, cors);
      return;
    }
    const normalized = normalizeLicenseKey(body.licenseKey ?? "");
    const fingerprint = String(body.machineFingerprint ?? "").trim().slice(0, 256);
    if (!normalized || !fingerprint) {
      sendJson(res, 400, { error: "参数缺失。" }, cors);
      return;
    }
    const license = findLicenseByNormalizedKey(normalized);
    if (!license) {
      sendJson(res, 401, { error: "激活码无效。" }, cors);
      return;
    }
    if (!allowReleaseForKey(license.key_hash)) {
      sendJson(res, 429, { error: "操作过于频繁，请稍后再试。" }, cors);
      return;
    }
    // 幂等：绑定不存在也返回成功，不向调用方泄露当前绑定状态。
    db.prepare("DELETE FROM device_bindings WHERE license_id = ? AND machine_fingerprint = ?")
      .run(license.id, fingerprint);
    console.log(`[release] license=${license.id.slice(0, 8)} released a device binding`);
    sendJson(res, 200, { released: true }, cors);
    return;
  }

  // 激活码找回：按购买邮箱把 active 激活码发回本人邮箱。防枚举 + 双重限流。
  if (method === "POST" && pathname === "/api/license/recover") {
    if (!mailReady()) {
      sendJson(res, 503, { error: "邮件服务暂未配置，请联系 xhdp123@126.com 找回激活码。" }, cors);
      return;
    }
    let body = {};
    try {
      body = JSON.parse(await readBody(req) || "{}");
    } catch {
      sendJson(res, 400, { error: "请求格式错误。" }, cors);
      return;
    }
    const email = normalizeEmail(body.email);
    if (!email) {
      sendJson(res, 400, { error: "请输入有效的邮箱地址。" }, cors);
      return;
    }
    if (!allowRecoverFromIp(clientIp(req))) {
      sendJson(res, 429, { error: "请求过于频繁，请稍后再试。" }, cors);
      return;
    }
    if (!allowRecoverForEmail(email)) {
      sendJson(res, 429, { error: "请求过于频繁，请稍后再试。" }, cors);
      return;
    }
    try {
      const licenses = db.prepare(
        "SELECT * FROM licenses WHERE customer_email = ? AND state = 'active' ORDER BY issued_at"
      ).all(email);
      if (licenses.length > 0) {
        await sendMail({ to: email, subject: "MinuteFlow 激活码找回", html: recoveryEmailHtml(email, licenses) });
        console.log(`[recover] sent ${licenses.length} key(s) to ${maskEmail(email)}`);
      } else {
        console.log(`[recover] no match for ${maskEmail(email)}`);
      }
    } catch (error) {
      // 发送失败也回通用成功：不能利用错误差异探测邮箱是否有购买记录。
      console.error("[recover] 发送失败:", error.message);
    }
    sendJson(res, 200, { sent: true }, cors);
    return;
  }

  sendJson(res, 404, { error: "接口不存在。" }, cors);
}

/** 构造服务实例（测试可直接 listen(0)），命令行运行时自动监听。 */
export function createLicenseServer() {
  return createServer((req, res) => {
    void route(req, res).catch((error) => {
      console.error("[http] 未捕获错误:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "服务内部错误。" });
      else res.end();
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createLicenseServer();
  server.listen(config.port, config.host, () => {
    console.log(`license service listening on ${config.host}:${config.port}`);
    console.log(`mock channel: ${config.mockEnabled ? "enabled" : "disabled"}, `
      + `wechat ready: ${channelReady("wechat")}, alipay ready: ${channelReady("alipay")}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
