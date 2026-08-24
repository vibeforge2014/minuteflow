import { ArrowClockwise, CheckCircle, ImageSquare, Sparkle, WarningCircle } from "@phosphor-icons/react";
import type { Meeting, VisualSummary, VisualSummarySection } from "../types";

interface VisualSummaryViewProps {
  meeting: Meeting;
  visual?: VisualSummary;
  capable: boolean;
  busy: boolean;
  onRetry(): void;
}

/** 受限 schema 的原生视觉纪要渲染器；不使用 dangerouslySetInnerHTML。 */
export function VisualSummaryView({ meeting, visual, capable, busy, onRetry }: VisualSummaryViewProps) {
  if (!visual) {
    return (
      <section className="visual-summary-empty">
        <span><ImageSquare size={28} weight="duotone" /></span>
        <h2>{capable ? "视觉纪要尚未生成" : "当前使用普通纪要"}</h2>
        <p>{capable
          ? "生成最终纪要后，MinuteFlow 会自动把结论、风险与行动安排排成一张可分享的信息图。"
          : "在“设置 → AI 总结”中开启视觉纪要并通过结构验证后，最终纪要会自动生成视觉版。"}</p>
        {capable && (
          <button className="button button--primary" disabled={busy} onClick={onRetry}>
            {busy ? <><span className="button-spinner" />正在生成</> : <><Sparkle size={16} />生成视觉纪要</>}
          </button>
        )}
      </section>
    );
  }

  const stale = visual.stale || (meeting.summary.updatedAt && visual.sourceSummaryUpdatedAt !== meeting.summary.updatedAt);
  return (
    <div className="visual-summary-shell">
      {stale && (
        <div className="visual-summary-stale">
          <WarningCircle size={17} weight="fill" />
          <span>普通纪要已有更新，当前视觉版基于上一版本。</span>
          <button className="text-button" disabled={busy} onClick={onRetry}><ArrowClockwise size={14} />重试视觉版</button>
        </div>
      )}
      <article className="visual-summary-canvas" data-visual-summary-export>
        <header className="visual-summary-hero">
          <span className="visual-summary-kicker"><Sparkle size={14} weight="fill" />MinuteFlow 视觉纪要</span>
          <h1>{visual.title}</h1>
          <p>{visual.subtitle}</p>
          <div>
            <span>{new Date(meeting.scheduledAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</span>
            <span>{meeting.participants.length ? meeting.participants.join("、") : "参与者待补充"}</span>
            <span><CheckCircle size={14} weight="fill" />基于已确认纪要</span>
          </div>
        </header>

        <div className="visual-summary-sections">
          {visual.sections.map((section) => <VisualSection section={section} key={section.id} />)}
        </div>
        <footer>内容由模型整理，版式由 MinuteFlow 在本机生成</footer>
      </article>
    </div>
  );
}

function VisualSection({ section }: { section: VisualSummarySection }) {
  return (
    <section className={`visual-section visual-section--${section.tone} visual-section--${section.layout}`}>
      <header><strong>{String(section.number).padStart(2, "0")}</strong><h2>{section.title}</h2></header>
      {section.layout === "table" && section.table && (
        <div className="visual-table-wrap">
          <table>
            <thead><tr>{section.table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{section.table.rows.map((row, rowIndex) => (
              <tr key={`${section.id}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {section.layout === "cards" && section.cards && (
        <div className="visual-card-grid">
          {section.cards.map((card, index) => (
            <article key={`${section.id}-card-${index}`}>
              <div><h3>{card.title}</h3>{card.status && <span>{card.status}</span>}</div>
              {!!card.bullets.length && <ul>{card.bullets.map((bullet, bulletIndex) => <li key={`${index}-${bulletIndex}`}>{bullet}</li>)}</ul>}
              {card.takeaway && <p>{card.takeaway}</p>}
            </article>
          ))}
        </div>
      )}
      {section.layout === "callout" && section.callout && (
        <div className="visual-callout"><CheckCircle size={20} weight="duotone" /><p>{section.callout}</p></div>
      )}
    </section>
  );
}
