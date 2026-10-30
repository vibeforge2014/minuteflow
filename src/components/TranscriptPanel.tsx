/**
 * 转写视图（中央工作区「转写」标签页的内容，也可嵌入其他容器）：
 * 发言人色点与改名/合并管理、可编辑的转写段落（textarea 直接改写文本并标记纪要过期）、
 * 时间戳点击跳转播放器、播放进度驱动的歌词式高亮（is-playing）、
 * 长会议按 200 条增量加载 + 跟随尾部自动滚动。
 * 视图自身不带外壳与滚动容器：外层（如中央文档列）负责提供 .workspace-transcript。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowClockwise,
  ArrowsMerge,
  CaretDown,
  CheckCircle,
  Check,
  Copy,
  FingerprintSimple,
  MagicWand,
  PencilSimple,
  Trash,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import type { ImportJob, Meeting, VoiceprintPerson } from "../types";
import { api } from "../lib/api";
import { ConfirmDialog, useConfirmDialog } from "./ConfirmDialog";
import { findPlayingSegment } from "../lib/workspace";
import { mergeSpeakerLabels } from "../lib/transcript";
import { classifyTextChange } from "../lib/content-motion";
import type { LiveTranscriptionFailure } from "../services/recording";
import { useEnteringItemIds } from "../hooks/useContentMotion";
import { useExitPresence } from "../hooks/useExitPresence";
import { ImportProcessingMeta } from "./ImportProcessingMeta";
import {
  describeImportProcessing,
  isActiveImportJob,
  isRetryableImportJob
} from "../lib/import-status";
import { useStreamingTranscript } from "../hooks/useStreamingTranscript";
import type { WorkspaceStage } from "../lib/workspace";

interface TranscriptViewProps {
  meeting: Meeting;
  importJob?: ImportJob;
  stage: WorkspaceStage;
  onChange(meeting: Meeting): void;
  /** 当前播放位置（毫秒），用于高亮同步段落。 */
  playbackMs?: number;
  /** 点击时间戳时请求播放器跳转。 */
  onSeek?(ms: number): void;
  /** 空逐字稿在会后提供唯一、明确的恢复动作。 */
  emptyActionLabel?: string;
  onEmptyAction?(): void;
  /** 关键结论回链：跳到该时刻所在段落并短暂高亮（nonce 变化触发一次性定位）。 */
  jumpTarget?: { ms: number; nonce: number } | null;
  summaryBusy?: boolean;
  onGenerateSummary?(): void;
  /** 实时转写连续失败后的持久提示；录音结束后也保留，直到用户处理或忽略。 */
  transcriptionFailure?: LiveTranscriptionFailure | null;
  transcriptionIsLocal?: boolean;
  onUseLocalWhisper?(): void;
  onChooseTranscriptionService?(): void;
  onDismissTranscriptionFailure?(): void;
  /** 导入任务可恢复操作：失败/取消后重试，处理中暂停。 */
  onRetryImport?(id: string): void;
  onCancelImport?(id: string): void;
  /** 跳过说话人识别，保留转写继续生成纪要。 */
  onSkipDiarization?(id: string): void;
  /** 重新转录：用已归档录音重跑转写/识别/纪要（在线转写失败后的会后补救路径）。 */
  onRetranscribe?(): void;
  onConfigureTranscription?(): void;
}

