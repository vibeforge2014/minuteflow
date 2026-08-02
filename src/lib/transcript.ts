import type { TranscriptSegment } from "../types";

const overlapRatio = (left: TranscriptSegment, right: TranscriptSegment) => {
  const overlap = Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
  const shorter = Math.max(1, Math.min(left.endMs - left.startMs, right.endMs - right.startMs));
  return overlap / shorter;
};

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
    const next = [...current];
    next[duplicateIndex] = incoming.status === "final" || current[duplicateIndex].status !== "final"
      ? incoming
      : current[duplicateIndex];
    return next.sort((left, right) => left.startMs - right.startMs);
  }

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
