/**
 * 订单状态机：created → paid（→ refunded），过期 → expired。
 * - 创建时按通道调微信 Native / 支付宝 precreate / mock 生成二维码内容；
 * - 支付回调（或 mock 定时器、轮询对账）落账并签发激活码；
 * - 全部状态变迁在事务内完成，重复通知天然幂等。
 */
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { db, nowIso, transaction } from "./db.mjs";
import { issueLicenseForOrder, licensePlaintext } from "./licenses.mjs";
import { createNativeOrder, queryOrderByOutTradeNo as queryWechat } from "./wechat.mjs";
import { createPagePayUrl, createPrecreateOrder, queryOrderByOutTradeNo as queryAlipay } from "./alipay.mjs";

const ORDER_DESCRIPTION = "MinuteFlow 会议助手 · 一次性买断授权";

function newOutTradeNo() {
  // 商户单号：日期 + 随机段，微信/支付宝侧唯一键。
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `MF${date}${randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase()}`;
}

/** 购买邮箱归一：小写去空白。选填字段：空或格式非法一律按未填（null）处理，不拦支付。 */
export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** 邮箱脱敏（对外视图）：qia***@126.com。 */
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  const head = local.slice(0, Math.min(3, Math.max(1, local.length - 1)));
  return `${head}***@${domain}`;
}

/** 创建订单并生成支付二维码。返回对外安全的订单视图。 */
export async function createOrder(channel, customerEmail) {
  const id = randomUUID();
  const outTradeNo = newOutTradeNo();
  const expiresAt = new Date(Date.now() + config.orderTtlMs);
  const email = normalizeEmail(customerEmail);
  let qrPayload = "";
  if (channel === "mock") {
    qrPayload = `mock://pay/${outTradeNo}`;
  } else if (channel === "wechat") {
    qrPayload = await createNativeOrder({
      outTradeNo, description: ORDER_DESCRIPTION, amountFen: config.amountFen, expiresAt
    });
  } else if (channel === "alipay") {
    if (config.alipay.product === "face") {
      qrPayload = await createPrecreateOrder({
        outTradeNo, subject: ORDER_DESCRIPTION, amountFen: config.amountFen, expiresAt
      });
    } else {
      // 电脑网站支付：返回收银台跳转 URL，return_url 带订单号回购买页续轮询。
      qrPayload = createPagePayUrl({
        outTradeNo, subject: ORDER_DESCRIPTION, amountFen: config.amountFen,
        returnUrl: `${config.publicBaseUrl}/minuteflow/buy/?order=${id}`
      });
    }
  } else {
    throw new Error("不支持的支付通道。");
  }
  db.prepare(`
    INSERT INTO orders (id, channel, out_trade_no, amount_fen, state, qr_payload, expires_at, created_at, updated_at, customer_email)
    VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)
  `).run(id, channel, outTradeNo, config.amountFen, qrPayload, expiresAt.toISOString(), nowIso(), nowIso(), email);
  if (channel === "mock") {
    // 沙箱通道：3 秒后自动支付成功，联调全链路（页面轮询会看到 created → paid）。
    // 定时器必须自捕获：finalizeOrder 是同步的，抛错会击穿进程。
    setTimeout(() => {
      try {
        finalizeOrder(id, { transactionId: `mock-${outTradeNo}` });
      } catch (error) {
        console.error(`[order] mock 自动支付失败 ${id}:`, error.message);
      }
    }, 3_000).unref?.();
  }
  return publicOrderView(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
}

/** 订单落账 + 签发激活码（事务内幂等：回调/查单/mock 三条来源可安全并发）。 */
export function finalizeOrder(orderId, { transactionId }) {
  return transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) throw new Error("订单不存在。");
    if (order.state === "paid" || order.state === "refunded") {
      return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    }
    db.prepare("UPDATE orders SET state = 'paid', transaction_id = ?, paid_at = ?, updated_at = ? WHERE id = ?")
      .run(transactionId, nowIso(), nowIso(), orderId);
    const paid = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    const license = issueLicenseForOrder(paid);
    // 发码时把购买邮箱带到 license（找回邮件按 licenses.customer_email 检索）。
    if (paid.customer_email && license && !license.customer_email) {
      db.prepare("UPDATE licenses SET customer_email = ? WHERE id = ?").run(paid.customer_email, license.id);
    }
    return paid;
  });
}

