/**
 * 转录流式揭示核心（纯函数）。转录文本以传输块为粒度到达（导入约 10 秒一块、
 * 直播约 8 秒一块），直接渲染会一次砸出整段；这里把每段的新增文本放入揭示队列，
 * 由 useStreamingTranscript 按 typewriter 节奏逐拍出字，得到与 AI 问答一致的
 * 流式观感。规则：
 * - revealed 记录每个在场段已揭示的字符数（完整揭示也保留，用于检测后续追加）；
 * - queue 只收还有待揭示文本的段，按到达顺序逐段揭示（一段铺完才铺下一段）；
 * - 非追加的改写（识别修正/替换）立即揭示到位，不重打；
 * - 会话结束（active=false）或切换会议时全部立即揭示，历史内容绝不打字机。
 */
import type { TranscriptSegment } from "../types";
import { typewriterStep } from "./typewriter";

export interface TranscriptRevealState {
  /** 每段已揭示的字符数；值 ≥ 文本长度 = 该段已完整揭示。 */
  revealed: Map<string, number>;
  /** 仍有待揭示文本的段 id，按到达顺序。 */
  queue: string[];
  /** 标点小停剩余拍数（一拍 40ms）。 */
  pauseTicks: number;
}

export function emptyRevealState(): TranscriptRevealState {
  return { revealed: new Map(), queue: [], pauseTicks: 0 };
}

/**
 * 新转录到达（或激活状态变化）时更新揭示状态。
 * @param segments 当前完整转录（揭示长度以其文本为准）
 * @param state 上一状态（原地更新后返回）
 * @param active 转录是否仍在进行；false 时清空全部揭示记账（直接透传渲染）
 */
export function absorbTranscriptSegments(
  segments: TranscriptSegment[],
  state: TranscriptRevealState,
  active: boolean
): TranscriptRevealState {
  if (!active) {
    state.revealed.clear();
    state.queue.length = 0;
    return state;
  }
  const live = new Set(segments.map((segment) => segment.id));
  for (const id of [...state.revealed.keys()]) {
    if (!live.has(id)) state.revealed.delete(id);
  }
  state.queue = state.queue.filter((id) => live.has(id));
  for (const segment of segments) {
    const previous = state.revealed.get(segment.id);
    if (previous === undefined) {
      // 本会话首次出现的段：全部作为待揭示文本入队。
      if (segment.text) {
        state.revealed.set(segment.id, 0);
        state.queue.push(segment.id);
      }
      continue;
    }
    if (segment.text.length < previous) {
      // 缩短（去重/整段替换）立即揭示到位。
      state.revealed.set(segment.id, segment.text.length);
      state.queue = state.queue.filter((id) => id !== segment.id);
      continue;
    }
    if (segment.text.length > previous && !state.queue.includes(segment.id)) {
      state.queue.push(segment.id);
    }
  }
  return state;
}

/**
 * 切换会议/首次挂载时的基线登记：当前已有内容全部视为已揭示（历史内容不打字机），
 * 之后的增量才流式铺开。
 */
export function seedTranscriptReveal(
  segments: TranscriptSegment[],
  state: TranscriptRevealState,
  active: boolean
): TranscriptRevealState {
  state.revealed.clear();
  state.queue.length = 0;
  if (!active) return state;
  for (const segment of segments) {
    if (segment.text) state.revealed.set(segment.id, segment.text.length);
  }
  return state;
}

/** 按 segments 数组引用缓存 id→segment 索引，避免长会议每 40ms 重建整张 Map。 */
const segmentIndexCache = new WeakMap<TranscriptSegment[], Map<string, TranscriptSegment>>();

function segmentByIdMap(segments: TranscriptSegment[]): Map<string, TranscriptSegment> {
  const cached = segmentIndexCache.get(segments);
  if (cached) return cached;
  const map = new Map(segments.map((item) => [item.id, item]));
  segmentIndexCache.set(segments, map);
  return map;
}

/**
 * 出字一拍：停顿拍直接跳过；否则揭示队首段的一个增量（typewriter 节奏，
 * 按整个队列积压字数平滑提速，标点处断句并留下小停）。返回 null 表示本拍无字可出。
 */
export function revealTick(
  segments: TranscriptSegment[],
  state: TranscriptRevealState
): { id: string; emit: string } | null {
  if (state.pauseTicks > 0) {
    state.pauseTicks -= 1;
    return null;
  }
  const byId = segmentByIdMap(segments);
  let totalPending = 0;
  for (const queuedId of state.queue) {
    const queued = byId.get(queuedId);
    if (!queued) continue;
    const done = state.revealed.get(queuedId) ?? 0;
    if (queued.text.length > done) totalPending += queued.text.length - done;
  }
  while (state.queue.length) {
    const id = state.queue[0];
    const segment = byId.get(id);
    const revealed = state.revealed.get(id) ?? 0;
    if (!segment || revealed >= segment.text.length) {
      state.queue.shift();
      continue;
    }
    const step = typewriterStep(segment.text.slice(revealed), totalPending);
    if (!step) {
      state.queue.shift();
      continue;
    }
    const next = revealed + step.emit.length;
    state.revealed.set(id, next);
    if (next >= segment.text.length) state.queue.shift();
    state.pauseTicks = step.pauseTicks;
    return { id, emit: step.emit };
  }
  return null;
}

/** 队列是否还有待揭示内容。 */
export function revealPending(state: TranscriptRevealState): boolean {
  return state.queue.length > 0;
}

/** 当前正在逐字铺开的段 id（尚未开始出字时返回 null，避免空行挂光标）。 */
export function activeRevealSegmentId(state: TranscriptRevealState): string | null {
  const head = state.queue[0];
  if (!head) return null;
  return (state.revealed.get(head) ?? 0) > 0 ? head : null;
}

/**
 * 计算显示用转录：
 * - 仍在排队且尚未出第一字的新段（revealed === 0）暂不渲染，防止先冒出一排空时间戳和空泡泡；
 *   等轮到它出第一字时，说话人标签、时间戳与正文再一起丝滑入场；
 * - 正在出字的段截断到已揭示长度，其余原样透传。
 */
export function displayedTranscriptSegments(
  segments: TranscriptSegment[],
  state: TranscriptRevealState
): TranscriptSegment[] {
  if (!state.revealed.size) return segments;
  return segments.flatMap((segment) => {
    const revealed = state.revealed.get(segment.id);
    if (revealed === undefined || revealed >= segment.text.length) return [segment];
    if (revealed <= 0 && segment.status !== "provisional" && segment.text.length > 0) return [];
    return [{ ...segment, text: segment.text.slice(0, revealed) }];
  });
}
