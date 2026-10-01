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
import { config, channelReady } from "./config.mjs";
import { db, nowIso, transaction } from "./db.mjs";
import { findLicenseByNormalizedKey, normalizeLicenseKey } from "./licenses.mjs";
import { createOrder, getOrderView, handlePaidNotification } from "./orders.mjs";
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
    // 购买页据此渲染可用通道（只暴露布尔就绪态，不含任何商户信息）。
    sendJson(res, 200, {
      ok: true,
      productId: config.productId,
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
      const view = await createOrder(channel);
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
