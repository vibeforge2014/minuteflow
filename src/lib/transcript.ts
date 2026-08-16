/**
 * 转录合并工具：把新的转录段落无重复地并入现有转写列表，并支持说话人合并重映射。
 *
 * 所属层：渲染层纯工具函数（转写去重/合并策略）。
 * 主要导出：mergeTranscriptSegments、mergeSpeakerLabels。
 */
import type { TranscriptSegment } from "../types";

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
    return next.sort((left, right) => left.startMs - right.startMs);
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
  return [...withoutSupersededProvisional, incoming]
    .sort((left, right) => left.startMs - right.startMs);
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
