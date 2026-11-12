/**
 * 转写置信度归一（纯函数，无 Electron 依赖）。
 *
 * 各引擎给出的「把握」信号格式完全不同：Whisper verbose_json / faster-whisper 给
 * avg_logprob + no_speech_prob + compression_ratio，Apple Speech 只给 partial 标记，
 * sherpa / whisper.cpp 干脆什么都不给。此前 TranscriptSegment.confidence 在类型、
 * 数据库与段落合并逻辑里都留好了位置，却没有任何 provider 真正写入，UI 也无从
 * 提示「这段可能不准」。这里把异构信号统一折成 0–1，并保留「无信号 = undefined」
 * 的语义（不凭空给没提供依据的引擎打低分）。
 */

/** 低于该值在逐字稿上标注「可能不准」。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function finite(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * 把一段识别结果的信号折算为 0–1 置信度。
 * - avg_logprob 是对数概率，exp() 后即近似 token 平均概率（-0.2→0.82，-1.0→0.37）；
 * - no_speech_prob 直接按比例折损，避免「静音幻觉」被算成高置信度；
 * - compression_ratio > 2.4 是 Whisper 官方给的重复/幻觉启发式，额外降权；
 * - partial（Apple Speech 未定稿结果）同样降权。
 * @returns {number|undefined} 无任何信号时 undefined，表示「引擎没给依据」。
 */
export function deriveConfidence(source = {}) {
  if (!source || typeof source !== "object") return undefined;
  const direct = finite(source.confidence);
  const avgLogprob = finite(source.avg_logprob ?? source.avgLogprob);
  let probability;
  if (direct !== undefined && direct >= 0 && direct <= 1) probability = direct;
  else if (avgLogprob !== undefined) probability = Math.exp(Math.max(-5, Math.min(0, avgLogprob)));
  if (probability === undefined) return undefined;

  const noSpeech = finite(source.no_speech_prob ?? source.noSpeechProb);
  if (noSpeech !== undefined) probability *= 1 - clamp01(noSpeech);
  const compression = finite(source.compression_ratio ?? source.compressionRatio);
  if (compression !== undefined && compression > 2.4) probability *= 0.6;
  if (source.partial === true) probability *= 0.6;
  return Math.round(clamp01(probability) * 1000) / 1000;
}

/**
 * 给转录结果的每个原子段补 confidence，并给出整块置信度（取最低段，保守策略：
 * 一段里只要有一句可疑，整块就应被标出来等人复核）。
 */
export function withSegmentConfidence(result = {}) {
  const segments = Array.isArray(result.segments)
    ? result.segments.map((segment) => {
      const confidence = deriveConfidence(segment);
      return confidence === undefined ? segment : { ...segment, confidence };
    })
    : [];
  const overall = segments.length
    ? Math.min(...segments.map((segment) => segment.confidence ?? 1))
    : deriveConfidence(result);
  return {
    ...result,
    segments,
    ...(overall === undefined ? {} : { confidence: overall })
  };
}

/** 低于阈值才提示；undefined / 非法值一律不提示。 */
export function isLowConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < LOW_CONFIDENCE_THRESHOLD;
}
