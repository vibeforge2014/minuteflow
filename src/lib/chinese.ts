/** 浏览器预览中的 AI 文本简体归一化；桌面主进程使用同一 OpenCC 配置。 */
import { Converter } from "opencc-js";
import type { MeetingSummary, TranscriptSegment } from "../types";

const toSimplified = Converter({ from: "twp", to: "cn" });

export const simplifyChinese = (value: string) => toSimplified(value)
  // OpenCC twp 会把部分商务语境中的“核心”词组误判成技术术语“内核”。
  .replace(/内核(?=(任务|内容|观点|结论|流程|能力|目标))/g, "核心")
  // 语音识别网关常把“什么”识别成异体写法“什幺”（幺≠麼，OpenCC 不处理）；按词组归一，不影响“幺妹”“老幺”等单字用法。
  .replace(/什幺/g, "什么");

export function simplifyTranscriptSegment(segment: TranscriptSegment): TranscriptSegment {
  return { ...segment, text: simplifyChinese(segment.text) };
}

export function simplifySummary(summary: MeetingSummary): MeetingSummary {
  const list = (values: string[] = []) => values.map(simplifyChinese);
  // 读路径自愈：剥掉关键结论行首的类别标签前缀与 Markdown 列表符号（与主进程 twin 同步）。
  const stripKeyPoint = (item: string) => item
    .replace(/^\s*(?:[-*•·]|\d{1,2}[.、)])\s+/, "")
    .replace(/^(会议决定|后续安排|风险提示|讨论重点)：/, "")
    .trim();
  const keyPoints = list(summary.keyPoints).map(stripKeyPoint);
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
    keyPoints,
    // 证据时间与自愈后的文本逐位对齐；旧数据没有时间数组时不写入全 null。
    keyPointTimes: Array.isArray(summary.keyPointTimes)
      ? keyPoints.map((_, index) => {
        const value = summary.keyPointTimes?.[index];
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      })
      : summary.keyPointTimes,
    // 要点标题同样逐位对齐：空串/非字符串归 null，超长截到 24 字。
    keyPointHeadlines: Array.isArray(summary.keyPointHeadlines)
      ? keyPoints.map((_, index) => {
        const value = summary.keyPointHeadlines?.[index];
        return typeof value === "string" && value.trim() ? value.trim().slice(0, 24) : null;
      })
      : summary.keyPointHeadlines,
    decisions: list(summary.decisions),
    actionItems: (summary.actionItems ?? []).map((item) => ({
      ...item,
      // 兜底唯一 id：AI 纪要可能不带 id，缺 id 的行动项会在文档区互相串勾选。
      id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
      title: simplifyChinese(item.title)
    })),
    openQuestions: list(summary.openQuestions),
    risks: list(summary.risks),
    nextSteps: list(summary.nextSteps),
    visualSummary
  };
}
