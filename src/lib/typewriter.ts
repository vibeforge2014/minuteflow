/**
 * 打字机出字核心（纯函数，AI 问答与转写流式揭示共用）。
 * 目标观感（Codex 风格）：按真实生成速度出字——约 40 字/秒起步、随待出缓冲
 * 增大提速（160 字/秒封顶）；出字在标点处断句并小停（句号 ~120ms、逗号 ~40ms），
 * 带自然呼吸而不是机械节拍器。一拍 = 40ms。
 */
export const TYPEWRITER_TICK_MS = 40;
export const TYPEWRITER_BASE_CPS = 40;
export const TYPEWRITER_RAMP = 0.35;
export const TYPEWRITER_MAX_CPS = 160;

/** 本拍计划出多少字：目标速率（字/秒）× 拍长（毫秒）。 */
export function plannedCharacters(pending: string): number {
  if (!pending) return 0;
  const cps = Math.min(TYPEWRITER_MAX_CPS, Math.max(TYPEWRITER_BASE_CPS, pending.length * TYPEWRITER_RAMP));
  return Math.max(1, Math.round((cps * TYPEWRITER_TICK_MS) / 1000));
}

/** 强停顿（句号级）3 拍 ≈120ms，软停顿（逗号级）1 拍 = 40ms。 */
export const STRONG_PAUSE_TICKS = 3;
export const SOFT_PAUSE_TICKS = 1;

/**
 * 短语节奏：本拍计划若即将越过标点，就切在标点处并要求随后小停。
 * 返回 null 表示按计划整拍出字，不切分。
 */
export function punctuationCut(planned: string): { emit: string; pauseTicks: number } | null {
  const strong = planned.search(/[。！？；]/);
  if (strong >= 1) return { emit: planned.slice(0, strong + 1), pauseTicks: STRONG_PAUSE_TICKS };
  const soft = planned.search(/[，、：]/);
  if (soft >= 1) return { emit: planned.slice(0, soft + 1), pauseTicks: SOFT_PAUSE_TICKS };
  return null;
}

/**
 * 出字一拍：返回本拍应展示的增量与随后的停顿拍数。
 * 缓冲为空返回 null（调用方无需重渲染）。
 */
export function typewriterStep(pending: string): { emit: string; pauseTicks: number } | null {
  if (!pending) return null;
  const planned = pending.slice(0, plannedCharacters(pending));
  const cut = punctuationCut(planned);
  return cut ?? { emit: planned, pauseTicks: 0 };
}
