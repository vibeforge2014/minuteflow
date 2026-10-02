/**
 * 支付/授权后端行为测试（node:test，npm run test:license）：
 * 激活码生成/归一/加密、mock 下单→自动落账→出码→验证、设备绑定上限与指纹复用、
 * 微信/支付宝回调验签（自生成 RSA 测试密钥，不依赖真实商户）与幂等、
 * 订单过期状态机、退款吊销、下单限流。协议断言与 electron/services/licensing.mjs 对齐。
 */
import assert from "node:assert/strict";
import { createCipheriv, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LICENSE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "lic-")), "license.sqlite");
process.env.LICENSE_PORT = "0";
delete process.env.WECHAT_MCHID;
delete process.env.ALIPAY_APP_ID;
delete process.env.LICENSE_MOCK_ENABLED;

const { config } = await import("../server/src/config.mjs");
const {
  generateLicenseKey, normalizeLicenseKey, licenseKeyHash, encryptSecret, decryptSecret
} = await import("../server/src/licenses.mjs");
const { db } = await import("../server/src/db.mjs");
const { createOrder, markRefunded } = await import("../server/src/orders.mjs");
const { createLicenseServer, resetOrderRateLimiter } = await import("../server/src/index.mjs");

const server = createLicenseServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

// ---------------------------------------------------------------------------
// 激活码：生成、归一、哈希、静态加密
// ---------------------------------------------------------------------------
test("license keys generate in MF-XXXX-XXXX-XXXX-XXXX form and normalize from user input variants", () => {
  const key = generateLicenseKey();
  assert.match(key, /^MF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeLicenseKey(key), key);
  assert.equal(normalizeLicenseKey(key.toLowerCase()), key);
  assert.equal(normalizeLicenseKey(key.replace(/-/g, "")), key); // 裸 16 字符自动补前缀分组
  assert.equal(normalizeLicenseKey(" mf - xxxx / yyyy"), null);
  assert.equal(normalizeLicenseKey("MF-AAAA-BBBB-CCCC-DDDI"), null); // I 不在 Crockford 表
  assert.equal(normalizeLicenseKey("MF-AAAA-BBBB-CCCC-DDDD"), "MF-AAAA-BBBB-CCCC-DDDD");
  assert.notEqual(licenseKeyHash("MF-AAAA-BBBB-CCCC-DDDD"), licenseKeyHash("MF-AAAA-BBBB-CCCC-DDDE"));
});

test("license secrets round-trip through AES-256-GCM", () => {
  const packed = encryptSecret("MF-8DNA-JA5K-6V2E-9TGM");
  assert.notEqual(packed, "MF-8DNA-JA5K-6V2E-9TGM");
  assert.equal(decryptSecret(packed), "MF-8DNA-JA5K-6V2E-9TGM");
});

// ---------------------------------------------------------------------------
// HTTP 基础协议
// ---------------------------------------------------------------------------
async function postJson(pathname, body, headers = {}) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("healthz responds", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).productId, "minuteflow-desktop");
});

test("order creation rejects unknown channels and unconfigured real channels", async () => {
  assert.equal((await postJson("/api/license/orders", { channel: "visa" })).status, 400);
  const wechat = await postJson("/api/license/orders", { channel: "wechat" });
  assert.equal(wechat.status, 503);
  assert.match(wechat.body.error, /微信支付/);
});

