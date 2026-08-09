import { useEffect, useState } from "react";
import { ArrowClockwise, Check, Key, LockKey, ShieldCheck, Sparkle, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { LicenseStatus } from "../types";

export function PaywallDialog({ open, reason, status, onStatusChange, onClose }: {
  open: boolean;
  reason?: string;
  status: LicenseStatus | null;
  onStatusChange(status: LicenseStatus): void;
  onClose(): void;
}) {
  const [showActivation, setShowActivation] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) setError(null); }, [open]);
  if (!open) return null;

  const refresh = async () => {
    setBusy(true); setError(null);
    try {
      const next = await api.licensing.getStatus(true);
      onStatusChange(next);
      if (next.state === "licensed") onClose();
      else if (next.message) setError(next.message);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "验证失败，请稍后再试。"); }
    finally { setBusy(false); }
  };

  const activate = async () => {
    setBusy(true); setError(null);
    try {
      const next = await api.licensing.activate(licenseKey);
      onStatusChange(next); setLicenseKey(""); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "激活失败，请检查激活码。"); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop paywall-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog paywall-dialog" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <button className="icon-button paywall-close" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      <div className="paywall-hero">
        <div className="paywall-mark"><LockKey size={28} weight="duotone" /></div>
        <span>{reason || "解锁完整工作流"}</span>
        <h2 id="paywall-title">会议结束前，重要工作已经完成。</h2>
        <p>一次购买 MinuteFlow 桌面版，录音、转写、AI 纪要与导出全部解锁。</p>
      </div>
      <div className="paywall-price"><div><b>¥99</b><span>人民币 · 一次性购买</span></div><em>7 天退款保证</em></div>
      <ul className="paywall-features">
        <li><Check size={16} weight="bold" />不限会议数量与录音时长</li>
        <li><Check size={16} weight="bold" />本地模型与第三方 AI 自由配置</li>
        <li><Check size={16} weight="bold" />Markdown、PDF、DOCX、字幕与完整备份</li>
      </ul>
      {showActivation ? <div className="activation-box">
        <label htmlFor="license-key"><Key size={15} />激活码</label>
        <div><input id="license-key" value={licenseKey} onChange={(event) => setLicenseKey(event.target.value)} placeholder="输入购买后收到的激活码" autoComplete="off" spellCheck={false} /><button className="button button--primary" disabled={busy || !licenseKey.trim()} onClick={activate}>激活</button></div>
      </div> : null}
      {error && <p className="paywall-error" role="alert">{error}</p>}
      {status && !status.verificationConfigured && !error && <p className="paywall-config-note">购买入口已就绪；激活验证服务将在 Paddle 审核完成后启用。</p>}
      {status?.insecureStorage && !error && <p className="paywall-config-note">当前为未签名版本，密钥将以未加密方式保存在本地，建议安装官方签名版本。</p>}
      <div className="paywall-actions">
        <button className="button button--primary paywall-buy" onClick={async () => {
          try { await api.licensing.openCheckout(); }
          catch (caught) { setError(caught instanceof Error ? caught.message : "无法打开购买页面，请稍后再试。"); }
        }}><Sparkle size={16} weight="fill" />{status?.checkoutConfigured ? "购买并解锁" : "查看购买方式"}</button>
        <button className="button" onClick={() => setShowActivation((value) => !value)}><Key size={15} />{showActivation ? "收起激活" : "输入激活码"}</button>
        <button className="text-button" disabled={busy} onClick={refresh}><ArrowClockwise size={14} className={busy ? "spin" : ""} />{busy ? "正在验证" : "恢复购买"}</button>
      </div>
      <footer><ShieldCheck size={14} /><span>付款由 Paddle 安全处理。授权验证仅发送激活码、设备标识与应用版本。</span></footer>
    </section>
  </div>;
}
