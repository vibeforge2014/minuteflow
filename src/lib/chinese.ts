/** 浏览器预览中的 AI 文本简体归一化；桌面主进程使用同一 OpenCC 配置。 */
import { Converter } from "opencc-js";
import type { MeetingSummary, TranscriptSegment } from "../types";

const toSimplified = Converter({ from: "twp", to: "cn" });

export const simplifyChinese = (value: string) => toSimplified(value)
  // OpenCC twp 会把部分商务语境中的“核心”词组误判成技术术语“内核”。
  .replace(/内核(?=(任务|内容|观点|结论|流程|能力|目标))/g, "核心");

export function simplifyTranscriptSegment(segment: TranscriptSegment): TranscriptSegment {
  return { ...segment, text: simplifyChinese(segment.text) };
}

export function simplifySummary(summary: MeetingSummary): MeetingSummary {
  const list = (values: string[] = []) => values.map(simplifyChinese);
  const visualSummary = summary.visualSummary
    ? {
        ...summary.visualSummary,
        title: simplifyChinese(summary.visualSummary.title),
        subtitle: simplifyChinese(summary.visualSummary.subtitle),
        sections: summary.visualSummary.sections.map((section) => ({
          ...section,
          title: simplifyChinese(section.title),
          table: section.table
            ? {
                columns: list(section.table.columns),
                rows: section.table.rows.map((row) => list(row))
              }
            : undefined,
          cards: section.cards?.map((card) => ({
            ...card,
            title: simplifyChinese(card.title),
            status: card.status ? simplifyChinese(card.status) : undefined,
            bullets: list(card.bullets),
            takeaway: card.takeaway ? simplifyChinese(card.takeaway) : undefined
          })),
          callout: section.callout ? simplifyChinese(section.callout) : undefined
        }))
      }
    : undefined;
  return {
    ...summary,
    topics: list(summary.topics),
    keyPoints: list(summary.keyPoints),
    decisions: list(summary.decisions),
    actionItems: (summary.actionItems ?? []).map((item) => ({ ...item, title: simplifyChinese(item.title) })),
    openQuestions: list(summary.openQuestions),
    risks: list(summary.risks),
    nextSteps: list(summary.nextSteps),
    visualSummary
  };
}
