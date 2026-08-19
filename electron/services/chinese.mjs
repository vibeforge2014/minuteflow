/**
 * AI 文本的简体中文归一化。使用 OpenCC 的台湾繁体用语到大陆简体转换，除字形外
 * 也能正确处理“管不著→管不着”等上下文词组。仅供转录和 AI 纪要使用；
 * 标题、个人笔记、术语表与说话人姓名不应传入这里。
 */
import { Converter } from "opencc-js";

const toSimplified = Converter({ from: "twp", to: "cn" });

export function simplifyChinese(value) {
  return typeof value === "string" ? toSimplified(value) : value;
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

export function simplifySummary(summary = {}) {
  const list = (value) => Array.isArray(value) ? value.map((item) => simplifyChinese(String(item))) : [];
  return {
    ...summary,
    topics: list(summary.topics),
    keyPoints: list(summary.keyPoints),
    decisions: list(summary.decisions),
    actionItems: Array.isArray(summary.actionItems)
      ? summary.actionItems.map((item) => ({ ...item, title: simplifyChinese(String(item.title ?? "")) }))
      : [],
    openQuestions: list(summary.openQuestions),
    risks: list(summary.risks),
    nextSteps: list(summary.nextSteps)
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
 * 无总结模型时生成压缩后的关键要点。它按句/分句评分，提取最有信息量的 1–2 个分句，
 * 再加上“会议决定/后续安排/风险提示/讨论重点”标签，避免把长转录原样搬进文档。
 */
export function buildBasicKeyPoints(transcript = []) {
  const informationPattern = /(确认|决定|结论|完成|进展|方案|目标|问题|原因|数据|结果|计划|建议|需要|风险|负责|下一步)/g;
  const fillerPattern = /^(嗯+|啊+|呃+|然后|就是|那个|这个|所以说|对对对|好的)[，,。.!！\s]*/;
  const units = transcript
    .filter((segment) => segment.status === "final")
    .flatMap((segment) => String(segment.text || "").split(/(?<=[。！？!?…])\s*/))
    .map((text, index) => ({ text: simplifyChinese(text).replace(fillerPattern, "").replace(/\s+/g, " ").trim(), index }))
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
    const selected = clauses
      .map((text, index) => ({ text, index, score: (text.match(informationPattern)?.length ?? 0) * 3 + text.length / 40 }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .sort((left, right) => left.index - right.index)
      .map((item) => item.text);
    const core = (selected.length ? selected.join("；") : unit.text).slice(0, 96).replace(/[，,；;：:]$/, "");
    const normalized = core.replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");
    if (!normalized || [...seen].some((value) => value.includes(normalized) || normalized.includes(value))) continue;
    seen.add(normalized);
    const label = /(决定|确认|结论|采用|确定)/.test(core) ? "会议决定"
      : /(需要|负责|完成|跟进|计划|下一步)/.test(core) ? "后续安排"
        : /(风险|延期|阻塞|合规|隐患)/.test(core) ? "风险提示"
          : "讨论重点";
    points.push(`${label}：${core}${core.length < unit.text.length ? "…" : ""}`);
    if (points.length >= 6) break;
  }
  return points;
}
