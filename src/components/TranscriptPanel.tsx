/**
 * 右侧面板（工作区右栏）：「转录」与「AI 总结」两个标签页。
 * 转录页：发言人色点与改名/合并管理、可编辑的转写段落（textarea 直接改写文本并标记纪要过期）、
 * 时间戳点击跳转播放器、播放进度驱动的歌词式高亮（is-playing）、
 * 长会议按 200 条增量加载 + 跟随尾部自动滚动。
 * AI 总结页：主题/决策/未决问题/下一步的只读列表（编辑在中央文档区）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowsMerge,
  CheckCircle,
  FingerprintSimple,
  Lock,
  LockOpen,
  MagicWand,
  PencilSimple,
  Trash,
  X
} from "@phosphor-icons/react";
import type { ImportJob, Meeting, VoiceprintPerson } from "../types";
import { api } from "../lib/api";
import { mergeSpeakerLabels } from "../lib/transcript";
import { toggleSummaryLock } from "../lib/summary";
import type { WorkspaceStage } from "../lib/workspace";

interface TranscriptPanelProps {
  meeting: Meeting;
  importJob?: ImportJob;
  stage: WorkspaceStage;
  tab: "transcript" | "summary";
  onTabChange(tab: "transcript" | "summary"): void;
  onChange(meeting: Meeting): void;
  onClose(): void;
  /** 当前播放位置（毫秒），用于高亮同步段落。 */
  playbackMs?: number;
  /** 点击时间戳时请求播放器跳转。 */
  onSeek?(ms: number): void;
}

