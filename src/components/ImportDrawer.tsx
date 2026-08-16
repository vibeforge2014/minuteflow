/**
 * 导入任务抽屉（工作区右滑层）：音频导入的确认与队列界面。
 * 上半部分是「待确认文件」——可改标题、选语言/转录/总结模型、开关说话人分离，
 * 确认后文件立即归档并入队；下半部分是后台任务队列（单 worker 串行），
 * 支持重试、取消、等待配置（缺模型时任务可恢复暂停而非失败）。
 */
import { ArrowClockwise, Check, FileAudio, GearSix, Pause, Trash, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { ImportCandidate, ImportJob, ModelProfile } from "../types";

interface Props {
  open: boolean;
  /** 已选择/拖入、尚未确认入队的文件。 */
  candidates: ImportCandidate[];
  /** 后台任务队列（含历史任务）。 */
  jobs: ImportJob[];
  profiles: ModelProfile[];
  onClose(): void;
  onPick(): void;
  onChange(items: ImportCandidate[]): void;
  onEnqueue(items: ImportCandidate[], options: { language: string; sttProfileId?: string; llmProfileId?: string; diarizationEnabled: boolean; autoSummarize: boolean }): Promise<void>;
  onRetry(id: string): void;
  onCancel(id: string): void;
  onOpenMeeting(id: string): void;
  onConfigure(): void;
}

/** 任务状态 → 用户可读文案；三种 waiting_* 是可恢复的缺组件等待态。 */
const statusText: Record<ImportJob["status"], string> = {
  queued: "等待处理", copying: "正在复制", preparing: "准备音频", transcribing: "转录中",
  diarizing: "识别发言人", summarizing: "生成纪要", waiting_for_model: "等待配置转录",
  waiting_for_summary_model: "等待配置总结", waiting_for_audio_tool: "等待音频组件",
  complete: "已完成", cancelled: "已取消，可继续", failed: "处理失败"
};

export function ImportDrawer(props: Props) {
  // 只列出已启用的 stt/llm 档案供选择；未配置时引导去设置页而不是阻塞导入。
  const sttProfiles = useMemo(() => props.profiles.filter((profile) => profile.kind === "stt" && profile.enabled), [props.profiles]);
  const llmProfiles = useMemo(() => props.profiles.filter((profile) => profile.kind === "llm" && profile.enabled), [props.profiles]);
  const [language, setLanguage] = useState("auto");
  const [sttProfileId, setSttProfileId] = useState(sttProfiles[0]?.id || "");
  const [llmProfileId, setLlmProfileId] = useState(llmProfiles[0]?.id || "");
  const [diarizationEnabled, setDiarizationEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  // 档案列表后加载（如刚打开设置保存了新档案）时，把空选择补默认值。
  useEffect(() => { if (!sttProfileId && sttProfiles[0]?.id) setSttProfileId(sttProfiles[0].id); }, [sttProfileId, sttProfiles]);
  useEffect(() => { if (!llmProfileId && llmProfiles[0]?.id) setLlmProfileId(llmProfiles[0].id); }, [llmProfileId, llmProfiles]);

  if (!props.open) return null;
  // 仍在处理中的任务数（用于副标题提示）。
  const activeCount = props.jobs.filter((job) => !["complete", "cancelled", "failed"].includes(job.status)).length;

  return (
    <aside className="import-drawer" aria-label="导入任务">
      <header className="import-drawer__header">
        <div><h2>导入任务</h2><p>{activeCount ? `${activeCount} 项正在后台处理` : "检查文件并在后台处理"}</p></div>
        <button className="icon-button" aria-label="收起导入任务" onClick={props.onClose}><X size={19} /></button>
      </header>

      {props.candidates.length > 0 && (
        <section className="import-confirm">
          <div className="import-section-title"><span>待确认文件 · {props.candidates.length}</span><button onClick={props.onPick}>继续添加</button></div>
          <div className="import-files">
            {props.candidates.map((file, index) => (
              <div className="import-file" key={`${file.sourcePath}-${index}`}>
                <div className="import-file__icon"><FileAudio size={20} /></div>
                <div className="import-file__body">
                  <input aria-label={`${file.name} 的会议标题`} value={file.title} onChange={(event) => {
                    const next = [...props.candidates]; next[index] = { ...file, title: event.target.value }; props.onChange(next);
                  }} />
                  <p>{file.name}</p><span>{file.extension} · {formatBytes(file.sizeBytes)} · {file.durationMs ? formatTime(file.durationMs) : "时长将在归档后检测"}</span>
                </div>
                <button className="icon-button" aria-label={`移除 ${file.name}`} onClick={() => props.onChange(props.candidates.filter((_, itemIndex) => itemIndex !== index))}><Trash size={16} /></button>
              </div>
            ))}
          </div>

          <div className="import-settings">
            <label>语言<select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">自动识别（中文/中英混合优先）</option><option value="zh">中文</option><option value="en">English</option></select></label>
            <label>转录模型<select value={sttProfileId} onChange={(event) => setSttProfileId(event.target.value)}><option value="">稍后配置</option>{sttProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label>总结模型<select value={llmProfileId} onChange={(event) => setLlmProfileId(event.target.value)}><option value="">稍后配置</option>{llmProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label className="import-check"><input type="checkbox" checked={diarizationEnabled} onChange={(event) => setDiarizationEnabled(event.target.checked)} />识别不同发言人</label>
          </div>
          {!sttProfiles.length && <button className="import-model-hint" onClick={props.onConfigure}><GearSix size={16} /><span><strong>尚未配置转录模型</strong>音频仍会先安全归档，配置后自动继续。</span></button>}
          <button className="button button--primary import-submit" disabled={busy || props.candidates.some((item) => !item.title.trim())} onClick={async () => {
            setBusy(true); try { await props.onEnqueue(props.candidates, { language, sttProfileId: sttProfileId || undefined, llmProfileId: llmProfileId || undefined, diarizationEnabled, autoSummarize: true }); } finally { setBusy(false); }
          }}>{busy ? "正在加入…" : `导入并后台处理 ${props.candidates.length} 个文件`}</button>
          <p className="import-duplicate-note">重复文件也会创建新的会议副本，原文件不会被移动或修改。</p>
        </section>
      )}

      <section className="import-queue">
        <div className="import-section-title"><span>任务队列</span><small>同一时间处理 1 项</small></div>
        {!props.jobs.length && <div className="import-empty"><FileAudio size={24} /><p>尚无导入任务</p><button onClick={props.onPick}>选择录音</button></div>}
        {props.jobs.map((job) => (
          <article className={`import-job import-job--${job.status}`} key={job.id} onClick={() => job.meetingId && props.onOpenMeeting(job.meetingId)}>
            <div className="import-job__top"><span className="import-job__state">{job.status === "complete" ? <Check size={14} weight="bold" /> : job.status === "cancelled" ? <Pause size={14} /> : <FileAudio size={14} />}{statusText[job.status]}</span><time>{new Date(job.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <h3>{job.title}</h3><p>{job.sourceName}</p>
            <div className="import-progress"><i style={{ width: `${Math.max(3, job.progress * 100)}%` }} /></div>
            {job.error && <p className="import-job__error">{job.error}</p>}
            <div className="import-job__actions" onClick={(event) => event.stopPropagation()}>
              {/* 行内操作按钮阻止冒泡，避免触发整行「打开会议」。 */}
              {["failed", "cancelled"].includes(job.status) && <button onClick={() => props.onRetry(job.id)}><ArrowClockwise size={14} />重试当前阶段</button>}
              {["waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool"].includes(job.status) && <button onClick={props.onConfigure}><GearSix size={14} />配置</button>}
              {!['complete', 'cancelled', 'failed'].includes(job.status) && <button onClick={() => props.onCancel(job.id)}>取消</button>}
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
