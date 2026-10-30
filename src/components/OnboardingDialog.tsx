/**
 * 首次模型配置向导：在系统权限流程之后，引导用户依次确认 Whisper 转录与
 * 大模型总结。向导只复用设置工作台的真实配置入口，不复制密钥或下载逻辑；
 * 返回向导时根据已保存档案即时显示就绪状态。
 */
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CheckCircle,
  Cloud,
  Cpu,
  Microphone,
  ShieldCheck,
  Sparkle,
  WarningCircle,
  Waveform
} from "@phosphor-icons/react";
import type { ModelProfile } from "../types";
import {
  isOnboardingSummaryReady,
  isOnboardingTranscriptionReady,
  LOCAL_WHISPER_TRANSPORTS
} from "../lib/onboarding";
import type { SettingsFocus, SettingsTab } from "./SettingsDialog";
import { api } from "../lib/api";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useExitPresence } from "../hooks/useExitPresence";

export function OnboardingDialog({
  open,
  profiles,
  onComplete,
  onConfigureModels
}: {
  open: boolean;
  profiles: ModelProfile[];
  onComplete(): Promise<void>;
  onConfigureModels(tab: Extract<SettingsTab, "transcription" | "llm">, focus?: SettingsFocus): void;
}) {
  const isMac = api.system.platform === "darwin";
  const [step, setStep] = useState(0);
  const transcriptionProfile = useMemo(
    () => profiles.find(isOnboardingTranscriptionReady),
    [profiles]
  );
  const summaryProfile = useMemo(
    () => profiles.find(isOnboardingSummaryReady),
    [profiles]
  );
  const dialogRef = useDialogFocus<HTMLElement>(open, {
    initialFocus: ".onboarding-wizard__footer .button--primary"
  });
  const { mounted, closing } = useExitPresence(open, 170);

  if (!mounted) return null;
  const steps = ["欢迎", "语音转录", "AI 纪要", "完成"];

  return (
    <div className={`modal-backdrop onboarding-backdrop ${closing ? "is-closing" : ""}`}>
      <section ref={dialogRef} className="dialog onboarding-dialog onboarding-wizard" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="onboarding-wizard__header">
          <div>
            <h2 id="onboarding-title">{steps[step]}</h2>
          </div>
          <div className="onboarding-wizard__steps" aria-label="设置进度">
            {steps.map((label, index) => (
              <div key={label} className={index === step ? "is-current" : index < step ? "is-complete" : ""}>
                <span>{index < step ? <CheckCircle size={14} weight="fill" /> : index + 1}</span>
                <small>{label}</small>
              </div>
            ))}
          </div>
        </header>

        <div className="onboarding-wizard__body">
          {step === 0 && <WelcomeStep />}
          {step === 1 && (
            <ModelSetupStep
              icon={<Waveform size={28} weight="duotone" />}
              title="先让声音变成可靠文字"
              ready={Boolean(transcriptionProfile)}
              readyTitle={transcriptionProfile ? `${transcriptionProfile.name} 已启用` : "尚未配置转录模型"}
              readyDescription={transcriptionProfile
                ? transcriptionProfile.transport === "apple-speech"
                  ? "音频不出本机"
                  : `${LOCAL_WHISPER_TRANSPORTS.has(transcriptionProfile.transport) ? "在本机完成转写" : "通过你选择的服务转写"} · ${transcriptionProfile.model || "自动模型"}`
                : "你仍可继续，但会议只会保存录音，无法自动生成文字稿。"}
              actionLabel={transcriptionProfile ? "检查或更换转写方式" : "去配置转写"}
              onConfigure={() => onConfigureModels("transcription", isMac ? "apple-speech" : "local-whisper")}
            >
              {isMac && (
                <SetupChoice icon={<Waveform size={20} />} title="Apple 语音识别" description="免费 · 零下载 · 音频不出本机 · 中文优先" recommended onClick={() => onConfigureModels("transcription", "apple-speech")} />
              )}
              <SetupChoice icon={<Cpu size={20} />} title="本地 Whisper" description={isMac ? "更高转写质量 · 需下载模型" : "离线 · 音频不出本机 · 需下载模型"} recommended={!isMac} onClick={() => onConfigureModels("transcription", "local-whisper")} />
              <SetupChoice icon={<Cloud size={20} />} title="在线 Whisper" description="需服务地址与密钥" onClick={() => onConfigureModels("transcription", "online-transcription")} />
            </ModelSetupStep>
          )}
          {step === 2 && (
            <ModelSetupStep
              icon={<Brain size={28} weight="duotone" />}
              title="把文字整理成可执行纪要"
              ready={Boolean(summaryProfile)}
              readyTitle={summaryProfile ? `${summaryProfile.name} 已启用` : "当前使用本机基础纪要"}
              readyDescription={summaryProfile
                ? `${summaryProfile.model} · 仅在你主动生成终稿时访问服务`
                : "纪要会降级为本机规则整理，可稍后补充模型。"}
              actionLabel={summaryProfile ? "检查或更换大模型" : "去配置大模型"}
              onConfigure={() => onConfigureModels("llm")}
            >
              <SetupChoice icon={<Sparkle size={20} />} title="在线大模型" description="质量更高 · 需配置密钥" recommended />
              <SetupChoice icon={<ShieldCheck size={20} />} title="本机基础纪要" description="完全离线 · 无需密钥" />
            </ModelSetupStep>
          )}
          {step === 3 && (
            <ReadyStep transcriptionProfile={transcriptionProfile} summaryProfile={summaryProfile} />
          )}
        </div>

        <footer className="onboarding-wizard__footer">
          <button className="button" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>
            <ArrowLeft size={15} />返回
          </button>
          <div>
            {step < 3 ? (
              <button className="button button--primary" onClick={() => setStep((current) => Math.min(3, current + 1))}>
                {step === 0 ? "开始配置" : step === 1 && !transcriptionProfile ? "仅保存录音，继续" : step === 2 && !summaryProfile ? "使用基础纪要，继续" : "继续"}<ArrowRight size={15} />
              </button>
            ) : (
              <button className="button button--primary" onClick={onComplete}>进入 MinuteFlow</button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function WelcomeStep() {
  return <div className="onboarding-welcome">
    <div className="onboarding-welcome__mark"><Microphone size={34} weight="duotone" /></div>
    <h3>先配置两项能力，会议结束后就能直接拿到纪要</h3>
    <p>录音、会议和索引默认保存在本机；远程服务只在对应功能被使用时才会收到必要内容。</p>
    <div className="onboarding-welcome__flow">
      <article><Waveform size={22} /><div><strong>语音转录</strong><small>声音 → 简体中文文字稿</small></div></article>
      <ArrowRight size={17} />
      <article><Brain size={22} /><div><strong>大模型总结</strong><small>文字稿 → 普通/视觉纪要</small></div></article>
    </div>
  </div>;
}

function ModelSetupStep({ icon, title, ready, readyTitle, readyDescription, actionLabel, onConfigure, children }: {
  icon: React.ReactNode;
  title: string;
  ready: boolean;
  readyTitle: string;
  readyDescription: string;
  actionLabel: string;
  onConfigure(): void;
  children: React.ReactNode;
}) {
  return <div className="onboarding-model-step">
    <div className="onboarding-model-step__intro">
      <div className="onboarding-model-step__icon">{icon}</div>
      <div><h3>{title}</h3></div>
    </div>
    <div className="onboarding-model-step__choices">{children}</div>
    <div className={`onboarding-model-status ${ready ? "is-ready" : ""}`}>
      {ready ? <CheckCircle size={21} weight="fill" /> : <WarningCircle size={21} />}
      <div><strong>{readyTitle}</strong><small>{readyDescription}</small></div>
      <button className={`button ${ready ? "" : "button--primary"}`} onClick={onConfigure}>{actionLabel}</button>
    </div>
  </div>;
}

function SetupChoice({ icon, title, description, recommended = false, onClick }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  recommended?: boolean;
  onClick?(): void;
}) {
  const content = <>
    <span>{icon}</span>
    <div><strong>{title}{recommended && <em>推荐</em>}</strong><small>{description}</small></div>
  </>;
  const label = `${title}${recommended ? "，推荐" : ""}`;
  // 两个选项都是真实入口：点「本地 Whisper」直接落到本地模型下载/选择，
  // 点「在线 Whisper」直接落到在线表单，不再要求用户先进入设置自己找。
  if (onClick) {
    return <button type="button" className="setup-choice" aria-label={`${label}，打开配置`} onClick={onClick}>{content}</button>;
  }
  return <article aria-label={label}>{content}</article>;
}

function ReadyStep({ transcriptionProfile, summaryProfile }: {
  transcriptionProfile?: ModelProfile;
  summaryProfile?: ModelProfile;
}) {
  return <div className="onboarding-ready">
    <div className="onboarding-ready__symbol"><CheckCircle size={42} weight="duotone" /></div>
    <h3>MinuteFlow 已准备好记录下一场会议</h3>
    <p>远程总结由你主动发起；服务可随时在“设置”中更换。</p>
    <div className="onboarding-ready__summary">
      <article className={transcriptionProfile ? "is-ready" : ""}>
        <Waveform size={20} /><div><strong>语音转录</strong><small>{transcriptionProfile ? transcriptionProfile.name : "未配置 · 仅保存录音"}</small></div>
      </article>
      <article className={summaryProfile ? "is-ready" : ""}>
        <Brain size={20} /><div><strong>AI 纪要</strong><small>{summaryProfile ? summaryProfile.name : "本机基础纪要"}</small></div>
      </article>
    </div>
    <div className="onboarding-ready__privacy"><ShieldCheck size={16} weight="fill" />API Key 保存在系统安全存储，会议数据默认留在本机。</div>
  </div>;
}
