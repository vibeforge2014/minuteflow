/**
 * AI 文本的简体中文归一化。使用 OpenCC 的台湾繁体用语到大陆简体转换，除字形外
 * 也能正确处理“管不著→管不着”等上下文词组。仅供转录和 AI 纪要使用；
 * 标题、个人笔记、术语表与说话人姓名不应传入这里。
 */
import { randomUUID } from "node:crypto";
import { Converter } from "opencc-js";

const toSimplified = Converter({ from: "twp", to: "cn" });

export function simplifyChinese(value) {
  return typeof value === "string"
    ? toSimplified(value).replace(/内核(?=(任务|内容|观点|结论|流程|能力|目标))/g, "核心")
    : value;
}

export function simplifyTranscriptResult(result = {}) {
  return {
    ...result,
    text: simplifyChinese(String(result.text ?? "")),
    segments: Array.isArray(result.segments)
      ? result.segments.map((segment) => ({ ...segment, text: simplifyChinese(String(segment.text ?? "")) }))
      : []
  };
}

/** 关键结论单行字数上限：一条结论只表达一件事，超长截断加省略号。 */
export const KEY_POINT_MAX_CHARS = 48;

/** 剥掉关键结论行首的类别标签前缀与 Markdown 列表符号（模型输出防抖、旧数据自愈共用）。 */
function stripKeyPointDecoration(value) {
  return value
    .replace(/^\s*(?:[-*•·]|\d{1,2}[.、)])\s+/, "")
    .replace(/^(会议决定|后续安排|风险提示|讨论重点)：/, "")
    .trim();
}

/**
 * keyPointTimes 与 keyPoints 逐位对齐：长度不符时截断/补 null，非数字归 null。
 * 输入不是数组时返回 undefined，未生成过时间的旧会议不写入全 null 数组。
 */
function normalizeKeyPointTimes(times, length) {
  if (!Array.isArray(times)) return undefined;
  return Array.from({ length }, (_, index) => {
    const value = times[index];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  });
}

/** keyPointHeadlines 同样逐位对齐：空串/非字符串归 null，超长截到 24 字。 */
function normalizeKeyPointHeadlines(headlines, length) {
  if (!Array.isArray(headlines)) return undefined;
  return Array.from({ length }, (_, index) => {
    const value = headlines[index];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 24) : null;
  });
}

export function simplifySummary(summary = {}) {
  const list = (value) => Array.isArray(value) ? value.map((item) => simplifyChinese(String(item))) : [];
  const visualSummary = summary.visualSummary && typeof summary.visualSummary === "object"
    ? {
        ...summary.visualSummary,
        title: simplifyChinese(String(summary.visualSummary.title ?? "")),
        subtitle: simplifyChinese(String(summary.visualSummary.subtitle ?? "")),
        sections: Array.isArray(summary.visualSummary.sections)
          ? summary.visualSummary.sections.map((section) => ({
              ...section,
              title: simplifyChinese(String(section.title ?? "")),
              table: section.table
                ? {
                    columns: list(section.table.columns),
                    rows: Array.isArray(section.table.rows) ? section.table.rows.map(list) : []
                  }
                : undefined,
              cards: Array.isArray(section.cards)
                ? section.cards.map((card) => ({
                    ...card,
                    title: simplifyChinese(String(card.title ?? "")),
                    status: card.status ? simplifyChinese(String(card.status)) : undefined,
                    bullets: list(card.bullets),
                    takeaway: card.takeaway ? simplifyChinese(String(card.takeaway)) : undefined
                  }))
                : undefined,
              callout: section.callout ? simplifyChinese(String(section.callout)) : undefined
            }))
          : []
      }
    : undefined;
  const keyPoints = list(summary.keyPoints).map(stripKeyPointDecoration);
  return {
    ...summary,
    topics: list(summary.topics),
    keyPoints,
    // 读路径自愈：剥掉旧版本烤进文本的标签/列表符号后，证据时间与文本逐位重新对齐。
    keyPointTimes: normalizeKeyPointTimes(summary.keyPointTimes, keyPoints.length),
    keyPointHeadlines: normalizeKeyPointHeadlines(summary.keyPointHeadlines, keyPoints.length),
    decisions: list(summary.decisions),
    actionItems: Array.isArray(summary.actionItems)
      ? summary.actionItems.map((item) => ({
          ...item,
          // 提示词不要求模型返回 id（schema 里也是可选），缺失时必须兜底生成唯一 id：
          // 否则所有行动项 id 同为 undefined，文档区勾选任意一行会命中全部行。
          id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
          title: simplifyChinese(String(item.title ?? ""))
        }))
      : [],
    openQuestions: list(summary.openQuestions),
    risks: list(summary.risks),
    nextSteps: list(summary.nextSteps),
    visualSummary
  };
}

