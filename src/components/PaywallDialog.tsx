/**
 * 付费墙对话框（¥99 一次性购买）：解锁录音/转写/AI 纪要/导入/导出前弹出。
 * 提供三个动作：跳转官网购买页（微信支付/支付宝扫码，可选折扣码自动带入）、
 * 输入激活码（主进程经 HTTPS 验证服务校验并绑定设备）、「恢复购买」
 * （强制刷新授权状态，覆盖离线宽限期的过期缓存）。
 * 折扣码只在服务端试算价格，客户端不自行计价；校验通过后随购买页地址带入。
 * 验证/激活的实际逻辑在 electron/services/licensing.mjs；这里只做 UI 与状态回传。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, CheckCircle, Key, LockKey, ShieldCheck, Sparkle, Tag, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useExitPresence } from "../hooks/useExitPresence";
import type { DiscountQuote, LicenseStatus } from "../types";

/** 分以下金额格式化为人民币；整数不显示小数位。 */
function yuan(fen: number) {
  return `¥${(fen / 100).toFixed(fen % 100 === 0 ? 0 : 2)}`;
}

type Panel = "activation" | "discount";
type BusyTask = "activate" | "quote" | "refresh" | "checkout";
type SuccessKind = "activated" | "restored";

export function PaywallDialog({ open, reason, status, onStatusChange, onClose }: {
  open: boolean;
  /** 触发付费墙的功能说明（如"导出前需解锁"）。 */
  reason?: string;
  status: LicenseStatus | null;
  onStatusChange(status: LicenseStatus): void;
  onClose(): void;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [discountInput, setDiscountInput] = useState("");
  const [discount, setDiscount] = useState<DiscountQuote | null>(null);
  const [busy, setBusy] = useState<BusyTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessKind | null>(null);
  const licenseField = useRef<HTMLInputElement>(null);
  const discountField = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | null>(null);

  // 每次打开清掉上次的错误与进行中状态，面板保持上次选择。
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDiscountError(null);
    setSuccess(null);
    setBusy(null);
  }, [open]);

  // 展开输入面板后把焦点交给输入框，减少一次点击；不触发滚动，
  // 避免浮层在较矮窗口里被浏览器滚到“切掉标题”的位置。
  useEffect(() => {
    if (!open || !panel) return undefined;
    const timer = window.setTimeout(() => {
      (panel === "activation" ? licenseField : discountField).current?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [panel, open]);

  // Escape 关闭（成功收尾阶段不打断），与其它对话框一致。
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && !success) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, success, onClose]);

  // 卸载前清掉成功关窗计时器，避免对已卸载组件调用回调。
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const { mounted, closing } = useExitPresence(open, 200);
  if (!mounted) return null;

  /** 成功后短暂停留在确认态，再让对话框收回（可见的因果反馈）。 */
  const finish = (kind: SuccessKind) => {
    setBusy(null);
    setSuccess(kind);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, 780);
  };

  /** 强制向验证服务刷新授权（刷新成功且已授权则确认后关闭）。 */
  const refresh = async () => {
    if (busy) return;
    setBusy("refresh"); setError(null);
    try {
      const next = await api.licensing.getStatus(true);
      onStatusChange(next);
      if (next.state === "licensed") finish("restored");
      else if (next.message) setError(next.message);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "验证失败，请稍后再试。"); }
    finally { setBusy((current) => (current === "refresh" ? null : current)); }
  };

  /** 提交激活码：主进程校验成功后更新状态并关闭；失败展示服务端返回的原因。 */
  const activate = async () => {
    const key = licenseKey.trim().toUpperCase();
    if (!key || busy) return;
    setBusy("activate"); setError(null);
    try {
      const next = await api.licensing.activate(key);
      onStatusChange(next);
      setLicenseKey("");
      finish("activated");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "激活失败，请检查激活码。");
      setBusy(null);
    }
  };

  /** 折扣码试算：价格以服务端为准；成功后收起面板并在价格卡上展示折后应付。 */
  const applyDiscount = async () => {
    const code = discountInput.trim().toUpperCase();
    if (!code) {
      setDiscountError("请输入折扣码。");
      return;
    }
    if (busy) return;
    setBusy("quote"); setDiscountError(null);
    try {
      const quote = await api.licensing.quoteDiscount(code);
      setDiscount(quote);
      setDiscountInput("");
      setPanel(null);
    } catch (caught) {
      setDiscountError(caught instanceof Error ? caught.message : "折扣码校验失败，请稍后重试。");
    } finally {
      setBusy((current) => (current === "quote" ? null : current));
    }
  };

  /** 打开官网购买页；已试算的折扣码随地址带入，页面自动套用。 */
  const checkout = async () => {
    if (busy) return;
    setBusy("checkout"); setError(null);
    try {
      await api.licensing.openCheckout(discount?.code ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法打开购买页面，请稍后再试。");
    } finally {
      setBusy((current) => (current === "checkout" ? null : current));
    }
  };

  const togglePanel = (next: Panel) => {
    if (busy) return;
    setError(null);
    setDiscountError(null);
    setPanel((current) => (current === next ? null : next));
  };

  return <div className={`modal-backdrop paywall-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !success) onClose(); }}>
    <section className="dialog paywall-dialog" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <button className="icon-button paywall-close" aria-label="关闭" onClick={onClose} disabled={Boolean(success)}><X size={18} /></button>
      <div className="paywall-scroll">
        <div className="paywall-hero">
          <div className="paywall-mark"><LockKey size={28} weight="duotone" /></div>
          <span>{reason || "解锁完整工作流"}</span>
          <h2 id="paywall-title">会议结束前，重要工作已经完成。</h2>
          <p>一次购买 MinuteFlow 桌面版，录音、转写、AI 纪要与导出全部解锁。</p>
        </div>

        <div className={`paywall-price ${discount ? "is-discounted" : ""}`}>
          <div>
            <b>{yuan(discount ? discount.amountFen : 9_900)}</b>
            {discount && <s aria-label={`原价 ${yuan(discount.listAmountFen)}`}>{yuan(discount.listAmountFen)}</s>}
            <span>人民币 · 一次性购买</span>
          </div>
          <em>{discount ? `已减 ${yuan(discount.discountFen)}` : "7 天退款保证"}</em>
        </div>

        <ul className="paywall-features">
          <li><Check size={16} weight="bold" />不限会议数量与录音时长</li>
          <li><Check size={16} weight="bold" />本地模型与第三方 AI 自由配置</li>
          <li><Check size={16} weight="bold" />Markdown、PDF、DOCX、字幕与完整备份</li>
        </ul>

        {discount ? (
          <div className="paywall-discount-applied" role="status">
            <Tag size={14} weight="fill" />
            <span>折扣码 <b>{discount.code}</b> 已应用</span>
            <button type="button" className="text-button" onClick={() => { setDiscount(null); setDiscountError(null); }} disabled={busy !== null}>取消</button>
          </div>
        ) : (
          <button
            type="button"
            className={`paywall-discount-entry ${panel === "discount" ? "is-active" : ""}`}
            onClick={() => togglePanel("discount")}
            aria-expanded={panel === "discount"}
            aria-controls="paywall-discount-panel"
            disabled={busy !== null}
          >
            <Tag size={14} />
            <span>有折扣码？点此使用</span>
          </button>
        )}

        <div id="paywall-discount-panel" className={`paywall-reveal ${panel === "discount" ? "is-open" : ""}`} aria-hidden={panel !== "discount"} inert={panel !== "discount"}>
          <div>
            <div className="paywall-field">
              <label htmlFor="paywall-discount">折扣码</label>
              <div className="paywall-field-row">
                <input
                  id="paywall-discount"
                  ref={discountField}
                  value={discountInput}
                  onChange={(event) => { setDiscountInput(event.target.value); setDiscountError(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void applyDiscount(); } }}
                  placeholder="输入折扣码"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={discountError ? true : undefined}
                />
                <button type="button" className="button" disabled={busy !== null || !discountInput.trim()} onClick={() => void applyDiscount()}>
                  {busy === "quote" ? "校验中…" : "使用"}
                </button>
              </div>
              {discountError && <p className="paywall-inline-error" role="alert">{discountError}</p>}
              <p className="paywall-field-hint">折扣码在支付页面同样有效，价格以服务端校验结果为准。</p>
            </div>
          </div>
        </div>

        <div id="paywall-activation-panel" className={`paywall-reveal ${panel === "activation" ? "is-open" : ""}`} aria-hidden={panel !== "activation"} inert={panel !== "activation"}>
          <div>
            <div className="paywall-field">
              <label htmlFor="license-key"><Key size={14} />激活码</label>
              <div className="paywall-field-row">
                <input
                  id="license-key"
                  ref={licenseField}
                  value={licenseKey}
                  onChange={(event) => setLicenseKey(event.target.value.toUpperCase())}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void activate(); } }}
                  placeholder="MF-XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="button button--primary" disabled={busy !== null || !licenseKey.trim()} onClick={() => void activate()}>
                  {busy === "activate" ? "激活中…" : "激活"}
                </button>
              </div>
              <button type="button" className="text-button activation-recover" onClick={async () => {
                try { await api.licensing.openRecover(); }
                catch (caught) { setError(caught instanceof Error ? caught.message : "无法打开找回页面，请稍后再试。"); }
              }}>忘记激活码？邮件找回</button>
            </div>
          </div>
        </div>

        {success && <p className="paywall-success" role="status">
          <CheckCircle size={16} weight="fill" />
          <span>{success === "activated" ? "已解锁，正在进入…" : "授权已恢复，正在进入…"}</span>
        </p>}
        {error && <p className="paywall-error" role="alert">{error}</p>}
        {status && !status.verificationConfigured && !error && <p className="paywall-config-note">购买入口已就绪；激活验证服务正在接入，稍后重启应用即可使用。</p>}
        {status?.insecureStorage && !error && <p className="paywall-config-note">当前为未签名版本，密钥将以未加密方式保存在本地，建议安装官方签名版本。</p>}
        <div className="paywall-actions">
          <button className="button button--primary paywall-buy" onClick={() => void checkout()} disabled={busy !== null || Boolean(success)}>
            {busy === "checkout" ? <ArrowClockwise size={16} className="spin" /> : <Sparkle size={16} weight="fill" />}
            {busy === "checkout" ? "正在打开购买页…" : status?.checkoutConfigured === false ? "查看购买方式" : "购买并解锁"}
          </button>
          <button className="button" onClick={() => togglePanel("activation")} aria-expanded={panel === "activation"} aria-controls="paywall-activation-panel" disabled={busy !== null || Boolean(success)}>
            <Key size={15} />{panel === "activation" ? "收起激活" : "输入激活码"}
          </button>
          <button className="text-button" disabled={busy !== null || Boolean(success)} onClick={() => void refresh()}>
            <ArrowClockwise size={14} className={busy === "refresh" ? "spin" : ""} />
            {busy === "refresh" ? "正在验证" : "恢复购买"}
          </button>
        </div>
        <footer><ShieldCheck size={14} /><span>支付由微信支付 / 支付宝安全处理。授权验证仅发送激活码、设备标识与应用版本。</span></footer>
      </div>
    </section>
  </div>;
}