export function TranscriptView({ meeting, importJob, stage, onChange, playbackMs = 0, onSeek, emptyActionLabel, onEmptyAction, jumpTarget, summaryBusy, onGenerateSummary, transcriptionFailure, transcriptionIsLocal = false, onUseLocalWhisper, onChooseTranscriptionService, onDismissTranscriptionFailure, onRetryImport, onCancelImport, onSkipDiarization, onRetranscribe, onConfigureTranscription }: TranscriptViewProps) {
  /** 正在重命名的说话人 id（显示浮层输入框）。 */
  const [speakerEditor, setSpeakerEditor] = useState<string | null>(null);
  /** 改名时是否把这个人注册进本机声纹簿（默认勾选，可显式关闭）。 */
  const [rememberVoice, setRememberVoice] = useState(true);
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
  const voiceprintConfirm = useConfirmDialog();
  /** 关键结论回链定位到的段落 id（短暂高亮后清除）。 */
  const [jumpHighlightId, setJumpHighlightId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 从转写中提取去重后的说话人 (id → name) 列表。
  const speakers = useMemo(() => Array.from(new Map(
    meeting.transcript.map((segment) => [segment.speakerId, segment.speakerName])
  )), [meeting.transcript]);
  // 转录流式揭示：导入进行中（任务未终结）或会议进行中时，新到达文本按打字机
  // 节奏逐拍铺开，与 AI 问答同一观感；历史内容与 Reduced Motion 直接透传。
  const importActive = Boolean(importJob) && !["complete", "failed", "cancelled"].includes(importJob?.status ?? "");
  const displayTranscript = useStreamingTranscript(meeting, importActive || stage === "live");
  const visibleSegments = displayTranscript.slice(-visibleCount);
  const visibleSegmentIds = useMemo(() => visibleSegments.map((segment) => segment.id), [visibleSegments]);
  const enteringSegmentIds = useEnteringItemIds(meeting.id, visibleSegmentIds);
  // 同一批新入场的段落按 0/40/80ms 级联出现，避免整块转录结果齐刷刷闪现。
  const enteringSequence = useMemo(
    () => visibleSegments.filter((segment) => enteringSegmentIds.has(segment.id)).map((segment) => segment.id),
    [visibleSegments, enteringSegmentIds]
  );
  const tailSegment = displayTranscript.at(-1);
  const tailSignature = tailSegment ? `${tailSegment.id}:${tailSegment.text.length}:${tailSegment.status}` : "";

  const refreshVoiceprints = useCallback(() => {
    api.voiceprints.list().then(setVoiceprints).catch(() => setVoiceprints([]));
  }, []);

  // 切换会议时重置窗口化计数。
  useEffect(() => {
    setVisibleCount(200);
    setAutoScroll(true);
    setManagerOpen(false);
    setSpeakerEditor(null);
    setEditingSegmentId(null);
    setVoiceprintMessage("");
    refreshVoiceprints();
  }, [meeting.id, refreshVoiceprints]);

  /** 回放位置对应的段落（间隙保留上一段高亮，见 findPlayingSegment）。 */
  const playingSegment = useMemo(
    () => findPlayingSegment(meeting.transcript, playbackMs),
    [meeting.transcript, playbackMs]
  );

  /** 跟随滚动自身触发的 scroll 事件在该时间戳之前不参与“是否脱离跟随”判定。 */
  const followGuardUntil = useRef(0);

  // Auto-scroll to keep the newest transcript in view during a live meeting.
  // Only sticks when the user is already near the bottom so reading older
  // segments is not interrupted — a standard "follow tail" behavior.
  // 回放进行中改由下方的“跟随回放”效果接管，两条跟随互斥。
  useEffect(() => {
    const list = listRef.current;
    if (!list || !autoScroll || playingSegment || meeting.transcript.length === 0 || (stage !== "live" && !importActive)) return;
    // 刚发生回链/回放定位的程序性滚动短时间内不参与“跟随尾部”，避免两股滚动互相拉扯。
    if (performance.now() < followGuardUntil.current) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [tailSignature, autoScroll, visibleCount, playingSegment, stage, importActive]);

  // 回放跟随（歌词式）：播放进入新段落时把该段滚到列表上部约 1/3 处；
  // 段落已在可视上中部时不重复滚动，减少无谓位移。正在播放的段落落在
  // 窗口化渲染之外时先扩窗，扩窗重渲染后本效果再次运行并完成定位。
  useEffect(() => {
    const list = listRef.current;
    if (!playingSegment || !autoScroll || !list) return;
    const el = list.querySelector<HTMLElement>(`[data-segment-id="${playingSegment.id}"]`);
    if (!el) {
      const index = meeting.transcript.findIndex((segment) => segment.id === playingSegment.id);
      if (index >= 0) setVisibleCount((count) => Math.max(count, meeting.transcript.length - index + 20));
      return;
    }
    const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (top >= list.clientHeight * 0.1 && top <= list.clientHeight * 0.5) return;
    followGuardUntil.current = performance.now() + 450;
    list.scrollTo({
      top: Math.max(0, list.scrollTop + top - list.clientHeight / 3),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [playingSegment?.id, autoScroll, visibleCount, meeting.transcript]);

  // 关键结论回链定位：扩窗到目标段、把该段滚到列表约 1/3 处并短暂高亮 2 秒。
  // 一次性动作只由 nonce 驱动；双 rAF 等待扩窗重渲染完成后再定位。
  useEffect(() => {
    if (!jumpTarget) return;
    const target = findPlayingSegment(meeting.transcript, jumpTarget.ms);
    if (!target) return;
    const index = meeting.transcript.findIndex((segment) => segment.id === target.id);
    if (index >= 0 && index < meeting.transcript.length - visibleCount) {
      setVisibleCount((count) => Math.max(count, meeting.transcript.length - index + 20));
    }
    followGuardUntil.current = performance.now() + 450;
    const list = listRef.current;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = list?.querySelector<HTMLElement>(`[data-segment-id="${target.id}"]`);
      if (!el || !list) return;
      const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTo({
        top: Math.max(0, list.scrollTop + top - list.clientHeight / 3),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
      });
    }));
    setJumpHighlightId(target.id);
    const timer = window.setTimeout(() => setJumpHighlightId(null), 2000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [jumpTarget?.nonce]);

  /** 用户向上阅读时暂停跟随；回到底部或点击恢复后重新跟随最新内容。
      回放中改用“正在播放的段落是否仍在可视区”判定，跟随滚动自身触发的事件被忽略。 */
  const handleTranscriptScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (performance.now() < followGuardUntil.current) return;
    if (playingSegment) {
      const el = list.querySelector<HTMLElement>(`[data-segment-id="${playingSegment.id}"]`);
      if (el) {
        const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
        setAutoScroll(top > -el.offsetHeight && top < list.clientHeight);
        return;
      }
    }
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAutoScroll(distanceFromBottom < 64);
  };

  /**
   * 重命名说话人：批量替换其全部段落的显示名，并把纪要标记为过期（stale）。
   * 默认同时从本机音频注册声纹；用户可以在浮层里显式关闭“记住声音”。
   */
  const renameSpeaker = (speakerId: string, name: string, remember = true) => {
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((segment) =>
        segment.speakerId === speakerId ? { ...segment, speakerName: name } : segment),
      summary: { ...meeting.summary, stale: true }
    });
    setSpeakerEditor(null);
    if (!remember) {
      setVoiceprintMessage(`姓名已应用到全部片段；没有记住声纹，下次分离不会自动使用「${name}」。`);
      return;
    }
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

  /** 打开改名浮层时默认勾选“记住声音”，用户每次都可以改。 */
  const openSpeakerEditor = (speakerId: string) => {
    setRememberVoice(true);
    setSpeakerEditor(speakerId);
  };

  /** 删除本地声纹不会改动历史逐字稿，只影响后续自动识别。 */
  const forgetVoiceprint = async (name: string) => {
    if (!(await voiceprintConfirm.confirm({
      title: `忘记“${name}”的声纹？`,
      body: "只删除本机保存的声纹样本，历史会议中的姓名不会改变。",
      confirmLabel: "忘记声纹"
    }))) return;
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
    <>
      <div className="speaker-strip">
        <span className="speaker-strip__label">发言人</span>
        {speakers.slice(0, 3).map(([id, name]) => (
          <button key={id} onClick={() => openSpeakerEditor(id)}>
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
      {transcriptionFailure && (
        <section className="transcription-failure content-status-enter" role="alert">
          <span className="transcription-failure__icon"><WarningCircle size={19} weight="fill" /></span>
          <div className="transcription-failure__body">
            <strong>{transcriptionIsLocal ? "本地转写暂时没有结果" : "在线转写暂时不可用"}</strong>
            <p>
              {transcriptionIsLocal
                ? "本机模型可能尚未下载完成或正在加载。"
                : "网络、密钥或服务额度可能有问题。"}
              连续 {transcriptionFailure.consecutive} 次转写没有结果，录音和音频存档不受影响。
              {!transcriptionIsLocal && stage === "live" ? "改用本地 Whisper 会从下一段起生效。" : ""}
            </p>
            {transcriptionFailure.message && (
              <small title={transcriptionFailure.message}>{transcriptionFailure.message}</small>
            )}
            <div className="transcription-failure__actions">
              <button type="button" className="button button--small button--primary" onClick={onUseLocalWhisper}>
                {transcriptionIsLocal ? "检查本地 Whisper" : "改用本地 Whisper"}
              </button>
              <button type="button" className="button button--small" onClick={onChooseTranscriptionService}>
                {transcriptionIsLocal ? "改用在线服务" : "更换转写服务"}
              </button>
              <button type="button" className="text-button" onClick={onDismissTranscriptionFailure}>暂时忽略</button>
            </div>
          </div>
          <button type="button" className="icon-button transcription-failure__dismiss" aria-label="关闭转写失败提示" onClick={onDismissTranscriptionFailure}>
            <X size={15} />
          </button>
        </section>
      )}
      {importJob && (isActiveImportJob(importJob) || [
        "failed", "cancelled", "waiting_for_network", "waiting_for_model",
        "waiting_for_summary_model", "waiting_for_audio_tool"
      ].includes(importJob.status)) && (
        <section
          className={`transcript-import-status transcript-import-status--${importJob.status} content-status-enter`}
          aria-live="polite"
        >
          <div className="transcript-import-status__head">
            <strong>
              {importJob.status === "cancelled"
                ? "处理已停止，可继续未完成的阶段"
                : describeImportProcessing(importJob)}
            </strong>
            <div className="transcript-import-status__actions">
              {isRetryableImportJob(importJob) && onRetryImport && (
                <button type="button" className="text-button" onClick={() => onRetryImport(importJob.id)}>
                  <ArrowClockwise size={13} />
                  {importJob.status === "waiting_for_network" ? "立即重试" : "重试"}
                </button>
              )}
              {["waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool"].includes(importJob.status)
                && onConfigureTranscription && (
                  <button type="button" className="text-button" onClick={onConfigureTranscription}>配置模型</button>
                )}
              {importJob.status === "diarizing" && onSkipDiarization && (
                <button type="button" className="text-button" onClick={() => onSkipDiarization(importJob.id)}>
                  跳过识别，生成纪要
                </button>
              )}
              {isActiveImportJob(importJob) && onCancelImport && (
                <button
                  type="button"
                  className="text-button"
                  title="暂停后可随时继续，已完成的转写不会丢失"
                  onClick={() => onCancelImport(importJob.id)}
                >
                  <X size={13} />暂停处理
                </button>
              )}
            </div>
          </div>
          <ImportProcessingMeta job={importJob} compact />
        </section>
      )}
      <div
        className="transcript-list"
        id="transcript-content"
        role="tabpanel"
        aria-labelledby="transcript-tab"
        ref={listRef}
        onScroll={handleTranscriptScroll}
      >
        <TranscriptOverview
          key={meeting.id}
          summary={meeting.summary}
          busy={summaryBusy}
          onRefresh={onGenerateSummary}
        />
        {meeting.transcript.length > visibleCount && (
          <button className="load-earlier" onClick={() => setVisibleCount((value) => value + 200)}>
            加载更早的 {Math.min(200, meeting.transcript.length - visibleCount)} 条
          </button>
        )}
        {meeting.transcript.length ? visibleSegments.map((segment, index) => {
          const enteringIndex = enteringSequence.indexOf(segment.id);
          const previous = visibleSegments[index - 1];
          const continuation = previous?.speakerId === segment.speakerId && segment.startMs - previous.endMs < 1500;
          return (
            // is-playing：当前播放位置命中的段落整行高亮；data-segment-id 供回放跟随定位。
            <article
              className={`transcript-item transcript-item--${segment.status} ${continuation ? "is-continuation" : ""} ${playingSegment?.id === segment.id ? "is-playing" : ""} ${jumpHighlightId === segment.id ? "is-jump-highlight" : ""} ${enteringIndex >= 0 ? "content-motion-enter" : ""}`}
              data-segment-id={segment.id}
              key={segment.id}
              style={enteringIndex >= 0 ? { animationDelay: `${Math.min(enteringIndex, 2) * 40}ms` } : undefined}
            >
            <div className="transcript-item__meta">
              <button className={`speaker-name speaker-name--${speakerColor(segment.speakerId)}`} onClick={() => openSpeakerEditor(segment.speakerId)}>
                {segment.speakerName}
                {voiceprints.some((person) => person.name === segment.speakerName) && (
                  <FingerprintSimple size={11} weight="fill" aria-label="已保存在本地声纹簿" />
                )}
              </button>
              <button className="transcript-time" aria-label={`定位到 ${formatTranscriptTime(segment.startMs)}`} onClick={() => onSeek?.(segment.startMs)}>{formatTranscriptTime(segment.startMs)}</button>
            </div>
            <div className="transcript-bubble">
            <div className="transcript-bubble__content">
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
                <AnimatedTranscriptCopy text={segment.text} animate={!enteringSegmentIds.has(segment.id)} />
              )}
              <ProvisionalBadge visible={segment.status === "provisional"} />
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
            </div>
            </div>
            </article>
          );
        }) : (
          <div className="panel-empty">
            <MagicWand size={24} weight="duotone" />
            <p>{importJob
              ? importTranscriptStatus(importJob)
              : stage === "review"
                ? "这场会议没有逐字稿；笔记与纪要仍保留。"
                : "开始录音后，转录会出现在这里。"}</p>
            {!importJob && stage === "review" && emptyActionLabel && onEmptyAction && (
              <button className="button button--secondary button--small" onClick={onEmptyAction}>
                {emptyActionLabel}
              </button>
            )}
            {!importJob && stage === "review" && onRetranscribe && (
              <button
                className="button button--secondary button--small"
                title="用已归档的录音重新转写这场会议；笔记与手动锁定的纪要内容会保留"
                onClick={onRetranscribe}
              >
                <ArrowClockwise size={15} />从录音重新转录
              </button>
            )}
          </div>
        )}
      </div>
      {meeting.transcript.length > 0 && (!autoScroll || stage === "live" || importActive || playingSegment) && <button
        className={`follow-control ${autoScroll ? "is-active" : ""}`}
        aria-pressed={autoScroll}
        onClick={() => {
          const list = listRef.current;
          if (!list) return;
          setAutoScroll(true);
          const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" as const : "smooth" as const;
          const el = playingSegment ? list.querySelector<HTMLElement>(`[data-segment-id="${playingSegment.id}"]`) : null;
          followGuardUntil.current = performance.now() + 450;
          if (el) {
            const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
            list.scrollTo({ top: Math.max(0, list.scrollTop + top - list.clientHeight / 3), behavior });
          } else {
            list.scrollTo({ top: list.scrollHeight, behavior });
          }
        }}
      >
        {autoScroll ? <CheckCircle size={14} weight="fill" /> : <ArrowDown size={14} weight="bold" />}
        {autoScroll ? (playingSegment ? "跟随回放" : "正在跟随") : "恢复跟随"}
      </button>}

      {speakerEditor && (
        <div className="speaker-popover">
          <PencilSimple size={16} />
          <input
            className="speaker-popover__input"
            autoFocus
            defaultValue={speakers.find(([id]) => id === speakerEditor)?.[1] ?? ""}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                renameSpeaker(
                  speakerEditor,
                  event.currentTarget.value.trim() || "未命名发言人",
                  rememberVoice
                );
              }
              if (event.key === "Escape") setSpeakerEditor(null);
            }}
          />
          <small>回车应用到该发言人的全部片段</small>
          <label className="speaker-popover__remember">
            <input
              type="checkbox"
              checked={rememberVoice}
              onChange={(event) => setRememberVoice(event.target.checked)}
            />
            <span>
              让本机记住这个声音，下次自动命名
              <small>声纹只保存在这台设备，可随时在发言人管理里删除。</small>
            </span>
          </label>
        </div>
      )}
      <ConfirmDialog open={voiceprintConfirm.open} request={voiceprintConfirm.request} onSettle={voiceprintConfirm.settle} />
    </>
  );
}

