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
import type { SettingsTab } from "./SettingsDialog";
import { useDialogFocus } from "../hooks/useDialogFocus";

export function OnboardingDialog({
  open,
  profiles,
  onComplete,
  onConfigureModels
}: {
  open: boolean;
  profiles: ModelProfile[];
  onComplete(): Promise<void>;
  onConfigureModels(tab: Extract<SettingsTab, "transcription" | "llm">): void;
}) {
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

  if (!open) return null;
  const steps = ["欢迎", "语音转录", "AI 纪要", "完成"];

  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section ref={dialogRef} className="dialog onboarding-dialog onboarding-wizard" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="onboarding-wizard__header">
          <div>
            <span>首次设置 · {step + 1}/{steps.length}</span>
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
              eyebrow="第一项 · Whisper"
              title="先让声音变成可靠文字"
              description="选择本地 Whisper 模型，或配置兼容的在线转录服务。MinuteFlow 不会在你开始录音时临时弹出模型设置。"
              ready={Boolean(transcriptionProfile)}
              readyTitle={transcriptionProfile ? `${transcriptionProfile.name} 已启用` : "尚未配置转录模型"}
              readyDescription={transcriptionProfile
                ? `${LOCAL_WHISPER_TRANSPORTS.has(transcriptionProfile.transport) ? "在本机完成转写" : "通过你选择的服务转写"} · ${transcriptionProfile.model || "自动模型"}`
                : "你仍可继续，但会议只会保存录音，无法自动生成文字稿。"}
              actionLabel={transcriptionProfile ? "检查或更换 Whisper" : "去配置 Whisper"}
              onConfigure={() => onConfigureModels("transcription")}
            >
              <SetupChoice icon={<Cpu size={20} />} title="本地 Whisper" description="下载后离线运行，适合重视隐私的会议。" recommended />
              <SetupChoice icon={<Cloud size={20} />} title="在线 Whisper" description="使用 OpenAI 或兼容接口，适合轻量设备。" />
            </ModelSetupStep>
          )}
          {step === 2 && (
            <ModelSetupStep
              icon={<Brain size={28} weight="duotone" />}
              eyebrow="第二项 · 大模型"
              title="把文字整理成可执行纪要"
              description="配置总结模型后，MinuteFlow 才会生成在线终稿；视觉纪要还需要在设置中开启并通过真实结构测试。"
              ready={Boolean(summaryProfile)}
              readyTitle={summaryProfile ? `${summaryProfile.name} 已启用` : "当前使用本机基础纪要"}
              readyDescription={summaryProfile
                ? `${summaryProfile.model} · 仅在你主动生成终稿时访问服务`
                : "不影响录音和转写，纪要会降级为本机规则整理，可稍后补充模型。"}
              actionLabel={summaryProfile ? "检查或更换大模型" : "去配置大模型"}
              onConfigure={() => onConfigureModels("llm")}
            >
              <SetupChoice icon={<Sparkle size={20} />} title="在线大模型" description="生成高质量结构化终稿，并可启用视觉纪要。" recommended />
              <SetupChoice icon={<ShieldCheck size={20} />} title="本机基础纪要" description="无需密钥，内容不上传，信息密度较低。" />
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
            {step === 1 && !transcriptionProfile && <span>继续即明确选择“仅保存录音”</span>}
            {step === 2 && !summaryProfile && <span>继续即使用“本机基础纪要”</span>}
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
    <span>欢迎使用 MinuteFlow</span>
    <h3>先配置两项能力，会议结束后就能直接拿到纪要</h3>
    <p>我们会依次检查语音转录和 AI 总结。录音、会议和索引仍默认保存在本机，远程服务只在对应功能被使用时收到必要内容。</p>
    <div className="onboarding-welcome__flow">
      <article><Waveform size={22} /><div><strong>Whisper 转录</strong><small>声音 → 简体中文文字稿</small></div></article>
      <ArrowRight size={17} />
      <article><Brain size={22} /><div><strong>大模型总结</strong><small>文字稿 → 普通/视觉纪要</small></div></article>
    </div>
  </div>;
}

function ModelSetupStep({ icon, eyebrow, title, description, ready, readyTitle, readyDescription, actionLabel, onConfigure, children }: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  description: string;
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
      <div><span>{eyebrow}</span><h3>{title}</h3><p>{description}</p></div>
    </div>
    <div className="onboarding-model-step__choices">{children}</div>
    <div className={`onboarding-model-status ${ready ? "is-ready" : ""}`}>
      {ready ? <CheckCircle size={21} weight="fill" /> : <WarningCircle size={21} />}
      <div><strong>{readyTitle}</strong><small>{readyDescription}</small></div>
      <button className={`button ${ready ? "" : "button--primary"}`} onClick={onConfigure}>{actionLabel}</button>
    </div>
  </div>;
}

function SetupChoice({ icon, title, description, recommended = false }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  recommended?: boolean;
}) {
  return <article aria-label={`${title}${recommended ? "，推荐" : ""}`}>
    <span>{icon}</span>
    <div><strong>{title}{recommended && <em>推荐</em>}</strong><small>{description}</small></div>
  </article>;
}

function ReadyStep({ transcriptionProfile, summaryProfile }: {
  transcriptionProfile?: ModelProfile;
  summaryProfile?: ModelProfile;
}) {
  return <div className="onboarding-ready">
    <div className="onboarding-ready__symbol"><CheckCircle size={42} weight="duotone" /></div>
    <span>设置完成</span>
    <h3>MinuteFlow 已准备好记录下一场会议</h3>
    <p>之后可以随时从“设置”更换服务。停止录音只会完成本地保存，远程总结仍由你主动发起。</p>
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
