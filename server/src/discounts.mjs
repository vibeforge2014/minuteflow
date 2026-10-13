/**
 * 折扣码（与 ChargePilot 共用 Supabase payment 项目）：
 * - 码在 ZenSoft 管理后台生成（discount_codes，product='minuteflow'，仅永久授权），
 *   service role 才可读写；本服务通过 PostgREST RPC 只读校验并计价。
 * - 下单时调用 quote_checkout_discount 复算实付金额（金额永远服务端决定，页面无权指定）。
 * - 支付落账 / 退款后把订单镜像回 Supabase 订单表（product='minuteflow'），
 *   供管理后台的订单列表与折扣码用量统计展示；镜像 best-effort，失败只记日志，
 *   绝不影响发码与激活。沙箱 mock 通道不入镜像，避免污染真实用量。
 * - 未配置 DISCOUNT_SUPABASE_* 时整体优雅降级（quote 503、折扣下单报可读错误）。
 */
import { config, discountsReady } from "./config.mjs";

const RPC_TIMEOUT_MS = 8_000;

/** quote RPC 抛出的业务错误码 → 面向购买页的中文文案。 */
const RPC_ERRORS = {
  DISCOUNT_NOT_FOUND: "折扣码不存在，请检查输入。",
  DISCOUNT_DISABLED: "折扣码已停用。",
  DISCOUNT_EXPIRED: "折扣码已过期。",
  DISCOUNT_NOT_APPLICABLE: "该折扣码不适用于 MinuteFlow 永久授权。",
  DISCOUNT_INVALID_AMOUNT: "折扣码优惠金额无效。",
  INVALID_PRICE: "订单价格异常，请稍后重试或联系支持。"
};

/** 携带 HTTP 状态码的业务错误（下单/quote 路由按状态码透出）。 */
export class DiscountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 归一用户输入：去空白、转大写、限长（discount_codes.code 最长 32）。 */
export function normalizeDiscountCode(value) {
  return String(value ?? "").trim().toUpperCase().slice(0, 32);
}

async function supabaseFetch(pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    return await fetch(`${config.discounts.supabaseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: config.discounts.serviceKey,
        authorization: `Bearer ${config.discounts.serviceKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
        ...(init.headers ?? {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 校验折扣码并按当前服务端售价计价。
 * 返回 { code, codeId, listAmountFen, amountFen, discountFen }；无效/不可用时抛 DiscountError。
 */
export async function quoteDiscountCode(listAmountFen, rawCode) {
  const code = normalizeDiscountCode(rawCode);
  if (!code) throw new DiscountError("请输入折扣码。");
  if (!discountsReady()) throw new DiscountError("折扣码服务暂未开放，请直接按原价购买。", 503);

  let response;
  try {
    response = await supabaseFetch("/rest/v1/rpc/quote_checkout_discount", {
      method: "POST",
      body: JSON.stringify({
        p_product: "minuteflow",
        p_plan: "lifetime",
        p_original_amount_fen: listAmountFen,
        p_discount_code: code
      })
    });
  } catch {
    throw new DiscountError("折扣码服务暂时不可用，请稍后重试。", 502);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    // PostgREST 把 RAISE EXCEPTION 的错误码放在 message 字段。
    const rpcCode = typeof payload?.message === "string" ? payload.message : "";
    if (RPC_ERRORS[rpcCode]) throw new DiscountError(RPC_ERRORS[rpcCode], 400);
    throw new DiscountError("折扣码校验失败，请稍后重试。", 502);
  }

  const row = await response.json().catch(() => null);
  const amountFen = Number(row?.amount_fen);
  const discountFen = Number(row?.discount_amount_fen);
  if (!Number.isInteger(amountFen) || amountFen <= 0 || amountFen >= listAmountFen
    || !Number.isInteger(discountFen) || discountFen <= 0) {
    // 防御性兜底：RPC 契约异常时不允许落单，避免错价收款。
    throw new DiscountError("折扣计价异常，请稍后重试或联系支持。", 502);
  }
  return {
    code: typeof row.discount_code === "string" ? row.discount_code : code,
    codeId: row.discount_code_id ?? null,
    listAmountFen,
    amountFen,
    discountFen
  };
}

/**
 * 已支付订单镜像到 Supabase（alipay_orders / wechat_orders，product='minuteflow'，
 * status='paid'）。后台的订单列表、实收统计与折扣码用量（discount_code_usage
 * 按订单表聚合）都依赖这份数据。best-effort：失败记日志、绝不抛出。
 */
export function mirrorPaidOrder(order) {
  if (!discountsReady() || !order || order.channel !== "alipay" && order.channel !== "wechat") return;
  const table = order.channel === "alipay" ? "alipay_orders" : "wechat_orders";
  supabaseFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: { prefer: "return=minimal, resolution=ignore-duplicates" },
    body: JSON.stringify({
      out_trade_no: order.out_trade_no,
      email: order.customer_email || "",
      plan: "lifetime",
      amount_fen: order.amount_fen,
      original_amount_fen: order.original_amount_fen ?? order.amount_fen,
      discount_amount_fen: order.discount_amount_fen ?? 0,
      discount_code: order.discount_code ?? null,
      status: "paid",
      paid_at: order.paid_at ?? order.updated_at,
      updated_at: order.updated_at,
      product: "minuteflow"
    })
  })
    .then((response) => {
      if (!response.ok) console.error(`[mirror] 订单镜像写入失败 ${order.out_trade_no}: HTTP ${response.status}`);
    })
    .catch((error) => console.error(`[mirror] 订单镜像请求失败 ${order.out_trade_no}:`, error.message));
}

/** 退款后同步镜像行状态（按商户单号定位）。同样 best-effort。 */
export function mirrorRefundedOrder(order) {
  if (!discountsReady() || !order || order.channel !== "alipay" && order.channel !== "wechat") return;
  const table = order.channel === "alipay" ? "alipay_orders" : "wechat_orders";
  supabaseFetch(`/rest/v1/${table}?out_trade_no=eq.${encodeURIComponent(order.out_trade_no)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "refunded", refunded_at: order.updated_at ?? new Date().toISOString() })
  })
    .then((response) => {
      if (!response.ok) console.error(`[mirror] 退款状态同步失败 ${order.out_trade_no}: HTTP ${response.status}`);
    })
    .catch((error) => console.error(`[mirror] 退款状态同步请求失败 ${order.out_trade_no}:`, error.message));
}
