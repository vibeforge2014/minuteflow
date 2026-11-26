import { ArrowClockwise, LinkSimple } from "@phosphor-icons/react";
import type { Meeting, TranscriptSegment } from "../types";
import { formatTranscriptTime } from "./TranscriptPanel";

export type MinutesSourceJump = (ms: number, segmentId?: string) => void;

export function MinutesSource({ ms, segmentId, onJump }: {
  ms?: number | null;
  segmentId?: string;
  onJump: MinutesSourceJump;
}) {
  if (typeof ms !== "number") return null;
  const time = formatTranscriptTime(ms);
  return (
    <button className="summary-point__time minutes-source" aria-label={`查看 ${time} 的转写原文`} onClick={() => onJump(ms, segmentId)}>
      <LinkSimple size={12} aria-hidden="true" />{time}
    </button>
  );
}

export function MinutesOverview({ text }: { text: string }) {
  return (
    <section className="minutes-overview" aria-label="会议概览">
      <h3>会议概览</h3>
      <p>{text}</p>
    </section>
  );
}

export function MinutesSections({ sections, transcript, onJump, onRegenerateSection, regeneratingIndex = null }: {
  sections?: Meeting["summary"]["discussionSections"];
  transcript: TranscriptSegment[];
  onJump: MinutesSourceJump;
  onRegenerateSection?(index: number): void;
  regeneratingIndex?: number | null;
}) {
  if (!sections?.length) return null;
  const sources = new Map(transcript.filter(({ status }) => status === "final").map((segment) => [segment.id, segment]));
  return (
    <section className="minutes-discussion" aria-label="分议题纪要">
      {sections.map((section, index) => (
        <section className="minutes-chapter" key={`${index}:${section.title}`}>
          <div className="minutes-chapter__head">
            <h3>{section.title}</h3>
            {onRegenerateSection && (
              <button
                type="button"
                className={`icon-button minutes-chapter__regen ${regeneratingIndex === index ? "is-busy" : ""}`}
                aria-label={`重新生成「${section.title}」`}
                title="仅重新生成这一议题章节"
                disabled={regeneratingIndex !== null}
                onClick={() => onRegenerateSection(index)}
              >
                <ArrowClockwise size={13} />
              </button>
            )}
          </div>
          <div className="minutes-chapter__body">
          {section.table && (
            <div className="minutes-chapter__table">
              <table aria-label={section.title}>
                <thead><tr>{section.table.columns.map((column, columnIndex) => <th scope="col" key={columnIndex}>{column}</th>)}</tr></thead>
                <tbody>{section.table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, cellIndex) => cellIndex === 0
                    ? <th scope="row" key={cellIndex}>{cell}</th>
                    : <td key={cellIndex}>{cell || "—"}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {section.points.length > 0 && <ul>
            {section.points.map((point, pointIndex) => {
              const source = point.evidenceSegmentId ? sources.get(point.evidenceSegmentId) : undefined;
              return (
                <li key={pointIndex}>
                  {point.heading && <strong>{point.heading}</strong>}
                  <p>{point.text}</p>
                  <MinutesSource ms={source?.startMs} segmentId={source?.id} onJump={onJump} />
                </li>
              );
            })}
          </ul>}
          </div>
        </section>
      ))}
    </section>
  );
}
