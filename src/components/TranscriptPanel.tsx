import { useEffect, useMemo, useState } from "react";
import {
  ArrowsMerge,
  CheckCircle,
  MagicWand,
  PencilSimple,
  X
} from "@phosphor-icons/react";
import type { Meeting, TranscriptSegment } from "../types";
import { mergeSpeakerLabels } from "../lib/transcript";

interface TranscriptPanelProps {
  meeting: Meeting;
  onChange(meeting: Meeting): void;
  onAppend(id: string, segment: TranscriptSegment): Promise<void>;
  onClose(): void;
}

export function TranscriptPanel({ meeting, onChange, onClose }: TranscriptPanelProps) {
  const [tab, setTab] = useState<"transcript" | "summary">("transcript");
  const [speakerEditor, setSpeakerEditor] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [visibleCount, setVisibleCount] = useState(200);
  const speakers = useMemo(() => Array.from(new Map(
    meeting.transcript.map((segment) => [segment.speakerId, segment.speakerName])
  )), [meeting.transcript]);
  const visibleSegments = meeting.transcript.slice(-visibleCount);

  useEffect(() => {
    setVisibleCount(200);
  }, [meeting.id]);

  const renameSpeaker = (speakerId: string, name: string) => {
    onChange({
      ...meeting,
      transcript: meeting.transcript.map((segment) =>
        segment.speakerId === speakerId ? { ...segment, speakerName: name } : segment),
      summary: { ...meeting.summary, stale: true }
    });
    setSpeakerEditor(null);
  };

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
          <div className="transcript-subnav">
            <button className="is-active">实时转写</button>
            <button>最终版</button>
          </div>
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
          <div className="transcript-list">
            {meeting.transcript.length > visibleCount && (
              <button className="load-earlier" onClick={() => setVisibleCount((value) => value + 200)}>
                加载更早的 {Math.min(200, meeting.transcript.length - visibleCount)} 条
              </button>
            )}
            {meeting.transcript.length ? visibleSegments.map((segment) => (
              <article className={`transcript-item transcript-item--${segment.status}`} key={segment.id}>
                <time>{formatTranscriptTime(segment.startMs)}</time>
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
            <input type="checkbox" defaultChecked /> 自动滚动
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

function formatTranscriptTime(ms: number) {
  const total = 10 * 3600 + Math.floor(ms / 1000);
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}`;
}

function speakerColor(id: string) {
  if (id === "me") return "blue";
  const colors = ["orange", "purple", "green"];
  return colors[Math.abs(hash(id)) % colors.length];
}

function hash(value: string) {
  return Array.from(value).reduce((total, character) => total + character.charCodeAt(0), 0);
}
