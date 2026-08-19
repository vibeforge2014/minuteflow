/** 浏览器预览中的 AI 文本简体归一化；桌面主进程使用同一 OpenCC 配置。 */
import { Converter } from "opencc-js";
import type { MeetingSummary, TranscriptSegment } from "../types";

const toSimplified = Converter({ from: "twp", to: "cn" });

export const simplifyChinese = (value: string) => toSimplified(value);

export function simplifyTranscriptSegment(segment: TranscriptSegment): TranscriptSegment {
  return { ...segment, text: simplifyChinese(segment.text) };
}

export function simplifySummary(summary: MeetingSummary): MeetingSummary {
  const list = (values: string[] = []) => values.map(simplifyChinese);
  return {
    ...summary,
    topics: list(summary.topics),
    keyPoints: list(summary.keyPoints),
    decisions: list(summary.decisions),
    actionItems: (summary.actionItems ?? []).map((item) => ({ ...item, title: simplifyChinese(item.title) })),
    openQuestions: list(summary.openQuestions),
    risks: list(summary.risks),
    nextSteps: list(summary.nextSteps)
  };
}
