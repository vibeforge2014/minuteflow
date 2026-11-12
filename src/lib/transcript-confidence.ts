/**
 * 逐字稿置信度的渲染层常量与判断（与主进程 transcript-confidence.mjs 保持一致）。
 * confidence 是 0–1；undefined 表示引擎没有提供依据，不提示、不参与到「只看存疑」筛选。
 */
import type { TranscriptSegment } from "../types";

export const LOW_CONFIDENCE_THRESHOLD = 0.55;

export function isLowConfidence(value?: number): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value < LOW_CONFIDENCE_THRESHOLD;
}

export function countLowConfidence(segments: TranscriptSegment[] = []): number {
  return segments.reduce((total, segment) => total + (isLowConfidence(segment.confidence) ? 1 : 0), 0);
}
