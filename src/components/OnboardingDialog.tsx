import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Brain,
  CheckCircle,
  Cloud,
  Cpu,
  FingerprintSimple,
  Microphone,
  ShieldCheck,
  Sparkle,
  WarningCircle,
  Waveform
} from "@phosphor-icons/react";
import type { ModelDownloadProgress, ModelProfile } from "../types";
import {
  isOnboardingDiarizationReady,
  isOnboardingSummaryReady,
  isOnboardingTranscriptionReady
} from "../lib/onboarding";
import type { SettingsFocus, SettingsTab } from "./SettingsDialog";
import { api, isElectronRuntime } from "../lib/api";
import { DIARIZATION_SETUP_MODELS, diarizationSlotOf, prepareDiarizationModels } from "../lib/diarization-setup";
import { useMeetingStore } from "../store/meetingStore";
import { OnboardingSummarySample } from "./OnboardingSummarySample";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useExitPresence } from "../hooks/useExitPresence";

export function OnboardingDialog({
  open,
  profiles,
  savedModel,
  canGenerateSample,
  onComplete,
  onConfigureModels
}: {
  open: boolean;
  profiles: ModelProfile[];
  savedModel?: ModelProfile;
  canGenerateSample: boolean;
  onComplete(): Promise<void>;
  onConfigureModels(tab: Extract<SettingsTab, "transcription" | "llm">, focus: SettingsFocus): void;
}) {
  const isMac = api.system.platform === "darwin";
  const [step, setStep] = useState(0);
  const [sampleRequest, setSampleRequest] = useState<{ profile: ModelProfile; id: string }>();
  const [speakerSetup, setSpeakerSetup] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [speakerError, setSpeakerError] = useState("");
  const [download, setDownload] = useState<ModelDownloadProgress | null>(null);
  const installingSpeakers = useRef(false);
  const transcriptionProfile = profiles.find((profile) => profile.isDefault && isOnboardingTranscriptionReady(profile)) ?? profiles.find(isOnboardingTranscriptionReady);
  const diarizationProfile = profiles.find(isOnboardingDiarizationReady);
  const summaryProfile = profiles.find((profile) => profile.isDefault && isOnboardingSummaryReady(profile)) ?? profiles.find(isOnboardingSummaryReady);

  useEffect(() => {
    if (savedModel?.kind === "stt") setStep(2);
    if (savedModel?.kind === "llm") setSampleRequest({ profile: savedModel, id: crypto.randomUUID() });
  }, [savedModel]);

  const installSpeakers = useCallback(async () => {
    if (!isElectronRuntime || installingSpeakers.current) return;
    installingSpeakers.current = true;
    setSpeakerSetup("working");
    setDownload(null);
    const unsubscribe = api.models.onDownloadProgress((progress) => {
      if (DIARIZATION_SETUP_MODELS.some((model) => model.id === progress.modelId)) setDownload(progress);
    });
    try {
      const existing = (await api.models.list()).filter((model) => model.kind === "diarization" && model.transport === "sherpa-onnx");
      if (!existing.some(isOnboardingDiarizationReady)) {
        await prepareDiarizationModels(existing.find((model) => model.isDefault) ?? existing[0] ?? {
          name: "本地声纹识别", model: "Pyannote + 3D-Speaker", kind: "diarization",
          transport: "sherpa-onnx", baseUrl: "", enabled: true, options: {}
        }, api.models, (model) => setDownload({
          modelId: model.id, downloadedBytes: 0, totalBytes: model.sizeBytes, status: "preparing"
        }));
      }
      await useMeetingStore.getState().loadProfiles();
      setSpeakerSetup("ready");
    } catch (error) {
      setSpeakerError(error instanceof Error ? error.message : "无法配置发言人识别，请重试。");
      setSpeakerSetup("error");
    } finally {
      installingSpeakers.current = false;
      unsubscribe();
    }
  }, []);

  useEffect(() => {
    if (open && step === 2 && !diarizationProfile && speakerSetup === "idle") void installSpeakers();
  }, [open, step, diarizationProfile, speakerSetup, installSpeakers]);

  const dialogRef = useDialogFocus<HTMLElement>(open, {
    initialFocus: ".onboarding-wizard__footer .button--primary"
  });
  const { mounted, closing } = useExitPresence(open, 170);

  if (!mounted) return null;
  const steps = ["欢迎", "语音转录", "发言人识别", "AI 纪要", "完成"];

  const lastStep = steps.length - 1;
  const finish = async () => {
    await onComplete();
    setStep(0);
    setSampleRequest(undefined);
    setSpeakerSetup((current) => current === "working" ? current : "idle");
  };
  const speakerReady = Boolean(diarizationProfile) || speakerSetup === "ready";
  const continueLabel = [
    "开始配置",
    transcriptionProfile ? "继续" : "先仅保存录音",
    speakerReady ? "继续" : speakerSetup === "working" ? "后台下载，继续" : "稍后配置",
    summaryProfile ? "继续" : "稍后配置"
  ][step];

  return (
    <div inert={!open} className={`modal-backdrop onboarding-backdrop ${closing ? "is-closing" : ""}`}>
      <section ref={dialogRef} className="dialog onboarding-dialog onboarding-wizard" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="onboarding-wizard__header">
          <div>
            <h2 id="onboarding-title">{steps[step]}</h2>
          </div>
          <div className="onboarding-wizard__steps" aria-label="设置进度">
            {steps.map((label, index) => (
              <div key={label} aria-current={index === step ? "step" : undefined} className={index === step ? "is-current" : index < step ? "is-complete" : ""}>
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
              title="选择转录方式"
              ready={Boolean(transcriptionProfile)}
              readyTitle={transcriptionProfile ? `${transcriptionProfile.name} 已配置` : "尚未配置转录模型"}
              readyDescription={transcriptionProfile
                ? transcriptionProfile.transport === "apple-speech"
                  ? (transcriptionProfile.options.allowServer ? "已启用 Apple 在线识别" : "在本机转录")
                  : (transcriptionProfile.model || "自动模型")
                : "你仍可继续，但会议只会保存录音，无法自动生成文字稿。"}
              actionLabel={transcriptionProfile ? "检查或更换转写方式" : "去配置转写"}
              onConfigure={() => onConfigureModels("transcription", isMac ? "apple-speech" : "local-whisper")}
            >
              {isMac && (
                <SetupChoice icon={<Waveform size={20} />} title="Apple 语音识别" description="无需下载模型 · 默认离线" recommended onClick={() => onConfigureModels("transcription", "apple-speech")} />
              )}
              <SetupChoice icon={<Cpu size={20} />} title="本地 Whisper" description="离线转录 · 选择或下载模型" recommended={!isMac} onClick={() => onConfigureModels("transcription", "local-whisper")} />
              <SetupChoice icon={<Cloud size={20} />} title="在线 Whisper" description="需服务地址与密钥" onClick={() => onConfigureModels("transcription", "online-transcription")} />
            </ModelSetupStep>
          )}
          {step === 2 && (
            <SpeakerSetupStep ready={speakerReady} error={speakerSetup === "error" ? speakerError : ""} download={download} onRetry={() => void installSpeakers()} transcription={savedModel?.kind === "stt" ? savedModel : undefined} />
          )}
          {step === 3 && (sampleRequest ? (
            <OnboardingSummarySample key={sampleRequest.id} profile={sampleRequest.profile} canGenerate={canGenerateSample} onConfigure={() => onConfigureModels("llm", sampleRequest.profile.transport === "ollama" ? "ollama-summary" : "online-summary")} />
          ) : (
            <ModelSetupStep
              icon={<Brain size={28} weight="duotone" />}
              title="选择 AI 纪要模型"
              ready={Boolean(summaryProfile)}
              readyTitle={summaryProfile ? `${summaryProfile.model} 已配置` : "尚未配置总结模型"}
              readyDescription={summaryProfile ? "可用示例转写查看纪要效果。" : "配置后可根据转写生成纪要。"}
              actionLabel={summaryProfile ? "查看纪要示例" : "去配置大模型"}
              onConfigure={() => summaryProfile ? setSampleRequest({ profile: summaryProfile, id: crypto.randomUUID() }) : onConfigureModels("llm", "online-summary")}
            >
              <SetupChoice icon={<Sparkle size={20} />} title="在线大模型" description="选择服务商并配置密钥" onClick={() => onConfigureModels("llm", "online-summary")} />
              <SetupChoice icon={<Cpu size={20} />} title="Ollama" description="使用本机已安装的 Ollama" onClick={() => onConfigureModels("llm", "ollama-summary")} />
            </ModelSetupStep>
          ))}
          {step === lastStep && (
            <ReadyStep transcriptionProfile={transcriptionProfile} diarizationProfile={diarizationProfile} summaryProfile={summaryProfile} />
          )}
        </div>

        <footer className="onboarding-wizard__footer">
          <button className="button" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>
            <ArrowLeft size={15} />返回
          </button>
          <div>
            {step < lastStep && <button type="button" className="text-button onboarding-skip" onClick={finish}>退出引导</button>}
            {step < lastStep ? (
              <button className="button button--primary" onClick={() => setStep((current) => Math.min(lastStep, current + 1))}>
                {continueLabel}<ArrowRight size={15} />
              </button>
            ) : (
              <button className="button button--primary" onClick={finish}>进入 MinuteFlow</button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function SpeakerSetupStep({ ready, error, download, onRetry, transcription }: {
  ready: boolean;
  error: string;
  download: ModelDownloadProgress | null;
  onRetry(): void;
  transcription?: ModelProfile;
}) {
  const percent = download?.status === "downloading" && download.totalBytes > 0
    ? Math.min(100, Math.floor(download.downloadedBytes / download.totalBytes * 100))
    : undefined;
  const slot = download ? diarizationSlotOf(download.modelId) : null;
  const modelLabel = slot === "segmentation" ? "说话人分离模型" : "声纹模型";
  const progressLabel = !download ? "正在检测本机模型…"
    : download.status === "verifying" ? `正在校验${modelLabel}…`
    : download.status === "ready" ? `正在配置${modelLabel}…`
    : percent !== undefined ? `正在下载${modelLabel} · ${percent}%` : `正在准备${modelLabel}…`;

  return <section className="onboarding-model-step onboarding-speaker">
    {transcription && <div className="onboarding-speaker__configured" role="status"><CheckCircle size={17} weight="fill" />转录已配置 · {transcription.model || transcription.name}</div>}
    <div className="onboarding-model-step__intro">
      <div className="onboarding-model-step__icon"><FingerprintSimple size={28} weight="duotone" /></div>
      <div><h3>区分谁在说话</h3><p>模型在本机运行，声纹保存在本机。</p></div>
    </div>
    <div className="onboarding-speaker__example">
      <p><strong>发言人 1</strong> 我来整理试用反馈。</p>
      <p><strong>发言人 2</strong> 我周五确认上线时间。</p>
    </div>
    <div className="onboarding-speaker__uses">
      <p><strong>说话人分离</strong> 将不同人的发言分别标记。</p>
      <p><strong>声纹识别</strong> 给发言人改名后，后续可匹配已记住的名字。</p>
    </div>
    {ready ? <div className="onboarding-speaker__configured" role="status"><CheckCircle size={18} weight="fill" />发言人识别已就绪</div>
      : error ? <div className="connection-status is-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={onRetry}><ArrowClockwise size={15} />重试</button></div>
      : isElectronRuntime ? <div className="onboarding-speaker__progress">
        <div role="status">{progressLabel}</div>
        <progress aria-label="发言人模型下载进度" max={100} value={percent} />
      </div> : <p className="settings-hint">桌面版会自动检测并下载缺少的模型。</p>}
  </section>;
}

function WelcomeStep() {
  return <div className="onboarding-welcome">
    <div className="onboarding-welcome__mark"><Microphone size={34} weight="duotone" /></div>
    <h3>配置你的会议助手</h3>
    <p>录音与会议默认保存在本机。</p>
    <div className="onboarding-welcome__flow">
      <article><Waveform size={22} /><div><strong>语音转录</strong><small>把录音转成文字</small></div></article>
      <article><FingerprintSimple size={22} /><div><strong>发言人识别</strong><small>区分多人发言</small></div></article>
      <article><Brain size={22} /><div><strong>AI 纪要</strong><small>从转写生成纪要</small></div></article>
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
  children?: React.ReactNode;
}) {
  return <div className="onboarding-model-step">
    <div className="onboarding-model-step__intro">
      <div className="onboarding-model-step__icon">{icon}</div>
      <div><h3>{title}</h3></div>
    </div>
    {children && <div className="onboarding-model-step__choices">{children}</div>}
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
  onClick(): void;
}) {
  const content = <>
    <span>{icon}</span>
    <div><strong>{title}{recommended && <em>推荐</em>}</strong><small>{description}</small></div>
  </>;
  const label = `${title}${recommended ? "，推荐" : ""}`;
  return <button type="button" className="setup-choice" aria-label={`${label}，打开配置`} onClick={onClick}>{content}</button>;
}

function ReadyStep({ transcriptionProfile, diarizationProfile, summaryProfile }: {
  transcriptionProfile?: ModelProfile;
  diarizationProfile?: ModelProfile;
  summaryProfile?: ModelProfile;
}) {
  return <div className="onboarding-ready">
    <div className="onboarding-ready__symbol"><CheckCircle size={42} weight="duotone" /></div>
    <h3>MinuteFlow 已准备好记录下一场会议</h3>

    <div className="onboarding-ready__summary">
      <article className={transcriptionProfile ? "is-ready" : ""}>
        <Waveform size={20} /><div><strong>语音转录</strong><small>{transcriptionProfile ? transcriptionProfile.name : "未配置 · 仅保存录音"}</small></div>
      </article>
      <article className={diarizationProfile ? "is-ready" : ""}>
        <FingerprintSimple size={20} /><div><strong>发言人识别</strong><small>{diarizationProfile ? "已配置" : "待配置"}</small></div>
      </article>
      <article className={summaryProfile ? "is-ready" : ""}>
        <Brain size={20} /><div><strong>AI 纪要</strong><small>{summaryProfile ? summaryProfile.model || summaryProfile.name : "待配置"}</small></div>
      </article>
    </div>
    <div className="onboarding-ready__privacy"><ShieldCheck size={16} weight="fill" />API Key 保存在系统安全存储，会议数据默认留在本机。</div>
  </div>;
}
