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
    ? toSimplified(value)
      .replace(/内核(?=(任务|内容|观点|结论|流程|能力|目标))/g, "核心")
      // 语音识别网关常把“什么”识别成异体写法“什幺”（幺≠麼，OpenCC 不处理）；按词组归一，不影响“幺妹”“老幺”等单字用法。
      .replace(/什幺/g, "什么")
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

function normalizeDiscussionTable(table) {
  const columns = table?.columns;
  if (!Array.isArray(columns) || columns.length < 2 || columns.length > 5
    || !columns.every((column) => typeof column === "string" && column.trim())) return undefined;
  const clean = (cell) => simplifyChinese(cell.trim());
  const rows = Array.isArray(table.rows)
    ? table.rows.filter((row) => Array.isArray(row) && row.length === columns.length
      && row.every((cell) => typeof cell === "string") && row.some((cell) => cell.trim())).map((row) => row.map(clean))
    : [];
  return rows.length >= 2 ? { columns: columns.map(clean), rows } : undefined;
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
    overview: typeof summary.overview === "string"
      ? simplifyChinese(summary.overview.trim()).slice(0, 240) || undefined
      : undefined,
    discussionSections: Array.isArray(summary.discussionSections)
      ? summary.discussionSections.flatMap((section) => {
          if (typeof section?.title !== "string" || !section.title.trim() || !Array.isArray(section.points)) return [];
          const points = section.points.flatMap((point) => {
            if (typeof point?.text !== "string" || !point.text.trim()) return [];
            return [{
              heading: typeof point.heading === "string" ? simplifyChinese(point.heading.trim()).slice(0, 100) || undefined : undefined,
              text: simplifyChinese(point.text.trim()).slice(0, 1000),
              evidenceSegmentId: typeof point.evidenceSegmentId === "string" ? point.evidenceSegmentId.trim() || undefined : undefined
            }];
          });
          const table = normalizeDiscussionTable(section.table);
          return points.length || table
            ? [{ title: simplifyChinese(section.title.trim()).slice(0, 100), points, ...(table ? { table } : {}) }]
            : [];
        })
      : undefined,
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

/** 过滤脱离上文就无法理解的口语片段，规则兜底不自行推断主语。 */
export function isStandaloneSummaryText(text) {
  return !/^(?:[这那](?:个|件|块|项|些|边)(?:是|有|就|还|要|也|能|的|[，,。？！?!]|$)|(?:目前|现在)(?:是|为|有|到|到了|达到)?\s*\d|(?:是|为|有|到了|达到)\s*\d|(?:他|他们|对方)(?:说|觉得|表示))/.test(text.trim());
}

/** 本机基础纪要保留能独立读懂的原句，带回来源段落的时间。 */
export function buildBasicKeyPoints(transcript = []) {
  const informationPattern = /(确认|决定|结论|完成|进展|方案|目标|问题|原因|数据|结果|计划|建议|需要|风险|负责|下一步)/g;
  const fillerPattern = /^(?:嗯+|啊+|呃+|然后|就是|所以说|对对对|好的)[，,。.!！\s]*/;
  const score = (text) => (text.match(informationPattern)?.length ?? 0) * 3
    + (/[0-9]/.test(text) ? 2 : 0) + Math.min(2, Math.floor(text.length / 18));
  const units = transcript
    .filter((segment) => segment.status === "final")
    .flatMap((segment) => String(segment.text || "").split(/(?<=[。！？!?…；;])\s*/).flatMap((utterance) => {
      const sentence = simplifyChinese(utterance).replace(fillerPattern, "").replace(/\s+/g, " ").trim().replace(/[。；;]$/, "");
      if (/[？?]$/.test(sentence)) return [];
      const candidates = sentence.length <= KEY_POINT_MAX_CHARS && isStandaloneSummaryText(sentence)
        ? [sentence]
        : sentence.split(/[，,；;]/).map((clause) => clause.trim());
      const text = candidates
        .filter((clause) => clause.length >= 8 && clause.length <= KEY_POINT_MAX_CHARS && isStandaloneSummaryText(clause))
        .sort((left, right) => score(right) - score(left))[0];
      return text ? [{ text, timeMs: segment.startMs, score: score(text) }] : [];
    }))
    .sort((left, right) => right.score - left.score);
  const seen = new Set();
  const points = [];
  for (const { text, timeMs } of units) {
    const normalized = text.replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");
    if (!normalized || [...seen].some((value) => value.includes(normalized) || normalized.includes(value))) continue;
    seen.add(normalized);
    points.push({ text, ...(typeof timeMs === "number" ? { timeMs } : {}) });
    if (points.length >= 6) break;
  }
  return points;
}
