/**
 * 转录合并工具：把新的转录段落无重复地并入现有转写列表，并支持说话人合并重映射。
 *
 * 所属层：渲染层纯工具函数（转写去重/合并策略）。
 * 主要导出：mergeTranscriptSegments、mergeSpeakerLabels。
 */
import type { TranscriptSegment } from "../types";
import { simplifyTranscriptSegment } from "./chinese";

const normalizedText = (value: string) => value.toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");

const TERMINAL_PUNCTUATION = /[。！？!?…]/g;
const HARD_TERMINAL = /[！？!?]\s*$/;
const COMPLETE_SENTENCE = /[。！？!?…]\s*$/;
const TOPIC_OPENER = /^(?:接下来|另外(?:一个|一点|一方面)?|关于|至于|最后|总结一下|下一(?:项|点|个)|第[二三四五六七八九十]+[点项个]|next\b|regarding\b|finally\b)/i;
const MAX_PARAGRAPH_CHARACTERS = 120;
const MAX_PARAGRAPH_DURATION_MS = 45_000;
const MAX_SILENCE_MS = 1_500;

/**
 * 把只有全文、没有模型时间片的结果拆成句子级原子片段。标点保留在原句中；
 * 无句末标点时整段保留，后续由段落构建器的长度/时长上限兜底。
 */
export function splitTranscriptText(value: string): string[] {
  const text = value.trim();
  if (!text) return [];
  return text.match(/[^。！？!?…]+(?:[。！？!?…]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [text];
}

/**
 * 在一个已知时间窗口内按文字长度为句子分配近似时间。仅用于模型只返回全文的降级路径；
 * 支持细粒度时间片的模型不会经过这一步。
 */
export function splitTimedTranscriptText(text: string, startMs: number, endMs: number) {
  const parts = splitTranscriptText(text);
  if (parts.length <= 1) return parts.map((part) => ({ startMs, endMs, text: part }));
  const duration = Math.max(parts.length, endMs - startMs);
  const weights = parts.map((part) => Math.max(1, normalizedText(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = startMs;
  return parts.map((part, index) => {
    const next = index === parts.length - 1
      ? endMs
      : Math.min(endMs, Math.max(cursor + 1, startMs + Math.round(duration * weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0) / totalWeight)));
    const fragment = { startMs: cursor, endMs: Math.max(cursor + 1, next), text: part };
    cursor = fragment.endMs;
    return fragment;
  });
}

/**
 * 把相邻短片段整理成自然发言段落。段落以第一片的 id 为稳定 id；临时片段不参与合并，
 * 因而最终结果仍能原位替换“转写中”占位。8/10 秒音频传输窗口不参与段落判断；
 * 换人、长停顿、问句/感叹句、明确的话题起始或达到自然段落上限时才断开。
 */
export function groupTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((left, right) => left.startMs - right.startMs).reduce<TranscriptSegment[]>((grouped, raw) => {
    const current = simplifyTranscriptSegment(raw);
    const previous = grouped.at(-1);
    if (!previous || previous.status !== "final" || current.status !== "final") {
      grouped.push(current);
      return grouped;
    }
    const gapMs = current.startMs - previous.endMs;
    const combinedText = `${previous.text}${/[a-z\d]$/i.test(previous.text) && /^[a-z\d]/i.test(current.text) ? " " : ""}${current.text}`;
    const previousSentenceCount = previous.text.match(TERMINAL_PUNCTUATION)?.length ?? 0;
    const startsNewTopic = COMPLETE_SENTENCE.test(previous.text) && TOPIC_OPENER.test(current.text.trim());
    const canMerge = previous.speakerId === current.speakerId
      && previous.track === current.track
      && gapMs >= -500 && gapMs < MAX_SILENCE_MS
      && current.endMs - previous.startMs <= MAX_PARAGRAPH_DURATION_MS
      && combinedText.length <= MAX_PARAGRAPH_CHARACTERS
      && previousSentenceCount < 2
      && !HARD_TERMINAL.test(previous.text)
      && !startsNewTopic;
    if (!canMerge) {
      grouped.push(current);
      return grouped;
    }
    const previousKey = normalizedText(previous.text);
    const currentKey = normalizedText(current.text);
    grouped[grouped.length - 1] = {
      ...previous,
      endMs: Math.max(previous.endMs, current.endMs),
      text: previousKey.includes(currentKey) ? previous.text : combinedText,
      confidence: previous.confidence === undefined ? current.confidence
        : current.confidence === undefined ? previous.confidence
          : Math.min(previous.confidence, current.confidence)
    };
    return grouped;
  }, []);
}

/** 计算两段落的时间重叠率（重叠时长 / 较短段落时长），用于判断“同一段话”。 */
const overlapRatio = (left: TranscriptSegment, right: TranscriptSegment) => {
  const overlap = Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
  const shorter = Math.max(1, Math.min(left.endMs - left.startMs, right.endMs - right.startMs));
  return overlap / shorter;
};

/**
 * 把 incoming 段落并入 current 列表（结果始终按 startMs 升序）：
 * - 命中重复（同 id，或同轨道 + 文本相同 + 时间重叠率 ≥ 0.8）时原地替换，
 *   且 provisional 优先让位给 final；
 * - incoming 为 final 时，剔除同轨道、重叠率 ≥ 0.55 的临时段落（被定稿结果取代）；
 * - 否则直接追加。
 */
export function mergeTranscriptSegments(
  current: TranscriptSegment[],
  incoming: TranscriptSegment
): TranscriptSegment[] {
  const duplicateIndex = current.findIndex((segment) =>
    segment.id === incoming.id ||
    (
      segment.track === incoming.track &&
      segment.text.trim() === incoming.text.trim() &&
      overlapRatio(segment, incoming) >= 0.8
    )
  );
  if (duplicateIndex >= 0) {
    // 重复命中时用 incoming 覆盖；但已有定稿段落不回退为临时结果（final 不会被 provisional 盖掉）。
    const next = [...current];
    next[duplicateIndex] = incoming.status === "final" || current[duplicateIndex].status !== "final"
      ? incoming
      : current[duplicateIndex];
    return groupTranscriptSegments(next);
  }

  // 定稿结果到达时清掉它对应的临时段落（重叠率阈值放宽到 0.55，容忍时间边界抖动）。
  const withoutSupersededProvisional = incoming.status === "final"
    ? current.filter((segment) =>
      !(
        segment.status === "provisional" &&
        segment.track === incoming.track &&
        overlapRatio(segment, incoming) >= 0.55
      ))
    : current;
  return groupTranscriptSegments([...withoutSupersededProvisional, incoming]);
}

/** 说话人合并：把 sourceId 的全部段落改指到 targetId/targetName（用户在转录面板上手动归并说话人时调用）。 */
export function mergeSpeakerLabels(
  segments: TranscriptSegment[],
  sourceId: string,
  targetId: string,
  targetName: string
) {
  return segments.map((segment) =>
    segment.speakerId === sourceId
      ? { ...segment, speakerId: targetId, speakerName: targetName }
      : segment
  );
}