export function TranscriptPanel({ meeting, importJob, stage, tab, onTabChange, onChange, onClose, playbackMs = 0, onSeek }: TranscriptPanelProps) {
  /** 正在重命名的说话人 id（显示浮层输入框）。 */
  const [speakerEditor, setSpeakerEditor] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  /** 当前渲染的转写条数（从最新往前窗口化，长会议渐进加载）。 */
  const [visibleCount, setVisibleCount] = useState(200);
  const [autoScroll, setAutoScroll] = useState(true);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [voiceprints, setVoiceprints] = useState<VoiceprintPerson[]>([]);
  const [learningSpeakerId, setLearningSpeakerId] = useState<string | null>(null);
  const [voiceprintMessage, setVoiceprintMessage] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // 从转写中提取去重后的说话人 (id → name) 列表。
  const speakers = useMemo(() => Array.from(new Map(
    meeting.transcript.map((segment) => [segment.speakerId, segment.speakerName])
  )), [meeting.transcript]);
  const visibleSegments = meeting.transcript.slice(-visibleCount);

  const refreshVoiceprints = useCallback(() => {
    api.voiceprints.list().then(setVoiceprints).catch(() => setVoiceprints([]));
  }, []);

  // 切换会议时重置窗口化计数。
  useEffect(() => {
    setVisibleCount(200);
    setEditingSegmentId(null);
    setVoiceprintMessage("");
    refreshVoiceprints();
  }, [meeting.id, refreshVoiceprints]);

  // Auto-scroll to keep the newest transcript in view during a live meeting.
  // Only sticks when the user is already near the bottom so reading older
  // segments is not interrupted — a standard "follow tail" behavior.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !autoScroll || meeting.transcript.length === 0) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom > 80) return;
    list.scrollTop = list.scrollHeight;
  }, [meeting.transcript.length, autoScroll, visibleCount]);

  /** 用户向上阅读时暂停跟随；回到底部或点击恢复后重新跟随最新内容。 */
  const handleTranscriptScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAutoScroll(distanceFromBottom < 64);
  };

  /** 重命名说话人：批量替换其全部段落的显示名，并把纪要标记为过期（stale）。 */
  const renameSpeaker = (speakerId: string, name: string) => {
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((segment) =>
        segment.speakerId === speakerId ? { ...segment, speakerName: name } : segment),
      summary: { ...meeting.summary, stale: true }
    });
    setSpeakerEditor(null);
    setLearningSpeakerId(speakerId);
    setVoiceprintMessage(`正在从本地音频记住“${name}”…`);
    void api.voiceprints.enroll({ meetingId: meeting.id, speakerId, name }).then((result) => {
      setVoiceprintMessage(`已在本机记住“${result.name}”（${result.sampleCount} 份样本），下次分离时会尝试自动命名。`);
      refreshVoiceprints();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setVoiceprintMessage(`姓名已修改，但暂未记住声纹：${message.replace(/^Error invoking remote method '[^']+':\s*/, "")}`);
    }).finally(() => setLearningSpeakerId(null));
  };

  /** 删除本地声纹不会改动历史逐字稿，只影响后续自动识别。 */
  const forgetVoiceprint = async (name: string) => {
    if (!window.confirm(`要让 MinuteFlow 忘记“${name}”的本地声纹吗？历史会议中的姓名不会改变。`)) return;
    try {
      await api.voiceprints.forget(name);
      setVoiceprintMessage(`已忘记“${name}”的声纹，历史会议内容保持不变。`);
      refreshVoiceprints();
    } catch (error) {
      setVoiceprintMessage(`暂时无法删除声纹：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 合并两个说话人标签（同一人被识别成两个 id 的场景），实际重映射在 lib/transcript.ts。 */
  const mergeSpeakers = () => {
    if (!mergeSource || !mergeTarget || mergeSource === mergeTarget) return;
    const targetName = speakers.find(([id]) => id === mergeTarget)?.[1] ?? "发言人";
    onChange({
      ...meeting,
      transcript: mergeSpeakerLabels(meeting.transcript, mergeSource, mergeTarget, targetName),
      summary: { ...meeting.summary, stale: true }
    });
    setMergeSource("");
    setMergeTarget("");
  };

  const updateSegmentText = (segmentId: string, text: string) => onChange({
    ...meeting,
    transcript: meeting.transcript.map((item) =>
      item.id === segmentId ? { ...item, text } : item),
    summary: { ...meeting.summary, stale: true }
  });

  return (
    <aside className="transcript-panel" aria-label={stage === "live" ? "实时会议侧栏" : "会议整理侧栏"}>
      <header className="transcript-panel__header">
        <div className="panel-tabs" role="tablist" aria-label="会议侧栏内容">
          <button
            id="transcript-tab"
            role="tab"
            aria-selected={tab === "transcript"}
            aria-controls="transcript-content"
            className={tab === "transcript" ? "is-active" : ""}
            onClick={() => onTabChange("transcript")}
          >
            {stage === "live" ? "实时转写" : "逐字稿"}
          </button>
          <button
            id="summary-tab"
            role="tab"
            aria-selected={tab === "summary"}
            aria-controls="summary-content"
            className={tab === "summary" ? "is-active" : ""}
            onClick={() => onTabChange("summary")}
          >
            {stage === "live" ? "阶段要点" : "AI 总结"} <small>Beta</small>
          </button>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭侧栏"><X size={18} /></button>
      </header>

      {tab === "transcript" ? (
        <>
          <div className="speaker-strip">
            {speakers.slice(0, 3).map(([id, name]) => (
              <button key={id} onClick={() => setSpeakerEditor(id)}>
                <span className={`speaker-dot speaker-dot--${speakerColor(id)}`} />{name}
                {voiceprints.some((person) => person.name === name) && (
                  <FingerprintSimple size={12} weight="fill" aria-label="已保存在本地声纹簿" />
                )}
              </button>
            ))}
            {speakers.length > 3 && (
              // 超出前 3 个的说话人以 +N 收纳：点开管理面板即可查看/改名全部。
              <button className="speaker-more" onClick={() => setManagerOpen(true)}>
                +{speakers.length - 3}
              </button>
            )}
            <button className="speaker-merge" onClick={() => setManagerOpen((value) => !value)}>
              <ArrowsMerge size={14} />管理
            </button>
          </div>
          {managerOpen && (
            <section className="speaker-manager">
              <header>
                <div>
                  <strong>发言人管理</strong>
                  <small>改名会从本地音频学习声纹；低置信度时仍保留匿名标签</small>
                </div>
                <button className="icon-button" onClick={() => setManagerOpen(false)} aria-label="关闭发言人管理">
                  <X size={15} />
                </button>
              </header>
              <div className="speaker-manager__names">
                {speakers.map(([id, name]) => (
                  <label key={id}>
                    <span className={`speaker-dot speaker-dot--${speakerColor(id)}`} />
                    <input
                      aria-label={`重命名 ${name}`}
                      defaultValue={name}
                      disabled={learningSpeakerId === id}
                      // 与气泡改名保持一致：Enter 立即应用（另保留失焦提交通道）。
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        const next = event.currentTarget.value.trim();
                        if (next && next !== name) {
                          event.currentTarget.dataset.committed = "true";
                          renameSpeaker(id, next);
                        }
                        event.currentTarget.blur();
                      }}
                      onBlur={(event) => {
                        if (event.currentTarget.dataset.committed === "true") {
                          delete event.currentTarget.dataset.committed;
                          return;
                        }
                        const next = event.currentTarget.value.trim();
                        if (next && next !== name) renameSpeaker(id, next);
                      }}
                    />
                  </label>
                ))}
              </div>
              {speakers.length > 1 && (
                <div className="speaker-manager__merge">
                  <select value={mergeSource} onChange={(event) => setMergeSource(event.target.value)}>
                    <option value="">选择待合并标签</option>
                    {speakers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                  <span>合并到</span>
                  <select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}>
                    <option value="">选择目标发言人</option>
                    {speakers.filter(([id]) => id !== mergeSource).map(([id, name]) => (
                      <option key={id} value={id}>{name}</option>
                    ))}
                  </select>
                  <button
                    className="button button--secondary button--small"
                    disabled={!mergeSource || !mergeTarget}
                    onClick={mergeSpeakers}
                  >
                    合并
                  </button>
                </div>
              )}
              <div className="voiceprint-book">
                <div className="voiceprint-book__title">
                  <FingerprintSimple size={15} weight="duotone" />
                  <span>本地声纹簿</span>
                  <small>{voiceprints.length ? `${voiceprints.length} 人` : "尚未学习"}</small>
                </div>
                {voiceprints.length > 0 && (
                  <div className="voiceprint-book__people">
                    {voiceprints.map((person) => (
                      <span key={person.name}>
                        {person.name}<small>{person.sampleCount} 份</small>
                        <button
                          type="button"
                          aria-label={`忘记 ${person.name} 的声纹`}
                          title="只删除本地声纹，不修改历史会议"
                          onClick={() => void forgetVoiceprint(person.name)}
                        >
                          <Trash size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
          {voiceprintMessage && <p className="voiceprint-message" aria-live="polite">{voiceprintMessage}</p>}
          {meeting.transcript.length > 0 && (
            <p className="transcript-hint">{importTranscriptStatus(importJob, meeting.transcript.length)}</p>
          )}
          <div
            className="transcript-list"
            id="transcript-content"
            role="tabpanel"
            aria-labelledby="transcript-tab"
            ref={listRef}
            onScroll={handleTranscriptScroll}
          >
            {meeting.transcript.length > visibleCount && (
              <button className="load-earlier" onClick={() => setVisibleCount((value) => value + 200)}>
                加载更早的 {Math.min(200, meeting.transcript.length - visibleCount)} 条
              </button>
            )}
            {meeting.transcript.length ? visibleSegments.map((segment) => (
              // is-playing：当前播放位置落在该段落时间区间内时整行高亮（歌词式同步）。
              <article className={`transcript-item transcript-item--${segment.status} ${playbackMs >= segment.startMs && playbackMs < segment.endMs ? "is-playing" : ""}`} key={segment.id}>
                <button className="transcript-time" onClick={() => onSeek?.(segment.startMs)}>{formatTranscriptTime(segment.startMs)}</button>
                <div>
                  <button className={`speaker-name speaker-name--${speakerColor(segment.speakerId)}`} onClick={() => setSpeakerEditor(segment.speakerId)}>
                    {segment.speakerName}
                    {voiceprints.some((person) => person.name === segment.speakerName) && (
                      <FingerprintSimple size={11} weight="fill" aria-label="已保存在本地声纹簿" />
                    )}
                  </button>
                  {editingSegmentId === segment.id ? (
                    <textarea
                      autoFocus
                      className="transcript-editor"
                      value={segment.text}
                      rows={Math.max(2, Math.ceil(segment.text.length / 24))}
                      onChange={(event) => updateSegmentText(segment.id, event.target.value)}
                      onBlur={() => setEditingSegmentId(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingSegmentId(null);
                        }
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          setEditingSegmentId(null);
                        }
                      }}
                    />
                  ) : (
                    <p className="transcript-copy">{segment.text}</p>
                  )}
                  {segment.status === "provisional" && <span className="provisional">临时转写中…</span>}
                </div>
                <div className="transcript-item__actions">
                  {segment.status !== "provisional" && (
                    <button
                      className="transcript-edit"
                      aria-label={`编辑 ${formatTranscriptTime(segment.startMs)} 的转写`}
                      onClick={() => setEditingSegmentId(segment.id)}
                    >
                      <PencilSimple size={14} />
                    </button>
                  )}
                  <CheckCircle size={16} className="transcript-check" weight="duotone" />
                </div>
              </article>
            )) : (
              <div className="panel-empty">
                <MagicWand size={24} weight="duotone" />
                <p>{importJob
                  ? importTranscriptStatus(importJob, 0)
                  : stage === "review"
                    ? "这场会议暂无可用逐字稿。笔记和已生成的纪要仍会保留；需要补充内容时，可从更多选项继续录音。"
                    : "开始录音后，转录会出现在这里。"}</p>
              </div>
            )}
          </div>
          {meeting.transcript.length > 0 && <button
            className={`follow-control ${autoScroll ? "is-active" : ""}`}
            aria-pressed={autoScroll}
            onClick={() => {
              const list = listRef.current;
              if (list) list.scrollTop = list.scrollHeight;
              setAutoScroll(true);
            }}
          >
            {autoScroll ? <CheckCircle size={14} weight="fill" /> : <ArrowDown size={14} weight="bold" />}
            {autoScroll ? "正在跟随" : "恢复跟随"}
          </button>}
        </>
      ) : (
        <div className="ai-panel" id="summary-content" role="tabpanel" aria-labelledby="summary-tab">
          <section>
            <h3>
              当前议题
              <button
                className={`icon-button summary-lock ${meeting.summary.manualLocks?.includes("topics") ? "is-locked" : ""}`}
                aria-label={meeting.summary.manualLocks?.includes("topics") ? "解除主题锁定" : "锁定主题，AI 不整体改写"}
                title={meeting.summary.manualLocks?.includes("topics") ? "已锁定：AI 重新生成时保留当前主题。点击解锁。" : "未锁定。点击锁定后 AI 不改写主题列表。"}
                onClick={() => onChange({
                  ...meeting,
                  summary: toggleSummaryLock(meeting.summary, "topics")
                })}
              >
                {meeting.summary.manualLocks?.includes("topics")
                  ? <Lock size={13} weight="fill" />
                  : <LockOpen size={13} />}
              </button>
            </h3>
            <ul>{meeting.summary.topics.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section>
            <h3>已确认决策</h3>
            <ul>{meeting.summary.decisions.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section>
            <h3>未决问题</h3>
            <ul>{meeting.summary.openQuestions.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section>
            <h3>下一步</h3>
            <ul>{meeting.summary.nextSteps.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        </div>
      )}

      {speakerEditor && (
        <div className="speaker-popover">
          <PencilSimple size={16} />
          <input
            autoFocus
            defaultValue={speakers.find(([id]) => id === speakerEditor)?.[1] ?? ""}
            onKeyDown={(event) => {
              if (event.key === "Enter") renameSpeaker(speakerEditor, event.currentTarget.value.trim() || "未命名发言人");
              if (event.key === "Escape") setSpeakerEditor(null);
            }}
          />
          <small>回车应用到该发言人的全部片段</small>
        </div>
      )}
    </aside>
  );
}

/** 导入任务阶段 → 右栏即时状态；已有文本时仍保留状态行，不替换转录内容。 */
function importTranscriptStatus(job: ImportJob | undefined, segmentCount: number) {
  if (!job) return segmentCount ? "转录内容已按时间轴排列" : "AI 实时转写中，临时内容仅供参考";
  if (job.status === "queued" && job.stage === "copying") return "等待归档录音…";
  if (job.status === "copying" || job.stage === "copying") return "正在归档录音…";
  if (job.status === "preparing" || job.stage === "preparing") return "正在准备音频…";
  if (job.status === "waiting_for_model") return "等待配置转录模型，录音已安全归档。";
  if (job.status === "waiting_for_audio_tool") return "音频组件需要恢复后才能继续转录。";
  if (job.status === "failed") return `转录暂停：${job.error || "处理失败"}`;
  if (job.status === "cancelled") return "导入处理已取消，已有转录仍会保留。";
  if (job.status === "transcribing" || job.stage === "transcribing") {
    return job.totalChunks
      ? `正在转录第 ${Math.min((job.completedChunks || 0) + 1, job.totalChunks)}/${job.totalChunks} 段，约每 10 秒音频持续追加。`
      : "正在分析音频，首段文本很快会出现在这里。";
  }
  if (job.status === "diarizing") return "转录完成，正在识别不同发言人…";
  if (job.status === "summarizing") return "转录完成，正在整理会议纪要…";
  return segmentCount ? "转录已完成，点击时间戳可定位播放。" : "录音中没有识别到可显示的语音。";
}

/** 转写时间戳 → HH:MM:SS / MM:SS（相对录音起点，与播放器时间轴对齐）。 */
function formatTranscriptTime(ms: number) {
  // Relative to recording start (00:00:00), with seconds. startMs is measured
  // from when recording began, so this aligns with the audio timeline.
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 说话人配色：自己固定蓝色，其余按 id 哈希稳定分配橙/紫/绿（颜色即身份语义）。 */
function speakerColor(id: string) {
  if (id === "me") return "blue";
  const colors = ["orange", "purple", "green"];
  return colors[Math.abs(hash(id)) % colors.length];
}

/** 简单字符串哈希（用于稳定选色）。 */
function hash(value: string) {
  return Array.from(value).reduce((total, character) => total + character.charCodeAt(0), 0);
}
