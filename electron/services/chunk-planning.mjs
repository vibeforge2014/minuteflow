/**
 * 自适应转录切块计划（纯函数，无 Electron 依赖，便于单测）。
 *
 * 10 秒固定网格只是兜底：真实的目标是让每个传输块起止于自然停顿。
 * 边界在目标点前后一个小窗口内吸附最近的静音中点，避免把词切成两半
 * 伤害识别断句；找不到可用静音时回落到固定网格。块长始终限制在
 * [minMs, maxMs]，保证进度节奏与单块转录时延可控。
 */

export const ADAPTIVE_CHUNK_TARGET_MS = 10_000;
/** 边界搜索半径：目标点前后各 2.5 秒内的静音才参与吸附。 */
export const ADAPTIVE_CHUNK_WINDOW_MS = 2_500;
export const ADAPTIVE_CHUNK_MIN_MS = 7_000;
export const ADAPTIVE_CHUNK_MAX_MS = 13_000;

/**
 * 规划切块边界（含 0 起点，不含终点；尾块 = 最后边界到 duration）。
 * @param {number} durationMs 音频总时长（毫秒）
 * @param {Array<number>} silenceMidpointsMs 静音段中点列表（毫秒，无需排序）
 * @param {object} [tuning] 目标/窗口/上下限覆盖（测试用）
 * @returns {Array<number>} 升序边界列表，首项恒为 0
 */
export function planTranscriptionChunkBoundaries(durationMs, silenceMidpointsMs = [], {
  targetMs = ADAPTIVE_CHUNK_TARGET_MS,
  windowMs = ADAPTIVE_CHUNK_WINDOW_MS,
  minMs = ADAPTIVE_CHUNK_MIN_MS,
  maxMs = ADAPTIVE_CHUNK_MAX_MS
} = {}) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const boundaries = [0];
  while (duration - boundaries[boundaries.length - 1] > maxMs) {
    const previous = boundaries[boundaries.length - 1];
    const nominal = previous + targetMs;
    const candidate = silenceMidpointsMs
      .filter((point) =>
        point > previous + minMs
        && point < previous + maxMs
        && Math.abs(point - nominal) <= windowMs)
      .sort((left, right) => Math.abs(left - nominal) - Math.abs(right - nominal))[0];
    boundaries.push(candidate ?? nominal);
  }
  return boundaries;
}

/**
 * 解析 ffmpeg silencedetect 的 stderr，返回各静音段中点（毫秒，升序）。
 * 事件按出现顺序配对：每个 silence_start 与其后第一个 silence_end 组成一段；
 * 未闭合的 start、孤立的 end 一律忽略。贴近文件结尾的静音对切界没有价值，跳过。
 * @param {string} stderr ffmpeg stderr 文本
 * @param {number} [durationMs] 音频总时长；缺省视为无限长
 * @returns {Array<number>}
 */
export function parseSilenceMidpoints(stderr, durationMs = Number.POSITIVE_INFINITY) {
  const events = [];
  for (const match of String(stderr || "").matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    events.push({ kind: match[1], atMs: Number(match[2]) * 1000 });
  }
  const midpoints = [];
  let openStartMs = null;
  for (const event of events) {
    if (event.kind === "start") {
      openStartMs = event.atMs;
    } else if (openStartMs !== null) {
      const endMs = Math.min(event.atMs, durationMs);
      if (openStartMs < durationMs - 500) {
        midpoints.push(Math.round((openStartMs + endMs) / 2));
      }
      openStartMs = null;
    }
  }
  return midpoints.sort((left, right) => left - right);
}
