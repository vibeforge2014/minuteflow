/**
 * 导入任务抽屉（工作区右滑层）：音频导入的确认与队列界面。
 * 上半部分是「待确认文件」——可改标题、选语言/转录/总结模型、开关说话人分离，
 * 确认后文件立即归档并入队；下半部分是后台任务队列（单 worker 串行），
 * 支持重试、取消、等待配置（缺模型时任务可恢复暂停而非失败）。
 */
import { ArrowClockwise, Check, FileAudio, GearSix, Pause, Trash, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { ImportCandidate, ImportJob, ModelProfile } from "../types";
import { useEnteringItemIds } from "../hooks/useContentMotion";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { formatDuration } from "../lib/format";

import { ImportProcessingMeta } from "./ImportProcessingMeta";

interface Props {
  open: boolean;
  /** 已选择/拖入、尚未确认入队的文件。 */
  candidates: ImportCandidate[];
  /** 后台任务队列（含历史任务）。 */
  jobs: ImportJob[];
  profiles: ModelProfile[];
  /** 全局默认转写语言（设置页「默认转写语言」），档案未单独设置时沿用。 */
  transcriptionLanguage?: string;
  onClose(): void;
  onPick(): void;
  onChange(items: ImportCandidate[]): void;
  onEnqueue(items: ImportCandidate[], options: { language: string; sttProfileId?: string; llmProfileId?: string; diarizationEnabled: boolean; autoSummarize: boolean }): Promise<void>;
  onRetry(id: string): void;
  onCancel(id: string): void;
  /** 说话人识别耗时过长时跳过，先用现有转录继续生成纪要。 */
  onSkipDiarization(id: string): void;
  /** 从队列移除终态/等待态任务记录（不影响已创建的会议）。 */
  onRemove(id: string): void;
  onOpenMeeting(id: string): void;
  onConfigure(): void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  auto: "自动识别", zh: "中文", en: "English", ja: "日本語", ko: "한국어", yue: "粤语"
};

/** 本次任务的语言与解码参数摘要：值来自所选档案，抽屉里显式改的只有语言。 */
function describeTaskProfile(profile: ModelProfile | undefined, language: string, globalLanguage: string) {
  if (!profile) return "尚未选择转录档案；音频会先安全归档。";
  const profileLanguage = profile.options?.transcriptionLanguage;
  // 与主进程 resolveTranscriptionLanguage 同序：本次指定 → 档案 → 全局默认 → 中文。
  const effective = language || profileLanguage || globalLanguage || "zh";
  const languageLabel = LANGUAGE_LABELS[effective] ?? effective;
  const languageSource = language ? "本次指定" : profileLanguage ? "沿用档案" : "沿用默认设置";
  // 预设与档案参数是同一套映射（见 lib/transcription-presets.ts）：这里据实际参数反推，
  // 不做额外承诺，避免出现「界面说准确优先、实际跑的是别的参数」。
  const beam = profile.options?.beamSize;
  const temperature = profile.options?.temperature;
  const tuning = typeof beam === "number" && beam >= 5
    ? "准确优先参数"
    : typeof beam === "number" && beam <= 1
      ? "速度优先参数"
      : undefined;
  const parts = [`语言 ${languageLabel}（${languageSource}）`];
  if (tuning) parts.push(tuning);
  if (typeof temperature === "number") parts.push(`temperature ${temperature}`);
  return `「${profile.name}」· ${parts.join(" · ")}`;
}

/** 任务状态 → 用户可读文案；waiting_* 是可恢复的等待态（缺组件，或网络波动自动断点续跑）。 */
const statusText: Record<ImportJob["status"], string> = {
  queued: "等待处理", copying: "正在复制", preparing: "准备音频", transcribing: "转录中",
  diarizing: "识别发言人", summarizing: "生成纪要", waiting_for_model: "等待配置转录",
  waiting_for_summary_model: "等待配置总结", waiting_for_audio_tool: "等待音频组件",
  waiting_for_network: "等待网络，自动续跑",
  complete: "已完成", cancelled: "已暂停，可继续", failed: "处理失败"
};

export function ImportDrawer(props: Props) {
  // 列出全部已保存的 stt/llm 档案（智谱式多可用）：导入是任务级选择，逐单勾选，
  // 默认档预选；与设置页互不影响。
  const sttProfiles = useMemo(() => props.profiles.filter((profile) => profile.kind === "stt"), [props.profiles]);
  const llmProfiles = useMemo(() => props.profiles.filter((profile) => profile.kind === "llm"), [props.profiles]);
  const defaultSttId = () => sttProfiles.find((profile) => profile.isDefault)?.id || sttProfiles[0]?.id || "";
  const defaultLlmId = () => llmProfiles.find((profile) => profile.isDefault)?.id || llmProfiles[0]?.id || "";
  const [language, setLanguage] = useState("");
  useEffect(() => { if (props.open) setLanguage(""); }, [props.open]);
  const [sttProfileId, setSttProfileId] = useState(defaultSttId);
  const [llmProfileId, setLlmProfileId] = useState(defaultLlmId);
  const [diarizationEnabled, setDiarizationEnabled] = useState(true);
  // 自动纪要曾经被硬编码为 true：想先自己看转录的人没有办法关掉模型调用。
  const [autoSummarize, setAutoSummarize] = useState(true);
  const selectedStt = sttProfiles.find((profile) => profile.id === sttProfileId);
  // 档案没设语言时，实际跑的是设置页的全局默认语言（主进程 resolveTranscriptionLanguage），
  // 这里必须同步显示它，否则界面承诺「自动识别」、实际按中文跑。
  const globalLanguage = props.transcriptionLanguage || "zh";
  const inheritedLanguage = selectedStt?.options?.transcriptionLanguage || globalLanguage;
  const inheritedLanguageLabel = LANGUAGE_LABELS[inheritedLanguage] ?? inheritedLanguage;
  const inheritedLanguageSource = selectedStt?.options?.transcriptionLanguage ? "档案" : "默认设置";
  const [busy, setBusy] = useState(false);
  // 抽屉同样按对话框管理键盘：Escape 收起、Tab 不跑到背后的工作区。
  const drawerRef = useDialogFocus<HTMLElement>(props.open, { onEscape: props.onClose });
  const enteringCandidates = useEnteringItemIds("import-candidates", props.candidates.map((file) => file.sourcePath));
  const enteringJobs = useEnteringItemIds("import-jobs", props.jobs.map((job) => job.id));
  // 队列是 FIFO：排队顺位按创建时间计算，和处理 worker 的取用顺序一致。
  const queuedOrder = useMemo(() => {
    const queued = props.jobs
      .filter((job) => job.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return new Map(queued.map((job, index) => [job.id, index + 1]));
  }, [props.jobs]);

  // 档案列表后加载（如刚打开设置保存了新档案）时，把空选择补默认值（优先启用项）。
  useEffect(() => { if (!sttProfileId && sttProfiles.length) setSttProfileId(sttProfiles.find((profile) => profile.isDefault)?.id || sttProfiles[0]?.id || ""); }, [sttProfileId, sttProfiles]);
  useEffect(() => { if (!llmProfileId && llmProfiles.length) setLlmProfileId(llmProfiles.find((profile) => profile.isDefault)?.id || llmProfiles[0]?.id || ""); }, [llmProfileId, llmProfiles]);

  if (!props.open) return null;
  // 仍在处理中的任务数（用于副标题提示）。
  const activeCount = props.jobs.filter((job) => !["complete", "cancelled", "failed"].includes(job.status)).length;

  return (
    <aside ref={drawerRef} className="import-drawer" aria-labelledby="import-drawer-title">
      <header className="import-drawer__header">
        <div><h2 id="import-drawer-title">导入任务</h2>{activeCount > 0 && <p>{activeCount} 项正在后台处理</p>}</div>
        <button className="icon-button" aria-label="收起导入任务" onClick={props.onClose}><X size={19} /></button>
      </header>

      {props.candidates.length > 0 && (
        <section className="import-confirm">
          <div className="import-section-title"><span>待确认文件 · {props.candidates.length}</span><button onClick={props.onPick}>继续添加</button></div>
          <div className="import-files">
            {props.candidates.map((file, index) => (
              <div className={`import-file ${enteringCandidates.has(file.sourcePath) ? "content-motion-enter" : ""}`} key={`${file.sourcePath}-${index}`}>
                <div className="import-file__icon"><FileAudio size={20} /></div>
                <div className="import-file__body">
                  <input
                    aria-label={`${file.name} 的会议标题`}
                    placeholder="为这份录音填写会议标题"
                    value={file.title}
                    onChange={(event) => {
                      const next = [...props.candidates]; next[index] = { ...file, title: event.target.value }; props.onChange(next);
                    }}
                  />
                  <p>{file.name}</p><span>{file.extension} · {formatBytes(file.sizeBytes)} · {file.durationMs ? formatTime(file.durationMs) : "时长将在归档后检测"}</span>
                </div>
                <button className="icon-button" aria-label={`移除 ${file.name}`} onClick={() => props.onChange(props.candidates.filter((_, itemIndex) => itemIndex !== index))}><Trash size={16} /></button>
              </div>
            ))}
          </div>

          <div className="import-subsection-heading"><strong>本次任务设置</strong></div>
          <div className="import-settings">
            <label>语言<select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="">沿用{inheritedLanguageSource}（{inheritedLanguageLabel}）</option><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">English</option></select></label>
            <label>转录模型<select value={sttProfileId} onChange={(event) => setSttProfileId(event.target.value)}><option value="">稍后配置</option>{sttProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label>总结模型<select value={llmProfileId} onChange={(event) => setLlmProfileId(event.target.value)}><option value="">稍后配置</option>{llmProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label className="import-check"><input type="checkbox" checked={diarizationEnabled} onChange={(event) => setDiarizationEnabled(event.target.checked)} />识别不同发言人</label>
            <label className="import-check"><input type="checkbox" checked={autoSummarize} onChange={(event) => setAutoSummarize(event.target.checked)} />转录后自动生成纪要</label>
          </div>
          {/* 任务级配置摘要：让用户在执行前就看清「用哪个档案、什么语言、什么参数」，
              同时说明这里的改动只作用于本次导入，不会回写档案默认值。 */}
          <p className="import-profile-summary">
            <span>本次使用</span>{describeTaskProfile(selectedStt, language, globalLanguage)}。只影响这一次导入，不改动档案默认值。
          </p>
          <p className="import-expectation">
            {(() => {
              const totalMs = props.candidates.reduce((sum, file) => sum + (file.durationMs || 0), 0);
              if (!props.candidates.length) return "";
              return totalMs > 0
                ? `合计约 ${formatDuration(totalMs / 1000)} · 后台串行处理，期间可继续使用其他会议。`
                : `${props.candidates.length} 个文件 · 后台按顺序处理。`;
            })()}
          </p>
          {!sttProfiles.length && <button className="import-model-hint" onClick={props.onConfigure}><GearSix size={16} /><span><strong>尚未配置转录模型</strong>音频仍会先安全归档，配置后自动继续。</span></button>}
          {/* 空标题不需要拦住提交：主进程会用文件名兜底命名（import-queue.mjs），
              不让「忘了改标题」挡住一键导入。 */}
          <button className="button button--primary import-submit" disabled={busy} onClick={async () => {
            setBusy(true); try { await props.onEnqueue(props.candidates, { language, sttProfileId: sttProfileId || undefined, llmProfileId: llmProfileId || undefined, diarizationEnabled, autoSummarize }); } finally { setBusy(false); }
          }}>{busy ? "正在加入…" : `导入并后台处理 ${props.candidates.length} 个文件`}</button>
          <p className="import-duplicate-note">重复文件也会创建新的会议副本，原文件不会被移动或修改。</p>
        </section>
      )}

      <section className="import-queue">
        <div className="import-section-title"><span>任务队列</span></div>
        {!props.jobs.length && <div className="import-empty"><FileAudio size={24} /><p>尚无导入任务</p><button onClick={props.onPick}>选择录音</button></div>}
        {props.jobs.map((job) => (
          <article className={`import-job import-job--${job.status} ${enteringJobs.has(job.id) ? "content-motion-enter" : ""}`} key={job.id} onClick={() => job.meetingId && props.onOpenMeeting(job.meetingId)}>
            <div className="import-job__top"><span className="import-job__state content-status-enter" key={job.status}>{job.status === "complete" ? <Check size={14} weight="bold" /> : job.status === "cancelled" ? <Pause size={14} /> : <FileAudio size={14} />}{statusText[job.status]}</span><time>{new Date(job.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <h3>{job.title}</h3><p>{job.sourceName}</p>
            <ImportProcessingMeta job={job} compact showDetail={!job.error} queuePosition={queuedOrder.get(job.id)} />
            {job.error && <p className="import-job__error content-motion-enter">{job.error}</p>}
            <div className="import-job__actions" onClick={(event) => event.stopPropagation()}>
              {/* 行内操作按钮阻止冒泡，避免触发整行「打开会议」。 */}
              {["failed", "cancelled", "waiting_for_network"].includes(job.status) && <button onClick={() => props.onRetry(job.id)}><ArrowClockwise size={14} />{job.status === "waiting_for_network" ? "立即重试" : "重试当前阶段"}</button>}
              {["waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool"].includes(job.status) && <button onClick={props.onConfigure}><GearSix size={14} />配置</button>}
              {job.status === "diarizing" && <button onClick={() => props.onSkipDiarization(job.id)}>跳过识别</button>}
              {!['complete', 'cancelled', 'failed'].includes(job.status) && <button onClick={() => props.onCancel(job.id)}>暂停</button>}
              {["complete", "cancelled", "failed", "waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool", "waiting_for_network"].includes(job.status) && <button className="import-job__remove" onClick={() => props.onRemove(job.id)}><Trash size={14} />删除</button>}
            </div>
          </article>
        ))}
      </section>
    </aside>
  );
}

/** 文件体积可读化（KB/MB）。 */
function formatBytes(value: number) { return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
/** 毫秒 → m:ss。 */
function formatTime(value: number) { const seconds = Math.round(value / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
