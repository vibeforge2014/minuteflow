import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, Check, Microphone, Monitor, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { SystemPermissionStatus, SystemPermissionValue } from "../types";

const initialStatus: SystemPermissionStatus = {
  microphone: "unknown",
  screen: "unknown",
  systemAudioRequired: api.system.platform === "darwin",
  systemAudioPickerHint: api.system.platform === "darwin"
};

export function SystemPermissionsDialog({ open, onComplete }: { open: boolean; onComplete(): Promise<void> }) {
  const [status, setStatus] = useState(initialStatus);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try { setStatus(await api.system.getPermissions()); } finally { setChecking(false); }
  }, []);

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
          primaryLabel={status.microphone === "not-determined" ? "允许访问" : "打开设置"}
          onPrimary={async () => {
            if (status.microphone === "not-determined") {
              const microphone = await api.system.requestMicrophone();
              setStatus((current) => ({ ...current, microphone }));
              return;
            }
            await api.system.openSettings("microphone");
          }}
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
        {status.systemAudioPickerHint && status.systemAudioRequired && (
          <p className="permission-wall__hint">macOS 提示：开始线上会议录音时，请在系统弹窗中勾选“共享电脑音频”，否则只能录到本地麦克风、远程参会者将无声。</p>
        )}
      </div>
      <div className="permission-wall__note"><ShieldCheck size={16} /><span>录音前，请先获得所有参会者同意。你可以随时在系统设置中撤销权限。</span></div>
      <footer>
        <button className="button" onClick={refresh} disabled={checking}><ArrowClockwise size={15} className={checking ? "spin" : ""} />重新检查</button>
        <div><span>{microphoneReady && screenReady ? "权限已就绪" : microphoneReady ? "可先使用线下会议" : "也可以仅记笔记，稍后授权"}</span><button className="button button--primary" onClick={onComplete}>继续</button></div>
      </footer>
    </section>
  </div>;
}

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