// ---------------------------------------------------------------------------
// mock 通道：下单 → 3s 自动落账 → 出码 → 验证
// ---------------------------------------------------------------------------
test("mock channel auto-pays and issues a verifiable license", async () => {
  const created = await postJson("/api/license/orders", { channel: "mock" });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "created");
  assert.equal(created.body.type, "qr");
  assert.equal(created.body.amountFen, 9900);
  assert.ok(created.body.payload.startsWith("mock://pay/"));
  assert.ok(!("licenseKey" in created.body), "未支付视图绝不携带激活码");

  let paid = null;
  for (let attempt = 0; attempt < 20 && !paid; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const view = await (await fetch(`${base}/api/license/orders/${created.body.orderId}`)).json();
    if (view.state === "paid") paid = view;
  }
  assert.ok(paid, "mock 订单应在 3 秒后自动落账");
  assert.match(paid.licenseKey, /^MF-/);

  const first = await postJson("/api/license/verify", {
    licenseKey: paid.licenseKey, deviceId: "d1", machineFingerprint: "fp-1",
    productId: "minuteflow-desktop", appVersion: "0.1.25-test", platform: "darwin", architecture: "arm64"
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.valid, true);
  assert.ok(first.body.entitlementId);
});

// ---------------------------------------------------------------------------
// verify 协议：401/410 终态、设备上限 200+valid:false、指纹复用
// ---------------------------------------------------------------------------
test("verify maps unknown keys to terminal 401", async () => {
  const result = await postJson("/api/license/verify", {
    licenseKey: "MF-WWWW-XXXX-YYYY-ZZZZ", deviceId: "d", machineFingerprint: "fp"
  });
  assert.equal(result.status, 401);
  assert.equal(result.body.valid, false);
});

test("verify enforces the device cap but reuses the slot for a reinstalled fingerprint", async () => {
  const created = await postJson("/api/license/orders", { channel: "mock" });
  let key = "";
  for (let attempt = 0; attempt < 20 && !key; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const view = await (await fetch(`${base}/api/license/orders/${created.body.orderId}`)).json();
    if (view.state === "paid") key = view.licenseKey;
  }
  assert.ok(key);

  assert.equal((await postJson("/api/license/verify", { licenseKey: key, machineFingerprint: "mac-a" })).status, 200);
  assert.equal((await postJson("/api/license/verify", { licenseKey: key, machineFingerprint: "mac-b" })).status, 200);

  const third = await postJson("/api/license/verify", { licenseKey: key, machineFingerprint: "mac-c" });
  // 200 + valid:false：客户端 licensing.mjs 只在 200 响应读取 message，需透出上限原因。
  assert.equal(third.status, 200);
  assert.equal(third.body.valid, false);
  assert.match(third.body.message, /已达上限|达到上限/);

  // 同机重装：同指纹新 deviceId 仍有效，且不新增绑定。
  const again = await postJson("/api/license/verify", { licenseKey: key, machineFingerprint: "mac-a", deviceId: "fresh-install" });
  assert.equal(again.status, 200);
  assert.equal(again.body.valid, true);
  const bindings = db.prepare("SELECT COUNT(*) AS n FROM device_bindings b JOIN licenses l ON l.id = b.license_id WHERE l.key_hash = ?")
    .get(licenseKeyHash(normalizeLicenseKey(key))).n;
  assert.equal(bindings, 2);
});

test("refunded orders revoke the license to terminal 410", async () => {
  const created = await createOrder("mock");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (db.prepare("SELECT state FROM orders WHERE id = ?").get(created.orderId).state === "paid") break;
  }
  const paid = await (await fetch(`${base}/api/license/orders/${created.orderId}`)).json();
  assert.ok(paid.licenseKey);
  markRefunded(created.orderId, { refundId: "RF-TEST", amountFen: 9900, reason: "test" });
  const result = await postJson("/api/license/verify", { licenseKey: paid.licenseKey, machineFingerprint: "fp-x" });
  assert.equal(result.status, 410);
  assert.equal(result.body.valid, false);
  const orderView = await (await fetch(`${base}/api/license/orders/${created.orderId}`)).json();
  assert.equal(orderView.state, "refunded");
  assert.ok(!orderView.licenseKey, "退款后轮询视图不再暴露激活码");
});

