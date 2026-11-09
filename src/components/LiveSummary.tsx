import { ArrowClockwise, PencilSimple, X } from "@phosphor-icons/react";
import type { Meeting } from "../types";

interface LiveSummaryProps {
  meeting: Meeting;
  busy: boolean;
  onRefresh(): void;
  onCancel(): void;
  onEdit(): void;
}

export function LiveSummary({ meeting, busy, onRefresh, onCancel, onEdit }: LiveSummaryProps) {
  const { summary } = meeting;
  const details = [
    { title: "已确认决策", items: summary.decisions },
    { title: "未决问题", items: summary.openQuestions },
    { title: "风险", items: summary.risks },
    { title: "下一步", items: summary.nextSteps }
  ].filter(({ items }) => items.length > 0);
  const hasSummary = summary.keyPoints.length > 0 || summary.actionItems.length > 0 || details.length > 0;
  const hasSource = meeting.notes.some((note) => note.trim())
    || meeting.transcript.some((segment) => segment.status === "final" && segment.text.trim());
  const status = busy ? "正在总结…" : !hasSummary ? undefined
    : summary.generationMode === "local" ? "本机基础纪要"
    : summary.generationMode === "online" ? "AI 纪要" : undefined;

  return (
    <section className="live-summary" aria-labelledby="live-summary-title" aria-busy={busy}>
      <header className="live-summary__header">
        <h2 id="live-summary-title">实时总结</h2>
        <div className="live-summary__actions">
          {busy ? (
            <button className="text-button" onClick={onCancel} aria-label="取消总结"><X size={14} />取消</button>
          ) : (
            <button className="text-button" onClick={onRefresh} disabled={!hasSource} aria-label={hasSummary ? "更新实时总结" : "生成实时总结"}>
              <ArrowClockwise size={14} />{hasSummary ? "更新" : "生成"}
            </button>
          )}
          <button className="icon-button" onClick={onEdit} aria-label="编辑纪要" title="编辑纪要"><PencilSimple size={16} /></button>
        </div>
      </header>

      <div className="live-summary__scroll">
        {status && <p className="live-summary__status" role="status">{status}</p>}
        {!hasSummary && !busy && (
          <p className="live-summary__empty">{hasSource ? "已有会议内容，等待总结…" : "等待转写…"}</p>
        )}
        {hasSummary && summary.topics.length > 0 && (
          <ul className="live-summary__topics" aria-label="讨论主题">
            {summary.topics.map((topic, index) => <li key={index}>{topic}</li>)}
          </ul>
        )}
        {summary.keyPoints.length > 0 && (
          <ul className="live-summary__points" aria-label="关键结论">
            {summary.keyPoints.map((point, index) => (
              <li key={index}>
                {summary.keyPointHeadlines?.[index] && <strong>{summary.keyPointHeadlines[index]}</strong>}
                <p>{point}</p>
              </li>
            ))}
          </ul>
        )}
        {summary.actionItems.length > 0 && (
          <section className="live-summary__detail">
            <h3>行动项</h3>
            <ul>
              {summary.actionItems.map((item) => (
                <li key={item.id}>
                  <span>{item.title}</span>
                  {(item.owner || item.dueDate) && <small>{[item.owner, item.dueDate].filter(Boolean).join(" · ")}</small>}
                </li>
              ))}
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
