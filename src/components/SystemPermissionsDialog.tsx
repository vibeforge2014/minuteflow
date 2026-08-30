/**
 * 系统权限引导（首run第一道门）：按麦克风 → 系统设置 → 重启生效 →
 * 音频验证顺序渐进展开。正常录音、停止和回放流程永不主动打开系统设置。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  Check,
  CheckCircle,
  GearSix,
  Microphone,
  Monitor,
  Power,
  ShieldCheck,
  WarningCircle
} from "@phosphor-icons/react";
import { api } from "../lib/api";
import { derivePermissionSetupPhase, isScreenPermissionError } from "../lib/permissions";
import type { PermissionSetupPhase } from "../lib/permissions";
import type { SystemPermissionStatus, SystemPermissionValue } from "../types";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { BrandMark } from "./BrandMark";

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
  onSkip(): Promise<void>;
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
  const [capturePrepared, setCapturePrepared] = useState(!isMac);
  const [screenSettingsOpened, setScreenSettingsOpened] = useState(false);
  const [returnedFromScreenSettings, setReturnedFromScreenSettings] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completionStartedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const dialogRef = useDialogFocus<HTMLElement>(open, {
    initialFocus: ".permission-wall__footer .button--primary"
  });

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      if (!forceMacPreview) {
        const nextStatus = await api.system.getPermissions();
        setStatus(nextStatus);
        if (nextStatus.screen === "granted") {
          setScreenSettingsOpened(false);
          setReturnedFromScreenSettings(false);
        }
      }
    } finally {
      setChecking(false);
    }
  }, [forceMacPreview]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const handleFocus = () => {
      if (screenSettingsOpened) setReturnedFromScreenSettings(true);
      void refresh();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [open, refresh, screenSettingsOpened]);

  useEffect(() => {
    if (!open || !screenSettingsOpened || status.screen === "granted") return;
    let disposed = false;
    const checkInBackground = async () => {
      if (forceMacPreview) return;
      const nextStatus = await api.system.getPermissions().catch(() => null);
      if (disposed || !nextStatus) return;
      setStatus(nextStatus);
      if (nextStatus.screen === "granted") {
        setScreenSettingsOpened(false);
        setReturnedFromScreenSettings(false);
      }
    };
    const timer = window.setInterval(() => { void checkInBackground(); }, 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [forceMacPreview, open, screenSettingsOpened, status.screen]);

  const phase = derivePermissionSetupPhase({
    microphone: status.microphone,
    screen: status.screen,
    systemAudioRequired: status.systemAudioRequired,
    capturePrepared,
    returnedFromScreenSettings,
    restartRequired
  });

  useEffect(() => {
    if (!open || phase !== "success") {
      completionStartedRef.current = false;
      setCompleting(false);
      return;
    }
    if (completionStartedRef.current) return;
    completionStartedRef.current = true;
    setCompleting(true);
    const timer = window.setTimeout(() => {
      void onCompleteRef.current().catch((completeError) => {
        completionStartedRef.current = false;
        setCompleting(false);
        setError(completeError instanceof Error ? completeError.message : "无法保存权限设置，请重试。");
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [open, phase]);

  if (!open) return null;

  const requestMicrophone = async () => {
    setChecking(true);
    setError(null);
    try {
      if (forceMacPreview) {
        setStatus((current) => ({ ...current, microphone: "granted" }));
        return;
      }
      let microphone = await api.system.requestMicrophone();
      if (microphone !== "granted") {
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

  const openScreenSettings = async () => {
    setChecking(true);
    setError(null);
    setRestartRequired(false);
    setReturnedFromScreenSettings(false);
    try {
      await api.system.openSettings("screen");
      setScreenSettingsOpened(true);
      if (forceMacPreview) setReturnedFromScreenSettings(true);
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : "无法打开系统设置，请重试。");
    } finally {
      setChecking(false);
    }
  };

  const relaunchForPermissionSetup = async () => {
    setChecking(true);
    setError(null);
    try {
      if (forceMacPreview) {
        setStatus((current) => ({ ...current, screen: "granted" }));
        setRestartRequired(false);
        setReturnedFromScreenSettings(false);
        setScreenSettingsOpened(false);
        setChecking(false);
        return;
      }
      await api.system.relaunchForPermissionSetup();
    } catch (relaunchError) {
      setChecking(false);
      setError(relaunchError instanceof Error ? relaunchError.message : "无法重新启动 MinuteFlow，请手动退出后再打开。");
    }
  };

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
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const audioReady = stream.getAudioTracks().some((track) => track.readyState === "live");
      for (const track of stream.getTracks()) track.stop();
      if (!audioReady) throw new Error("没有检测到系统音频，请确认右侧开关已打开后重试。");
      setCapturePrepared(true);
    } catch (verifyError) {
      if (isScreenPermissionError(verifyError)) {
        setRestartRequired(true);
        setError("系统音频权限尚未生效。请重启 MinuteFlow 后继续，或重新打开系统设置检查开关。");
      } else {
        setError(verifyError instanceof Error ? verifyError.message : "无法验证系统音频，请重试。");
      }
    } finally {
      setChecking(false);
    }
  };

  const handlePrimary = async () => {
    if (phase === "microphone") {
      if (status.microphone === "denied" || status.microphone === "restricted") {
        await api.system.openSettings("microphone");
        return;
      }
      await requestMicrophone();
      return;
    }
    if (phase === "screen-settings") {
      await openScreenSettings();
      return;
    }
    if (phase === "restart") {
      await relaunchForPermissionSetup();
      return;
    }
    if (phase === "verify") await verifySystemAudio();
  };

  const copy = phaseCopy(phase, returningUser, screenSettingsOpened);

  return <div className="modal-backdrop permission-wall-backdrop">
    <section ref={dialogRef} className={`dialog permission-wall permission-wall--${phase}`} role="dialog" aria-modal="true" aria-labelledby="permission-wall-title">
      <header className="permission-wall__header">
        <div className="permission-wall__symbol">{phase === "success" ? <CheckCircle size={27} weight="duotone" /> : <ShieldCheck size={27} weight="duotone" />}</div>
        <div>
          <span>{copy.eyebrow}</span>
          <h2 id="permission-wall-title">{copy.title}</h2>
          <p>{copy.description}</p>
        </div>
      </header>

      <div className="permission-wall__list">
        <PermissionRow
          step={1}
          icon={<Microphone size={21} />}
          title="麦克风"
          description="录制你的声音，并用于本地或你选择的转写服务。"
          value={status.microphone}
          current={phase === "microphone"}
        />
        <PermissionRow
          step={2}
          icon={<Monitor size={21} />}
          title="系统音频"
          description="录制线上会议声音；macOS 将它归在“屏幕与系统音频录制”中，但 MinuteFlow 不保存屏幕画面。"
          value={status.systemAudioRequired ? status.screen : "granted"}
          current={phase === "screen-settings" || phase === "restart" || phase === "verify"}
          waiting={phase === "screen-settings" && screenSettingsOpened}
          restart={phase === "restart"}
        />

        {phase === "screen-settings" && (
          <section className="permission-wall__stage permission-wall__drag-guide" aria-label="把 MinuteFlow 添加到系统设置">
            <div className="permission-wall__drag-copy">
              <span>{screenSettingsOpened ? "系统设置已打开" : "如果列表里没有 MinuteFlow"}</span>
              <strong>{screenSettingsOpened ? "在系统设置中完成这 3 步" : "打开设置后，按这 3 步添加"}</strong>
              <ol>
                <li>从置顶小浮层按住 MinuteFlow 图标</li>
                <li>拖到“屏幕与系统音频录制”的应用列表</li>
                <li>打开右侧开关；如果列表自动开启，直接进行下一步</li>
              </ol>
              <p>拖不动时，可点浮层里的“在访达中显示”，再用列表下方的“+”添加。</p>
            </div>
            <div className="permission-wall__drag-route" aria-hidden="true">
              <div><BrandMark size={32} /><strong>MinuteFlow</strong></div>
              <ArrowRight size={18} weight="bold" />
              <div><GearSix size={26} weight="duotone" /><span><strong>系统设置</strong><small>屏幕与系统音频录制</small></span></div>
            </div>
          </section>
        )}

        {phase === "restart" && (
          <section className="permission-wall__stage permission-wall__restart" role="status">
            <Power size={24} weight="duotone" />
            <div>
              <strong>让新权限生效，需要重新启动一次</strong>
              <p>如果右侧开关已经打开，点“重启并继续”；MinuteFlow 会保存当前进度，重新打开后直接验证系统音频。</p>
            </div>
          </section>
        )}

        {phase === "verify" && (
          <section className="permission-wall__stage permission-wall__verify" role="status">
            <ShieldCheck size={24} weight="duotone" />
            <div>
              <strong>权限已打开，最后确认一次系统音频</strong>
              <p>只做一次极短的本地采集检查，不保存屏幕画面，也不会上传任何声音。</p>
            </div>
          </section>
        )}

        {phase === "success" && (
          <section className="permission-wall__stage permission-wall__success" role="status" aria-live="polite">
            <CheckCircle size={25} weight="fill" />
            <div>
              <strong>两项权限均已准备好</strong>
              <p>正在进入下一步设置，之后录音、停止和回放都不会再主动打开系统设置。</p>
            </div>
          </section>
        )}

        {error && <p className="permission-wall__error" role="alert"><WarningCircle size={14} />{error}</p>}
      </div>

      <div className="permission-wall__note"><ShieldCheck size={16} /><span>仅在你主动录音时访问声音；会议内容默认留在本机。录音前请先征得所有参会者同意。</span></div>

      <footer className="permission-wall__footer">
        {phase !== "success" ? (
          <button className="permission-wall__skip" onClick={onSkip} disabled={checking}>暂不授权，先体验</button>
        ) : <span />}
        <div>
          <span role="status" aria-live="polite">{copy.progress}</span>
          {phase === "restart" && <button className="button" onClick={openScreenSettings} disabled={checking}>重新打开系统设置</button>}
          {phase === "verify" && <button className="button" onClick={refresh} disabled={checking}><ArrowClockwise size={15} />重新检查权限</button>}
          <button className="button button--primary" onClick={handlePrimary} disabled={checking || completing || phase === "success"}>
            {checking ? (phase === "restart" ? "正在重新启动…" : "正在处理…") : copy.primary}
          </button>
        </div>
      </footer>
    </section>
  </div>;
}

function phaseCopy(phase: PermissionSetupPhase, returningUser: boolean, settingsOpened: boolean) {
  if (phase === "microphone") return {
    eyebrow: returningUser ? "权限更新 · 第 1 项，共 2 项" : "首次设置 · 第 1 项，共 2 项",
    title: returningUser ? "先重新确认麦克风权限" : "先允许麦克风",
    description: returningUser ? "已有权限不会被重置；确认后会继续处理系统音频。" : "完成当前一步后，才会展开系统音频的设置说明。",
    progress: "当前：麦克风",
    primary: "允许麦克风"
  };
  if (phase === "screen-settings") return {
    eyebrow: "首次设置 · 第 2 项，共 2 项",
    title: "再允许系统音频",
    description: "MinuteFlow 会打开正确的 macOS 设置页，并在上方提供可拖动的真实应用图标。",
    progress: settingsOpened ? "等待在系统设置中完成" : "当前：系统音频",
    primary: settingsOpened ? "重新打开系统设置" : "打开系统设置"
  };
  if (phase === "restart") return {
    eyebrow: "权限已修改 · 需要重启",
    title: "让系统音频权限生效",
    description: "macOS 在设置中修改屏幕录制权限后，需要重新启动应用一次。",
    progress: "进度会自动保留",
    primary: "重启并继续"
  };
  if (phase === "verify") return {
    eyebrow: "最后检查",
    title: "验证系统音频",
    description: "确认 MinuteFlow 可以听到线上会议声音；整个检查只在本机完成。",
    progress: "最后一步",
    primary: "验证系统音频"
  };
  return {
    eyebrow: "设置完成",
    title: "录音权限已准备好",
    description: "两项权限都可以正常使用。",
    progress: "正在进入下一步…",
    primary: "已完成"
  };
}

function PermissionRow({ step, icon, title, description, value, current = false, waiting = false, restart = false }: {
  step: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  value: SystemPermissionValue;
  current?: boolean;
  waiting?: boolean;
  restart?: boolean;
}) {
  const ready = value === "granted";
  const blocked = value === "denied" || value === "restricted";
  const label = ready ? "已允许" : restart ? "等待重启" : waiting ? "等待设置" : blocked ? "未允许" : value === "not-determined" ? "待确认" : "待检查";
  const className = [ready ? "is-ready" : blocked ? "is-blocked" : "", current ? "is-current" : "", waiting ? "is-waiting" : "", restart ? "is-restart" : ""].filter(Boolean).join(" ");
  return <article className={className} aria-current={current ? "step" : undefined}>
    <div className="permission-wall__icon">{icon}</div>
    <div>
      <div className="permission-wall__title"><small>权限 {step}</small><strong>{title}</strong><span>{ready ? <Check size={13} weight="bold" /> : restart ? <Power size={13} /> : <WarningCircle size={13} />}{label}</span></div>
      <p>{description}</p>
    </div>
  </article>;
}
