/**
 * 系统权限引导（首run第一道门）：版本化的首次授权流程，集中完成
 * 麦克风与 macOS 屏幕录制（系统音频）授权。核心原则——正常录音/结束流程
 * 永不触发系统弹窗或系统选择器；本对话框是唯一主动发起授权的地方。
 * 每行显示权限状态，并用单一主按钮按「麦克风 → 系统设置 → 音频验证」推进。
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, ArrowRight, Check, GearSix, HourglassMedium, Microphone, Monitor, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { getPermissionSetupAction } from "../lib/permissions";
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
  const [screenSettingsOpened, setScreenSettingsOpened] = useState(false);
  const dialogRef = useDialogFocus<HTMLElement>(open, {
    initialFocus: ".permission-wall__footer .button--primary"
  });

  /** 向主进程重新查询权限状态。 */
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      if (!forceMacPreview) {
        const nextStatus = await api.system.getPermissions();
        setStatus(nextStatus);
        if (nextStatus.screen === "granted") setScreenSettingsOpened(false);
      }
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

  // 系统设置打开后短暂轮询；用户切回 MinuteFlow 前也能自动识别权限并推进下一步。
  useEffect(() => {
    if (!open || !screenSettingsOpened || status.screen === "granted") return;
    let disposed = false;
    const checkInBackground = async () => {
      if (forceMacPreview) return;
      const nextStatus = await api.system.getPermissions().catch(() => null);
      if (disposed || !nextStatus) return;
      setStatus(nextStatus);
      if (nextStatus.screen === "granted") setScreenSettingsOpened(false);
    };
    const timer = window.setInterval(() => { void checkInBackground(); }, 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [forceMacPreview, open, screenSettingsOpened, status.screen]);

  if (!open) return null;
  const microphoneReady = status.microphone === "granted";
  const screenReady = !status.systemAudioRequired || status.screen === "granted";
  const allReady = microphoneReady && screenReady && capturePrepared;
  const setupAction = getPermissionSetupAction({
    microphone: status.microphone,
    screen: status.screen,
    systemAudioRequired: status.systemAudioRequired,
    capturePrepared
  });

  /** 第一步：请求并真实验证麦克风输入，避免只依赖可能滞后的系统状态。 */
  const requestMicrophone = async () => {
    setChecking(true);
    setError(null);
    try {
      let microphone = status.microphone;
      if (forceMacPreview) {
        setStatus((current) => ({ ...current, microphone: "granted" }));
        return;
      }
      microphone = await api.system.requestMicrophone();
      if (microphone !== "granted") {
        // systemPreferences 在部分系统版本上刷新较慢；以真实采集成功作为最终依据。
        const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of microphoneStream.getTracks()) track.stop();
        microphone = "granted";
      }

      const refreshed = await api.system.getPermissions();
      setStatus({ ...refreshed, microphone });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法请求麦克风权限，请重试。");
      setStatus(await api.system.getPermissions().catch(() => status));
    } finally {
      setChecking(false);
    }
  };

  /** 第三步：权限开关打开后做一次最小采集，确认 CoreAudio Tap 真的可用。 */
  const verifySystemAudio = async () => {
    setChecking(true);
    setError(null);
    try {
      if (forceMacPreview) {
        setCapturePrepared(true);
        return;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: { ideal: 2 }, height: { ideal: 2 }, frameRate: { ideal: 1, max: 1 } }
      });
      // Let Chromium initialize the CoreAudio Tap before immediately releasing
      // this one-time permission probe. MinuteFlow never keeps the video track.
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const audioReady = stream.getAudioTracks().some((track) => track.readyState === "live");
      for (const track of stream.getTracks()) track.stop();
      if (!audioReady) throw new Error("没有检测到系统音频，请确认右侧开关已打开后重试。");
      setCapturePrepared(true);
      await refresh();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "无法验证系统音频，请重试。");
    } finally {
      setChecking(false);
    }
  };

  const primaryLabel = checking
    ? "正在处理…"
    : setupAction === "request-microphone" ? "允许麦克风"
      : setupAction === "open-microphone-settings" ? "打开麦克风设置"
        : setupAction === "open-screen-settings" ? (screenSettingsOpened ? "重新打开系统设置" : "打开系统设置")
          : setupAction === "verify-system-audio" ? "验证系统音频"
            : "开始使用";
  const nextStepHint = allReady
    ? "两项权限已就绪"
    : !microphoneReady
      ? "第 1 步，共 2 步"
      : !screenReady
        ? (screenSettingsOpened ? "等待你在系统设置中完成" : "第 2 步，共 2 步")
        : "最后确认系统音频";

  const handlePrimary = async () => {
    if (setupAction === "request-microphone") return requestMicrophone();
    if (setupAction === "open-microphone-settings") return api.system.openSettings("microphone");
    if (setupAction === "open-screen-settings") {
      setError(null);
      await api.system.openSettings("screen");
      setScreenSettingsOpened(true);
      return;
    }
    if (setupAction === "verify-system-audio") return verifySystemAudio();
    return onComplete();
  };

  return <div className="modal-backdrop permission-wall-backdrop">
    <section ref={dialogRef} className="dialog permission-wall" role="dialog" aria-modal="true" aria-labelledby="permission-wall-title">
      <header className="permission-wall__header">
        <div className="permission-wall__symbol"><ShieldCheck size={27} weight="duotone" /></div>
        <div>
          <span>首次设置 · 约 1 分钟</span>
          <h2 id="permission-wall-title">{returningUser ? "本次更新需要再确认一次权限" : "先允许两项权限，录音才会完整"}</h2>
          <p>{returningUser ? "新版本调整了系统音频的采集方式，需要补充确认；已有权限不会被重置。" : "MinuteFlow 只在你主动录音时访问声音，会议内容仍默认保存在本机。"}</p>
        </div>
      </header>
      <div className="permission-wall__list">
        <PermissionRow
          step={1}
          icon={<Microphone size={21} />}
          title="麦克风"
          description="录制你的声音，并用于本地或你选择的转写服务。"
          value={status.microphone}
          current={!microphoneReady}
        />
        <PermissionRow
          step={2}
          icon={<Monitor size={21} />}
          title="系统音频"
          description={status.systemAudioRequired ? "录制线上会议声音；macOS 会把它归在“屏幕与系统音频录制”中，但 MinuteFlow 不保存屏幕画面。" : "系统支持直接采集线上会议声音，无需额外屏幕权限。"}
          value={status.systemAudioRequired ? status.screen : "granted"}
          current={microphoneReady && !screenReady}
          waiting={screenSettingsOpened}
        />
        {isMac && !screenReady && (
          <section className="permission-wall__drag-guide" aria-label="手动添加 MinuteFlow 到系统设置">
            <div className="permission-wall__drag-copy">
              <span>{screenSettingsOpened ? "系统设置已打开 · 正在自动检查" : "如果系统列表里没有 MinuteFlow"}</span>
              <strong>{screenSettingsOpened ? "在系统设置里完成这 3 步" : "打开设置后，按这 3 步添加"}</strong>
              <ol>
                <li>从置顶小浮层按住 MinuteFlow 图标</li>
                <li>拖到“屏幕与系统音频录制”的应用列表</li>
                <li>打开右侧开关，再回到这里检查</li>
              </ol>
              <p><HourglassMedium size={13} />拖不动？点浮层里的“在访达中显示”，再用列表下方的“+”添加。</p>
            </div>
            <div className="permission-wall__drag-route" aria-hidden="true">
              <div><BrandMark size={32} /><strong>MinuteFlow</strong></div>
              <ArrowRight size={18} weight="bold" />
              <div><GearSix size={26} weight="duotone" /><span><strong>系统设置</strong><small>屏幕与系统音频录制</small></span></div>
            </div>
          </section>
        )}
        <p className="permission-wall__hint"><ShieldCheck size={15} weight="fill" />授权集中在这里完成。之后开始、停止或回放会议时，不会再主动打开系统设置或选择器。</p>
        {error && <p className="permission-wall__error" role="alert"><WarningCircle size={14} />{error}</p>}
      </div>
      <div className="permission-wall__note"><ShieldCheck size={16} /><span>录音前，请先获得所有参会者同意。你可以随时在系统设置中撤销权限。</span></div>
      <footer>
        <button className="button" onClick={refresh} disabled={checking}><ArrowClockwise size={15} className={checking ? "spin" : ""} />{screenSettingsOpened ? "立即检查" : "重新检查"}</button>
        <div>
          <span role="status" aria-live="polite">{nextStepHint}</span>
          {!allReady && <button className="permission-wall__skip" onClick={onSkip} disabled={checking}>暂不授权，先体验</button>}
          <button className="button button--primary" onClick={handlePrimary} disabled={checking}>{primaryLabel}</button>
        </div>
      </footer>
    </section>
  </div>;
}

/** 单条权限步骤：图标、说明、当前步骤和状态标签。主操作统一放在页脚。 */
function PermissionRow({ step, icon, title, description, value, current = false, waiting = false }: {
  step: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  value: SystemPermissionValue;
  current?: boolean;
  waiting?: boolean;
}) {
  const ready = value === "granted";
  const blocked = value === "denied" || value === "restricted";
  const label = ready ? "已允许" : waiting ? "等待设置" : blocked ? "未允许" : value === "not-determined" ? "待确认" : "待检查";
  const className = [ready ? "is-ready" : blocked ? "is-blocked" : "", current ? "is-current" : "", waiting ? "is-waiting" : ""].filter(Boolean).join(" ");
  return <article className={className} aria-current={current ? "step" : undefined}>
    <div className="permission-wall__icon">{icon}</div>
    <div><div className="permission-wall__title"><small>步骤 {step}</small><strong>{title}</strong><span>{ready ? <Check size={13} weight="bold" /> : <WarningCircle size={13} />}{label}</span></div><p>{description}</p></div>
  </article>;
}
