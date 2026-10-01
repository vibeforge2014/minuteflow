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
  ArrowsMerge,
  CheckCircle,
  FingerprintSimple,
  MagicWand,
  PencilSimple,
  Trash,
  X
} from "@phosphor-icons/react";
import type { ImportJob, Meeting, VoiceprintPerson } from "../types";
import { api } from "../lib/api";
import { findPlayingSegment } from "../lib/workspace";
import { mergeSpeakerLabels } from "../lib/transcript";
import { classifyTextChange } from "../lib/content-motion";
import { useEnteringItemIds } from "../hooks/useContentMotion";
import { useExitPresence } from "../hooks/useExitPresence";
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
}

export function TranscriptView({ meeting, importJob, stage, onChange, playbackMs = 0, onSeek, emptyActionLabel, onEmptyAction }: TranscriptViewProps) {
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
    if (!list || !autoScroll || playingSegment || meeting.transcript.length === 0) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [tailSignature, autoScroll, visibleCount, playingSegment]);

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

  // 导入阶段/块计数变化时文本随之更新：以文本为 key 重挂，播放一次 160ms 微淡入。
  const transcriptStatus = importTranscriptStatus(importJob, meeting.transcript.length);

  return (
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
        <p className="transcript-hint content-status-enter" key={transcriptStatus}>{transcriptStatus}</p>
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
        {meeting.transcript.length ? visibleSegments.map((segment) => {
          const enteringIndex = enteringSequence.indexOf(segment.id);
          return (
            // is-playing：当前播放位置命中的段落整行高亮；data-segment-id 供回放跟随定位。
            <article
              className={`transcript-item transcript-item--${segment.status} ${playingSegment?.id === segment.id ? "is-playing" : ""} ${enteringIndex >= 0 ? "content-motion-enter" : ""}`}
              data-segment-id={segment.id}
              key={segment.id}
              style={enteringIndex >= 0 ? { animationDelay: `${Math.min(enteringIndex, 2) * 40}ms` } : undefined}
            >
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
              <CheckCircle size={16} className="transcript-check" weight="duotone" />
            </div>
            </article>
          );
        }) : (
          <div className="panel-empty">
            <MagicWand size={24} weight="duotone" />
            <p>{importJob
              ? importTranscriptStatus(importJob, 0)
              : stage === "review"
                ? "这场会议暂无可用逐字稿。笔记和已生成的纪要仍会保留。"
                : "开始录音后，转录会出现在这里。"}</p>
            {!importJob && stage === "review" && emptyActionLabel && onEmptyAction && (
              <button className="button button--secondary button--small" onClick={onEmptyAction}>
                {emptyActionLabel}
              </button>
            )}
          </div>
        )}
      </div>
      {meeting.transcript.length > 0 && <button
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
    </>
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