export function simplifyMeetingAiText(meeting) {
  return {
    ...meeting,
    transcript: Array.isArray(meeting.transcript)
      ? meeting.transcript.map((segment) => ({ ...segment, text: simplifyChinese(segment.text) }))
      : [],
    summary: simplifySummary(meeting.summary)
  };
}

/**
 * 无总结模型时生成压缩后的关键要点。按句/分句评分，每条只取信息密度最高的一个分句
 * （行长纪律：一条结论一行，绝不「；」拼接多个要点），截到 KEY_POINT_MAX_CHARS，
 * 并把来源段落的开始时间带回，供关键结论卡片做「跳到原文」回链。
 * 输入段可缺 startMs（如数据库迁移只喂 text/status），此时 timeMs 为 undefined。
 * @returns {Array<{text: string, timeMs?: number}>}
 */
export function buildBasicKeyPoints(transcript = []) {
  const informationPattern = /(确认|决定|结论|完成|进展|方案|目标|问题|原因|数据|结果|计划|建议|需要|风险|负责|下一步)/g;
  const fillerPattern = /^(嗯+|啊+|呃+|然后|就是|那个|这个|所以说|对对对|好的)[，,。.!！\s]*/;
  let unitIndex = 0;
  const units = transcript
    .filter((segment) => segment.status === "final")
    .flatMap((segment) => String(segment.text || "")
      .split(/(?<=[。！？!?…])\s*/)
      .map((text) => ({
        text,
        startMs: typeof segment.startMs === "number" ? segment.startMs : undefined
      })))
    .map((unit) => ({ ...unit, text: simplifyChinese(unit.text).replace(fillerPattern, "").replace(/\s+/g, " ").trim(), index: unitIndex++ }))
    .filter((unit) => unit.text.length >= 8 && !/[？?]$/.test(unit.text))
    .map((unit) => ({
      ...unit,
      score: (unit.text.match(informationPattern)?.length ?? 0) * 3
        + Math.min(3, Math.floor(unit.text.length / 18))
        + unit.index / Math.max(1, transcript.length)
    }))
    .sort((left, right) => right.score - left.score);
  const seen = new Set();
  const points = [];
  for (const unit of units) {
    const clauses = unit.text.split(/[，,；;。]/).map((value) => value.trim()).filter((value) => value.length >= 6);
    // 只取信息密度最高的一个分句：关键结论一行只表达一件事。
    const best = clauses.length
      ? clauses
        .map((text, index) => ({ text, index, score: (text.match(informationPattern)?.length ?? 0) * 3 + text.length / 40 }))
        .sort((left, right) => right.score - left.score)[0].text
      : unit.text;
    const core = best.slice(0, KEY_POINT_MAX_CHARS).replace(/[，,；;：:]$/, "");
    const normalized = core.replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");
    if (!normalized || [...seen].some((value) => value.includes(normalized) || normalized.includes(value))) continue;
    seen.add(normalized);
    points.push({ text: `${core}${best.length > core.length ? "…" : ""}`, ...(unit.startMs !== undefined ? { timeMs: unit.startMs } : {}) });
    if (points.length >= 6) break;
  }
  return points;
}
