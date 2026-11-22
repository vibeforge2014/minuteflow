import { ArrowClockwise, PencilSimple, X } from "@phosphor-icons/react";
import type { ImportJob, Meeting } from "../types";
import { hasUnassignedImportSpeakers, isActiveImportJob } from "../lib/import-status";
import { MinutesOverview, MinutesSections, MinutesSource, type MinutesSourceJump } from "./MinutesSections";

interface LiveSummaryProps {
  meeting: Meeting;
  recording: boolean;
  importJob?: ImportJob;
  busy: boolean;
  onRefresh(): void;
  onCancel(): void;
  onEdit(): void;
  onJumpToSource: MinutesSourceJump;
}

export function LiveSummary({ meeting, recording, importJob, busy, onRefresh, onCancel, onEdit, onJumpToSource }: LiveSummaryProps) {
  const { summary } = meeting;
  const details = [
    { title: "已确认决策", items: summary.decisions },
    { title: "未决问题", items: summary.openQuestions },
    { title: "风险", items: summary.risks },
    { title: "下一步", items: summary.nextSteps }
  ].filter(({ items }) => items.length > 0);
  const hasSummary = Boolean(summary.overview || summary.discussionSections?.length)
    || summary.keyPoints.length > 0 || summary.actionItems.length > 0 || details.length > 0;
  const hasSource = meeting.notes.some((note) => note.trim())
    || meeting.transcript.some((segment) => segment.status === "final" && segment.text.trim());
  const importPending = isActiveImportJob(importJob);
  const speakersUnassigned = hasUnassignedImportSpeakers(importJob);
  const generating = busy || importJob?.status === "summarizing";
  const status = generating ? "正在总结…" : !hasSummary ? undefined
    : summary.generationMode === "local" ? importPending ? "本机纪要预览" : "本机基础纪要"
    : summary.generationMode === "online" ? "AI 纪要" : undefined;

  return (
    <section className="live-summary" aria-labelledby="live-summary-title" aria-busy={generating}>
      <header className="live-summary__header">
        <h2 id="live-summary-title">{recording ? "实时总结" : "AI 纪要"}</h2>
        <div className="live-summary__actions">
          {busy ? (
            <button className="text-button" onClick={onCancel} aria-label="取消总结"><X size={14} />取消</button>
          ) : (
            <button className="text-button" onClick={onRefresh} disabled={!hasSource || importPending} aria-label={`${hasSummary ? "更新" : "生成"}${recording ? "实时总结" : "纪要"}`}>
              <ArrowClockwise size={14} />{hasSummary ? "更新" : "生成"}
            </button>
          )}
          <button className="icon-button" onClick={onEdit} aria-label="编辑纪要" title="编辑纪要"><PencilSimple size={16} /></button>
        </div>
      </header>

      <div className="live-summary__scroll">
        {(status || (hasSummary && summary.stale)) && (
          <p className="live-summary__status" role="status">
            {[status, hasSummary && summary.stale && !generating ? "待更新" : undefined].filter(Boolean).join(" · ")}
          </p>
        )}
        {summary.overview && <MinutesOverview text={summary.overview} />}
        {!hasSummary && !generating && (
          <p className="live-summary__empty">{recording
            ? hasSource ? "已有会议内容，等待总结…" : "等待转写…"
            : importPending && importJob?.autoSummarize !== false ? "等待生成纪要…" : "暂无纪要"}</p>
        )}
        {hasSummary && summary.topics.length > 0 && (
          <ul className="live-summary__topics" aria-label="讨论主题">
            {summary.topics.map((topic, index) => <li key={index}>{topic}</li>)}
          </ul>
        )}
        {summary.keyPoints.length > 0 && (
          <section className="live-summary__conclusions" aria-label="关键结论">
            <h3>关键结论</h3>
            <ul className="live-summary__points">
              {summary.keyPoints.map((point, index) => (
                <li key={index}>
                  {summary.keyPointHeadlines?.[index] && <strong>{summary.keyPointHeadlines[index]}</strong>}
                  <p>{point}</p>
                  <MinutesSource ms={summary.keyPointTimes?.[index]} onJump={onJumpToSource} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {!recording && (
          <MinutesSections sections={summary.discussionSections} transcript={meeting.transcript} onJump={onJumpToSource} />
        )}
        {summary.actionItems.length > 0 && (
          <section className="live-summary__detail">
            <h3>行动项</h3>
            <ul>
              {summary.actionItems.map((item) => {
                const owner = speakersUnassigned && item.owner === "发言人1" ? "" : item.owner;
                const source = meeting.transcript.find((segment) => segment.status === "final" && item.evidenceSegmentIds?.includes(segment.id));
                return (
                  <li key={item.id}>
                    <span>{item.title}</span>
                    <div className="live-summary__action-meta">
                      <small>{owner && owner !== "待确认" ? owner : "负责人待确认"} · {item.dueDate && item.dueDate !== "待确认" ? item.dueDate : "期限待确认"}</small>
                      <MinutesSource ms={source?.startMs} segmentId={source?.id} onJump={onJumpToSource} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {details.map(({ title, items }) => (
          <section key={title} className="live-summary__detail">
            <h3>{title}</h3>
            <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </section>
        ))}
      </div>
    </section>
  );
}