/** 概览只摘录已有纪要，不改写原文，也不会因打开转录页触发模型请求。 */
function TranscriptOverview({ summary, busy, onRefresh }: {
  summary: Meeting["summary"];
  busy?: boolean;
  onRefresh?(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const points = summary.keyPoints.filter((point) => point.trim());
  const text = points.join("\n");
  useEffect(() => { setCopyState("idle"); }, [text]);

  return (
    <section className={`transcript-overview ${summary.stale ? "is-stale" : ""}`} aria-label="会议概览">
      <header>
        <h2><MagicWand size={17} weight="duotone" />会议概览</h2>
        <div className="transcript-overview__actions">
          {onRefresh && <button className="icon-button" disabled={busy} title="更新纪要" aria-label="更新会议概览" onClick={onRefresh}>
            <ArrowClockwise size={17} className={busy ? "spin" : ""} />
          </button>}
          {points.length > 0 && <button className="icon-button" title="复制概览" aria-label="复制会议概览" onClick={async () => {
            try { await navigator.clipboard.writeText(text); setCopyState("copied"); }
            catch { setCopyState("failed"); }
          }}>{copyState === "copied" ? <Check size={17} /> : <Copy size={17} />}</button>}
        </div>
      </header>
      {points.length ? <>
        <p>{points.slice(0, 2).join(" ")}</p>
        {points.length > 2 && <>
          <div className={`transcript-overview__expansion ${expanded ? "is-expanded" : ""}`} inert={!expanded}>
            <div id="transcript-overview-more"><p>{points.slice(2).join(" ")}</p></div>
          </div>
          <button className="transcript-overview__toggle" aria-expanded={expanded} aria-controls="transcript-overview-more" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起概览" : "展开概览"}<CaretDown size={13} />
          </button>
        </>}
      </> : <p className="transcript-overview__empty">{busy ? "正在整理会议概览…" : "还没有纪要。"}</p>}
      {(busy || (summary.stale && !busy) || copyState !== "idle") && (
        <footer>
          {busy && <span>正在更新…</span>}
          {summary.stale && !busy && <span className="transcript-overview__stale">有新内容 · 待更新</span>}
          <span role="status">{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请重试" : ""}</span>
        </footer>
      )}
    </section>
  );
}

/** 「临时转写中…」定稿时保留 140ms 播放与入场对称的淡出，避免瞬间消失。 */
function ProvisionalBadge({ visible }: { visible: boolean }) {
  const { mounted, closing } = useExitPresence(visible, 140);
  if (!mounted) return null;
  return <span className={`provisional content-status-enter${closing ? " is-closing" : ""}`}>临时转写中…</span>;
}

/** 同一自然段续写时只让新增尾文出现；识别修正只给当前文字一次轻强调。 */
function AnimatedTranscriptCopy({ text, animate }: { text: string; animate: boolean }) {
  const previousRef = useRef(text);
  const change = animate
    ? classifyTextChange(previousRef.current, text)
    : { kind: "unchanged" as const, prefix: text, suffix: "" };
  useEffect(() => { previousRef.current = text; }, [text]);

  if (change.kind === "appended") {
    return (
      <p className="transcript-copy">
        {change.prefix}<span className="transcript-copy__tail" key={text}>{change.suffix}</span>
      </p>
    );
  }
  return <p className={`transcript-copy ${change.kind === "updated" ? "content-motion-update" : ""}`}>{text}</p>;
}

/** 导入任务阶段 → 即时状态；已有文本时仍保留状态行，不替换转录内容。 */
function importTranscriptStatus(job: ImportJob) {
  if (job.status === "queued" && job.stage === "copying") return "等待归档录音…";
  if (job.status === "copying" || job.stage === "copying") return "正在归档录音…";
  if (job.status === "preparing" || job.stage === "preparing") return "正在准备音频…";
  if (job.status === "waiting_for_model") return "等待配置转录模型，录音已安全归档。";
  if (job.status === "waiting_for_audio_tool") return "音频组件需要恢复后才能继续转录。";
  if (job.status === "waiting_for_network") {
    return `转录服务暂时不可达，稍后将自动从第 ${(job.completedChunks || 0) + 1} 段断点继续（已等待 ${job.transcriptionRetryAttempts || 1} 次）。`;
  }
  if (job.status === "failed") return `转录暂停：${job.error || "处理失败"}`;
  if (job.status === "cancelled") return "处理已暂停，已有转录仍会保留，可随时继续未完成的阶段。";
  if (job.status === "transcribing" || job.stage === "transcribing") {
    return job.totalChunks
      ? `正在转录第 ${Math.min((job.completedChunks || 0) + 1, job.totalChunks)}/${job.totalChunks} 段，约每 10 秒音频持续追加。`
      : "正在分析音频，首段文本很快会出现在这里。";
  }
  if (job.status === "diarizing") return "转录完成，正在识别不同发言人…";
  if (job.status === "summarizing") return "转录完成，正在整理会议纪要…";
  return "录音中没有识别到可显示的语音。";
}

/** 转写时间戳 → HH:MM:SS / MM:SS（相对录音起点，与播放器时间轴对齐）。 */
export function formatTranscriptTime(ms: number) {
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
