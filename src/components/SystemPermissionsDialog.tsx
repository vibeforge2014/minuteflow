/**
 * 系统权限引导（首run第一道门）：版本化的首次授权流程，集中完成
 * 麦克风与 macOS 屏幕录制（系统音频）授权。核心原则——正常录音/结束流程
 * 永不触发系统弹窗或系统选择器；本对话框是唯一主动发起授权的地方。
 * 每行显示权限状态并提供「打开设置」路由；「一次完成授权」逐项发起申请。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, Check, Microphone, Monitor, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { SystemPermissionStatus, SystemPermissionValue } from "../types";

/** 初始状态：macOS 上录制系统音频必须有屏幕录制权限（Chromium 的 CoreAudio Tap 依赖它）。 */
const initialStatus: SystemPermissionStatus = {
  microphone: "unknown",
  screen: "unknown",
  systemAudioRequired: api.system.platform === "darwin",
  systemAudioPickerHint: false
};

export function SystemPermissionsDialog({ open, onComplete }: { open: boolean; onComplete(): Promise<void> }) {
  const [status, setStatus] = useState(initialStatus);
  const [checking, setChecking] = useState(false);
  // 非 macOS 无需一次性屏幕采集探测，直接视为就绪。
  const [capturePrepared, setCapturePrepared] = useState(api.system.platform !== "darwin");
  const [error, setError] = useState<string | null>(null);

  /** 向主进程重新查询权限状态。 */
  const refresh = useCallback(async () => {
    setChecking(true);
    try { setStatus(await api.system.getPermissions()); } finally { setChecking(false); }
  }, []);

  // 打开时刷新一次；窗口重新获得焦点时也刷新（用户可能刚去系统设置改完权限回来）。
  useEffect(() => {
    if (!open) return;
    refresh();
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [open, refresh]);

  if (!open) return null;
  const microphoneReady = status.microphone === "granted";
  const screenReady = !status.systemAudioRequired || status.screen === "granted";
  const allReady = microphoneReady && screenReady && capturePrepared;

  /** 「一次完成授权」：麦克风请求一次；macOS 再做一次最小屏幕采集探测，确认系统音频轨可用。 */
  const authorizeOnce = async () => {
    setChecking(true);
    setError(null);
    try {
      let microphone = status.microphone;
      if (microphone !== "granted") microphone = await api.system.requestMicrophone();
      if (microphone !== "granted") throw new Error("麦克风权限未允许，请在系统设置中允许后重新检查。");

      if (status.systemAudioRequired) {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: { width: { ideal: 2 }, height: { ideal: 2 }, frameRate: { ideal: 1, max: 1 } }
        });
        // Let Chromium initialize the CoreAudio Tap before immediately
        // releasing this one-time permission probe.
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        const audioReady = stream.getAudioTracks().some((track) => track.readyState === "live");
        for (const track of stream.getTracks()) track.stop();
        if (!audioReady) throw new Error("系统音频授权未完成，请检查系统设置后重试。");
        setCapturePrepared(true);
      }
      setStatus(await api.system.getPermissions());
    } catch (authorizeError) {
      setError(authorizeError instanceof Error ? authorizeError.message : "权限授权未完成，请重试。");
      setStatus(await api.system.getPermissions().catch(() => status));
    } finally {
      setChecking(false);
    }
  };

  return <div className="modal-backdrop permission-wall-backdrop">
    <section className="dialog permission-wall" role="dialog" aria-modal="true" aria-labelledby="permission-wall-title">
      <header className="permission-wall__header">
        <div className="permission-wall__symbol"><ShieldCheck size={27} weight="duotone" /></div>
        <div><span>开始之前</span><h2 id="permission-wall-title">由你决定 MinuteFlow 可以访问什么</h2><p>权限只用于你主动开始的会议，本地内容不会因此上传。</p></div>
      </header>
      <div className="permission-wall__list">
        <PermissionRow
          icon={<Microphone size={21} />}
          title="麦克风"
          description="录制你的声音，并用于本地或你选择的转写服务。"
          value={status.microphone}
          primaryLabel="打开设置"
          onPrimary={() => api.system.openSettings("microphone")}
        />
        <PermissionRow
          icon={<Monitor size={21} />}
          title="系统音频"
          description={status.systemAudioRequired ? "线上会议模式需要屏幕录制权限，MinuteFlow 只保留会议音频。" : "系统支持直接采集线上会议声音，无需额外屏幕权限。"}
          value={status.systemAudioRequired ? status.screen : "granted"}
          primaryLabel="打开设置"
          onPrimary={() => api.system.openSettings("screen")}
          hideAction={!status.systemAudioRequired || status.screen === "granted"}
        />
        <p className="permission-wall__hint">请在这里一次完成系统授权。之后开始或结束录音时，MinuteFlow 不会再主动申请权限或打开系统选择器。</p>
        {error && <p className="permission-wall__error"><WarningCircle size={14} />{error}</p>}
      </div>
      <div className="permission-wall__note"><ShieldCheck size={16} /><span>录音前，请先获得所有参会者同意。你可以随时在系统设置中撤销权限。</span></div>
      <footer>
        <button className="button" onClick={refresh} disabled={checking}><ArrowClockwise size={15} className={checking ? "spin" : ""} />重新检查</button>
        <div>
          <span>{allReady ? "权限已就绪，之后不会再主动弹出授权" : "需要一次完成麦克风与系统音频授权"}</span>
          {!allReady ? (
            <button className="button button--primary" onClick={authorizeOnce} disabled={checking}>{checking ? "正在授权…" : "一次完成授权"}</button>
          ) : (
            <button className="button button--primary" onClick={onComplete}>开始使用</button>
          )}
        </div>
      </footer>
    </section>
  </div>;
}

/** 单条权限行：图标、说明、状态标签（已允许/未允许/待确认/待检查）与「打开设置」按钮。 */
function PermissionRow({ icon, title, description, value, primaryLabel, onPrimary, hideAction = false }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  value: SystemPermissionValue;
  primaryLabel: string;
  onPrimary(): void | Promise<void>;
  hideAction?: boolean;
}) {
  const ready = value === "granted";
  const blocked = value === "denied" || value === "restricted";
  const label = ready ? "已允许" : blocked ? "未允许" : value === "not-determined" ? "待确认" : "待检查";
  return <article className={ready ? "is-ready" : blocked ? "is-blocked" : ""}>
    <div className="permission-wall__icon">{icon}</div>
    <div><div className="permission-wall__title"><strong>{title}</strong><span>{ready ? <Check size={13} weight="bold" /> : <WarningCircle size={13} />}{label}</span></div><p>{description}</p></div>
    {!hideAction && !ready && <button className="button button--small" onClick={onPrimary}>{primaryLabel}</button>}
  </article>;
}