// ---------------------------------------------------------------------------
// 微信回调：自生成 RSA 平台密钥验签 + AES-GCM 解密 + 幂等
// ---------------------------------------------------------------------------
function insertManualOrder(channel, outTradeNo) {
  const id = randomUUID();
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO orders (id, channel, out_trade_no, amount_fen, state, qr_payload, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 9900, 'created', '', ?, ?, ?)
  `).run(id, channel, outTradeNo, expires, new Date().toISOString(), new Date().toISOString());
  return id;
}

function wechatSignedNotification(privateKeyPem, notification) {
  // 与微信支付真实回调一致：签名是裸 base64，timestamp/nonce 在独立请求头。
  const raw = JSON.stringify(notification);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString("hex");
  const signature = createSign("RSA-SHA256").update(`${timestamp}\n${nonce}\n${raw}\n`).sign(privateKeyPem, "base64");
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": nonce,
      "wechatpay-serial": "PUB_KEY_ID_TEST",
      "wechatpay-signature": signature
    }
  };
}

function encryptWechatResource(apiv3Key, plainObject) {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiv3Key, "utf8"), Buffer.from("abcdefghijkl", "utf8"));
  cipher.setAAD(Buffer.from("transaction", "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(plainObject), "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"),
    nonce: "abcdefghijkl",
    associated_data: "transaction"
  };
}

test("wechat webhook: valid signature pays the order once; tampered and duplicate payloads are safe", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platformPublicPem = publicKey.export({ type: "spki", format: "pem" });
  const platformPrivatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const apiv3Key = "0123456789abcdef0123456789abcdef";
  config.wechat.platformPublicKey = platformPublicPem;
  config.wechat.apiv3Key = apiv3Key;

  const outTradeNo = `MFTEST${Date.now()}`;
  const orderId = insertManualOrder("wechat", outTradeNo);
  const notification = {
    id: `notify-${outTradeNo}`,
    event_type: "TRANSACTION.SUCCESS",
    resource: encryptWechatResource(apiv3Key, { out_trade_no: outTradeNo, transaction_id: "wx-txn-1", trade_state: "SUCCESS" })
  };
  const signed = wechatSignedNotification(platformPrivatePem, notification);

  const ok = await fetch(`${base}/api/license/webhooks/wechat`, { method: "POST", headers: signed.headers, body: signed.raw });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).code, "SUCCESS");
  assert.equal(db.prepare("SELECT state FROM orders WHERE id = ?").get(orderId).state, "paid");

  // 重投同一通知：幂等，不重复发码。
  const repeat = await fetch(`${base}/api/license/webhooks/wechat`, { method: "POST", headers: signed.headers, body: signed.raw });
  assert.equal(repeat.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE order_id = ?").get(orderId).n, 1);

  // 验签失败：改动密文首字符（业务字段在密文里，改原始 JSON 可见部分才影响签名串）。
  const tampered = await fetch(`${base}/api/license/webhooks/wechat`, {
    method: "POST",
    headers: signed.headers,
    body: signed.raw.replace(/"ciphertext":"(.)/, (match, first) => match.replace(first, first === "A" ? "B" : "A"))
  });
  assert.equal(tampered.status, 401);

  // 缺头：直接拒绝。
  const noHeader = await fetch(`${base}/api/license/webhooks/wechat`, { method: "POST", body: signed.raw });
  assert.equal(noHeader.status, 401);

  // 发出的码能通过验证。
  const license = db.prepare("SELECT * FROM licenses WHERE order_id = ?").get(orderId);
  const result = await postJson("/api/license/verify", { licenseKey: decryptSecret(license.key_encrypted), machineFingerprint: "fp-wechat" });
  assert.equal(result.body.valid, true);
});

test("wechat webhook ignores non-success trade states but acks", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  config.wechat.platformPublicKey = publicKey.export({ type: "spki", format: "pem" });
  const platformPrivatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const apiv3Key = "0123456789abcdef0123456789abcdef";
  config.wechat.apiv3Key = apiv3Key;
  const outTradeNo = `MFOTHER${Date.now()}`;
  const orderId = insertManualOrder("wechat", outTradeNo);
  const notification = {
    id: `notify-${outTradeNo}`,
    event_type: "TRANSACTION.SUCCESS",
    resource: encryptWechatResource(apiv3Key, { out_trade_no: outTradeNo, trade_state: "NOTPAY" })
  };
  const signed = wechatSignedNotification(platformPrivatePem, notification);
  const response = await fetch(`${base}/api/license/webhooks/wechat`, { method: "POST", headers: signed.headers, body: signed.raw });
  assert.equal(response.status, 200);
  assert.equal(db.prepare("SELECT state FROM orders WHERE id = ?").get(orderId).state, "created");
});

// ---------------------------------------------------------------------------
// 支付宝回调：表单 RSA2 验签 + success 文本 + 幂等
// ---------------------------------------------------------------------------
function alipayCanonical(form) {
  return Object.keys(form)
    .filter((key) => form[key] !== "" && form[key] !== undefined && key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => `${key}=${form[key]}`)
    .join("&");
}

test("alipay webhook: signed TRADE_SUCCESS pays once; tampered form rejected", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  config.alipay.alipayPublicKey = publicKey.export({ type: "spki", format: "pem" });
  const appPrivatePem = privateKey.export({ type: "pkcs8", format: "pem" });

  const outTradeNo = `MFALI${Date.now()}`;
  const orderId = insertManualOrder("alipay", outTradeNo);
  const form = {
    out_trade_no: outTradeNo,
    trade_no: "ali-txn-1",
    trade_status: "TRADE_SUCCESS",
    total_amount: "99.00",
    notify_id: `ali-notify-${outTradeNo}`,
    notify_type: "trade_status_sync"
  };
  form.sign = createSign("RSA-SHA256").update(alipayCanonical(form), "utf8").sign(appPrivatePem, "base64");
  const bodyText = new URLSearchParams(form).toString();

  const ok = await fetch(`${base}/api/license/webhooks/alipay`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: bodyText
  });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "success");
  assert.equal(db.prepare("SELECT state FROM orders WHERE id = ?").get(orderId).state, "paid");

  const repeat = await fetch(`${base}/api/license/webhooks/alipay`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: bodyText
  });
  assert.equal(await repeat.text(), "success");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE order_id = ?").get(orderId).n, 1);

  const tamperedForm = { ...form, trade_no: "ali-txn-hacked" };
  const tampered = await fetch(`${base}/api/license/webhooks/alipay`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tamperedForm).toString()
  });
  assert.equal(tampered.status, 401);
});

// ---------------------------------------------------------------------------
// 订单过期状态机
// ---------------------------------------------------------------------------
test("created orders flip to expired after their TTL on poll", async () => {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO orders (id, channel, out_trade_no, amount_fen, state, qr_payload, expires_at, created_at, updated_at)
    VALUES (?, 'wechat', ?, 9900, 'created', '', ?, ?, ?)
  `).run(id, `MFEXP${Date.now()}`, new Date(Date.now() - 1_000).toISOString(), new Date().toISOString(), new Date().toISOString());
  const view = await (await fetch(`${base}/api/license/orders/${id}`)).json();
  assert.equal(view.state, "expired");
  assert.ok(!view.licenseKey);
  assert.equal((await fetch(`${base}/api/license/orders/${randomUUID()}`)).status, 404);
});

// ---------------------------------------------------------------------------
// 下单限流
// ---------------------------------------------------------------------------
test("order creation is rate limited per IP", async () => {
  resetOrderRateLimiter();
  config.orderRateLimit = { windowMs: 60_000, max: 2 };
  const statuses = [];
  for (let index = 0; index < 3; index += 1) {
    statuses.push((await postJson("/api/license/orders", { channel: "mock" })).status);
  }
  assert.deepEqual(statuses, [201, 201, 429]);
  config.orderRateLimit = { windowMs: 60_000, max: 5 };
  resetOrderRateLimiter();
});
