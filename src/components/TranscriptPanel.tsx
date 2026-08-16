/**
 * 右侧面板（工作区右栏）：「转录」与「AI 总结」两个标签页。
 * 转录页：发言人色点与改名/合并管理、可编辑的转写段落（textarea 直接改写文本并标记纪要过期）、
 * 时间戳点击跳转播放器、播放进度驱动的歌词式高亮（is-playing）、
 * 长会议按 200 条增量加载 + 跟随尾部自动滚动。
 * AI 总结页：主题/决策/未决问题/下一步的只读列表（编辑在中央文档区）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsMerge,
  CheckCircle,
  MagicWand,
  PencilSimple,
  X
} from "@phosphor-icons/react";
import type { Meeting } from "../types";
import { mergeSpeakerLabels } from "../lib/transcript";

interface TranscriptPanelProps {
  meeting: Meeting;
  onChange(meeting: Meeting): void;
  onClose(): void;
  /** 当前播放位置（毫秒），用于高亮同步段落。 */
  playbackMs?: number;
  /** 点击时间戳时请求播放器跳转。 */
  onSeek?(ms: number): void;
}

export function TranscriptPanel({ meeting, onChange, onClose, playbackMs = 0, onSeek }: TranscriptPanelProps) {
  const [tab, setTab] = useState<"transcript" | "summary">("transcript");
  /** 正在重命名的说话人 id（显示浮层输入框）。 */
  const [speakerEditor, setSpeakerEditor] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  /** 当前渲染的转写条数（从最新往前窗口化，长会议渐进加载）。 */
  const [visibleCount, setVisibleCount] = useState(200);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 从转写中提取去重后的说话人 (id → name) 列表。
  const speakers = useMemo(() => Array.from(new Map(
    meeting.transcript.map((segment) => [segment.speakerId, segment.speakerName])
  )), [meeting.transcript]);
  const visibleSegments = meeting.transcript.slice(-visibleCount);

  // 切换会议时重置窗口化计数。
  useEffect(() => {
    setVisibleCount(200);
  }, [meeting.id]);

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

  /** 重命名说话人：批量替换其全部段落的显示名，并把纪要标记为过期（stale）。 */
  const renameSpeaker = (speakerId: string, name: string) => {
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((segment) =>
        segment.speakerId === speakerId ? { ...segment, speakerName: name } : segment),
      summary: { ...meeting.summary, stale: true }
    });
    setSpeakerEditor(null);
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

  return (
    <aside className="transcript-panel">
      <header className="transcript-panel__header">
        <div className="panel-tabs">
          <button className={tab === "transcript" ? "is-active" : ""} onClick={() => setTab("transcript")}>转录</button>
          <button className={tab === "summary" ? "is-active" : ""} onClick={() => setTab("summary")}>
            AI 总结 <small>Beta</small>
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
              </button>
            ))}
            <button className="speaker-merge" onClick={() => setManagerOpen((value) => !value)}>
              <ArrowsMerge size={14} />管理
            </button>
          </div>
          {managerOpen && (
            <section className="speaker-manager">
              <header>
                <div>
                  <strong>发言人管理</strong>
                  <small>批量改名或合并同一人的标签</small>
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
                      onBlur={(event) => {
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
            </section>
          )}
          <p className="transcript-hint">AI 实时转写中，临时内容仅供参考</p>
          <div className="transcript-list" ref={listRef}>
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
                  </button>
                  <textarea
                    value={segment.text}
                    rows={Math.max(2, Math.ceil(segment.text.length / 24))}
                    onChange={(event) => onChange({
                      ...meeting,
                      transcript: meeting.transcript.map((item) =>
                        item.id === segment.id ? { ...item, text: event.target.value } : item),
                      summary: { ...meeting.summary, stale: true }
                    })}
                  />
                  {segment.status === "provisional" && <span className="provisional">临时转写中…</span>}
                </div>
                <CheckCircle size={16} className="transcript-check" weight="duotone" />
              </article>
            )) : (
              <div className="panel-empty">
                <MagicWand size={24} weight="duotone" />
                <p>开始录音后，转录会出现在这里。</p>
              </div>
            )}
          </div>
          <label className="auto-scroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => setAutoScroll(event.target.checked)}
            />{" "}
            自动滚动
          </label>
        </>
      ) : (
        <div className="ai-panel">
          <section>
            <h3>当前议题</h3>
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
