/**
 * 系统权限引导（首run第一道门）：版本化的首次授权流程，集中完成
 * 麦克风与 macOS 屏幕录制（系统音频）授权。核心原则——正常录音/结束流程
 * 永不触发系统弹窗或系统选择器；本对话框是唯一主动发起授权的地方。
 * 每行显示权限状态并提供「打开设置」路由；「一次完成授权」逐项发起申请。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, ArrowRight, Check, GearSix, Microphone, Monitor, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { SystemPermissionStatus, SystemPermissionValue } from "../types";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { BrandMark } from "./BrandMark";

/** 初始状态：macOS 上录制系统音频必须有屏幕录制权限（Chromium 的 CoreAudio Tap 依赖它）。 */
const initialStatus: SystemPermissionStatus = {
  microphone: "unknown",
  screen: "unknown",
  systemAudioRequired: api.system.platform === "darwin",
  systemAudioPickerHint: false
};

export function SystemPermissionsDialog({
  open,
  onComplete,
  onSkip,
  returningUser = false
}: {
  open: boolean;
  onComplete(): Promise<void>;
  /** 「暂不授权，先体验」：跳过首run权限墙；真正开始录音时会再次引导授权。 */
  onSkip(): Promise<void>;
  /** 升级后因权限流程版本提升而重弹的老用户：解释“为什么又弹一次”。 */
  returningUser?: boolean;
}) {
  const forceMacPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get("permissionPreview") === "mac";
  const isMac = api.system.platform === "darwin" || forceMacPreview;
  const [status, setStatus] = useState<SystemPermissionStatus>(() => forceMacPreview ? {
    ...initialStatus,
    microphone: "not-determined",
    screen: "denied",
    systemAudioRequired: true
  } : initialStatus);
  const [checking, setChecking] = useState(false);
  // 非 macOS 无需一次性屏幕采集探测，直接视为就绪。
  const [capturePrepared, setCapturePrepared] = useState(!isMac);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>(open, {
    initialFocus: ".permission-wall__footer .button--primary"
  });

  /** 向主进程重新查询权限状态。 */
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      if (!forceMacPreview) setStatus(await api.system.getPermissions());
    } finally { setChecking(false); }
  }, [forceMacPreview]);

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
      if (microphone !== "granted") {
        // systemPreferences 在部分系统版本上刷新较慢；以真实采集成功作为最终依据。
        const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of microphoneStream.getTracks()) track.stop();
        microphone = "granted";
      }

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
      const refreshed = await api.system.getPermissions();
      setStatus({ ...refreshed, microphone });
    } catch (authorizeError) {
      setError(authorizeError instanceof Error ? authorizeError.message : "权限授权未完成，请重试。");
      setStatus(await api.system.getPermissions().catch(() => status));
    } finally {
      setChecking(false);
    }
  };

  return <div className="modal-backdrop permission-wall-backdrop">
    <section ref={dialogRef} className="dialog permission-wall" role="dialog" aria-modal="true" aria-labelledby="permission-wall-title">
      <header className="permission-wall__header">
        <div className="permission-wall__symbol"><ShieldCheck size={27} weight="duotone" /></div>
        <div>
          <span>首次设置 · 系统授权</span>
          <h2 id="permission-wall-title">{returningUser ? "本次更新需要再确认一次权限" : "先允许两项权限，录音才会完整"}</h2>
          <p>{returningUser ? "新版本调整了系统音频的采集方式，需要补充确认；已有权限不会被重置。" : "MinuteFlow 只在你主动录音时访问声音，会议内容仍默认保存在本机。"}</p>
        </div>
      </header>
      <div className="permission-wall__list">
        <PermissionRow
          icon={<Microphone size={21} />}
          title="麦克风"
          description="录制你的声音，并用于本地或你选择的转写服务。"
          value={status.microphone}
          primaryLabel={status.microphone === "denied" || status.microphone === "restricted" ? "打开设置" : "请求权限"}
          onPrimary={async () => {
            if (status.microphone === "denied" || status.microphone === "restricted") {
              await api.system.openSettings("microphone");
              return;
            }
            setChecking(true);
            setError(null);
            try {
              await api.system.requestMicrophone();
              await refresh();
            } catch (requestError) {
              setError(requestError instanceof Error ? requestError.message : "无法请求麦克风权限。");
            } finally {
              setChecking(false);
            }
          }}
        />
        <PermissionRow
          icon={<Monitor size={21} />}
          title="系统音频"
          description={status.systemAudioRequired ? "录制线上会议声音；macOS 会把它归在“屏幕与系统音频录制”中。" : "系统支持直接采集线上会议声音，无需额外屏幕权限。"}
          value={status.systemAudioRequired ? status.screen : "granted"}
          primaryLabel="手动添加"
          onPrimary={() => api.system.openSettings("screen")}
          hideAction={!status.systemAudioRequired || status.screen === "granted"}
        />
        {isMac && !screenReady && (
          <section className="permission-wall__drag-guide" aria-label="手动添加 MinuteFlow 到系统设置">
            <div className="permission-wall__drag-copy">
              <span>如果系统列表里没有 MinuteFlow</span>
              <strong>打开设置后，直接拖入应用图标</strong>
              <p>会出现一条置顶小浮层。把里面的 MinuteFlow 图标拖到应用列表，再打开右侧开关。</p>
            </div>
            <div className="permission-wall__drag-route" aria-hidden="true">
              <div><BrandMark size={32} /><strong>MinuteFlow</strong></div>
              <ArrowRight size={18} weight="bold" />
              <div><GearSix size={26} weight="duotone" /><span><strong>系统设置</strong><small>屏幕与系统音频录制</small></span></div>
            </div>
            <button className="button permission-wall__settings-button" onClick={() => api.system.openSettings("screen")}>
              打开系统设置
            </button>
          </section>
        )}
        <p className="permission-wall__hint"><ShieldCheck size={15} weight="fill" />授权集中在这里完成。之后开始、停止或回放会议时，不会再主动打开系统设置或选择器。</p>
        {error && <p className="permission-wall__error"><WarningCircle size={14} />{error}</p>}
      </div>
      <div className="permission-wall__note"><ShieldCheck size={16} /><span>录音前，请先获得所有参会者同意。你可以随时在系统设置中撤销权限。</span></div>
      <footer>
        <button className="button" onClick={refresh} disabled={checking}><ArrowClockwise size={15} className={checking ? "spin" : ""} />重新检查</button>
        <div>
          <span>{allReady ? "权限已就绪" : "完成后回到这里检查状态"}</span>
          {!allReady ? (
            <>
              <button className="permission-wall__skip" onClick={onSkip} disabled={checking}>暂不授权，先体验</button>
              <button className="button button--primary" onClick={authorizeOnce} disabled={checking}>{checking ? "正在授权…" : "开始授权"}</button>
            </>
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