/** 处理一条支付成功通知（已通过通道验签）。按通道 + 事件 id 幂等。 */
export function handlePaidNotification({ channel, eventId, outTradeNo, transactionId }) {
  const dedupeKey = `${channel}:${eventId}`;
  if (db.prepare("SELECT id FROM webhook_events WHERE id = ?").get(dedupeKey)) {
    return db.prepare("SELECT * FROM orders WHERE out_trade_no = ?").get(outTradeNo) ?? null;
  }
  const order = db.prepare("SELECT * FROM orders WHERE out_trade_no = ?").get(outTradeNo);
  db.prepare("INSERT INTO webhook_events (id, channel, event_type, received_at) VALUES (?, ?, 'payment', ?)")
    .run(dedupeKey, channel, nowIso());
  if (!order) return null; // 未知单号：记日志由 webhook 层决定响应
  return finalizeOrder(order.id, { transactionId: transactionId || `${channel}:${eventId}` });
}

/** 订单视图：过期补状态；临期未支付时主动查单对账（返回前同步落账）。 */
export async function getOrderView(orderId) {
  let order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return null;
  if (order.state === "created" && Date.now() > Date.parse(order.expires_at)) {
    db.prepare("UPDATE orders SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'created'")
      .run(nowIso(), orderId);
    order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  }
  // created 且已过半衰期：主动查一次微信/支付宝，防止通知丢失导致页面干等。
  if (order.state === "created" && (order.channel === "wechat" || order.channel === "alipay")
    && Date.now() > Date.parse(order.expires_at) - config.orderTtlMs / 2) {
    try {
      const remote = order.channel === "wechat"
        ? await queryWechat(order.out_trade_no)
        : await queryAlipay(order.out_trade_no);
      const paid = order.channel === "wechat"
        ? remote?.trade_state === "SUCCESS"
        : remote?.trade_status === "TRADE_SUCCESS" || remote?.trade_status === "TRADE_FINISHED";
      if (paid) {
        order = finalizeOrder(order.id, {
          transactionId: remote?.transaction_id || remote?.trade_no || `${order.channel}:query`
        });
      }
    } catch {
      // 查单失败不影响轮询响应，等待下一次轮询或 webhook 重投。
    }
  }
  return publicOrderView(order);
}

/** 对外订单视图：绝不暴露商户单号、transaction_id 等内部字段。 */
export function publicOrderView(order) {
  if (!order) return null;
  const view = {
    orderId: order.id,
    channel: order.channel,
    state: order.state,
    // 支付宝电脑网站支付的 payload 是收银台跳转 URL（https 开头），当面付/微信是二维码内容。
    type: order.channel === "alipay" && order.qr_payload?.startsWith("https://") ? "redirect" : "qr",
    payload: order.qr_payload,
    amountFen: order.amount_fen,
    expiresAt: order.expires_at,
    createdAt: order.created_at
  };
  if (order.state === "paid") {
    const license = db.prepare("SELECT * FROM licenses WHERE order_id = ?").get(order.id);
    view.licenseKey = license?.state === "active" ? licensePlaintext(license) : "";
    // 脱敏邮箱：成功页提示「激活码已发送至 q***@126.com」，不回传完整地址。
    if (license?.customer_email) view.customerEmailMasked = maskEmail(license.customer_email);
  }
  return view;
}

/** 退款：调通道退款接口在 CLI 里完成，这里只落库 + 吊销激活码。 */
export function markRefunded(orderId, { refundId, amountFen, reason }) {
  return transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) throw new Error("订单不存在。");
    db.prepare("UPDATE orders SET state = 'refunded', updated_at = ? WHERE id = ?").run(nowIso(), orderId);
    if (order.license_id) {
      db.prepare("UPDATE licenses SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'active'")
        .run(nowIso(), order.license_id);
    }
    db.prepare(`
      INSERT INTO refunds (id, order_id, channel, refund_id, amount_fen, reason, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'processed', ?)
    `).run(randomUUID(), orderId, order.channel, refundId ?? "", amountFen ?? order.amount_fen, reason ?? "", nowIso());
    return db.prepare("SELECT * FROM refunds WHERE order_id = ?").get(orderId);
  });
}
