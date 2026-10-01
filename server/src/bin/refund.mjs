#!/usr/bin/env node
/**
 * 退款 CLI：node server/src/bin/refund.mjs <orderId> [原因]
 *
 * 全额退款并吊销对应激活码（对应官网 7 天退款承诺）。流程：
 *   1. 先调通道退款接口（同 refundNo 幂等，中断后重跑不会重复退）；
 *   2. 再本地落账：订单 → refunded、激活码 → revoked、refunds 表记账。
 * mock/联调订单跳过通道调用，仅本地落账。在服务器上以 service 用户运行。
 */
import { db } from "../db.mjs";
import { markRefunded } from "../orders.mjs";
import { createRefund as wechatRefund } from "../wechat.mjs";
import { createRefund as alipayRefund } from "../alipay.mjs";

const orderId = process.argv[2];
if (!orderId) {
  console.error("用法：node server/src/bin/refund.mjs <orderId> [原因]");
  process.exit(1);
}
const reason = process.argv[3] || "用户申请退款";
const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
if (!order) {
  console.error("订单不存在。");
  process.exit(1);
}
if (order.state === "refunded") {
  console.log("订单已退款，无需重复操作。");
  process.exit(0);
}
if (order.state !== "paid") {
  console.error(`订单状态为 ${order.state}，仅已支付订单可退款。`);
  process.exit(1);
}

const refundNo = `RF${order.out_trade_no.slice(2)}`;
if (order.channel === "wechat") {
  const result = await wechatRefund({
    outTradeNo: order.out_trade_no, refundNo, amountFen: order.amount_fen, reason
  });
  console.log(`微信退款受理：${result.refund_id ?? refundNo} status=${result.status ?? "?"}`);
} else if (order.channel === "alipay") {
  const result = await alipayRefund({
    outTradeNo: order.out_trade_no, refundNo, amountFen: order.amount_fen, reason
  });
  console.log(`支付宝退款完成：fund_change=${result.fund_change ?? "?"} trade_no=${result.trade_no ?? "?"}`);
} else {
  console.log("mock 订单：跳过通道退款，仅本地落账。");
}

markRefunded(order.id, { refundId: refundNo, amountFen: order.amount_fen, reason });
console.log(`已退款并吊销激活码：order=${order.id}`);
