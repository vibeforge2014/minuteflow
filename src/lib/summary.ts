/**
 * 纪要合并工具：把 AI 生成的新版纪要合入当前纪要时，保留用户手动锁定（manualLocks）的内容。
 *
 * 所属层：渲染层纯工具函数（会议纪要合并策略）。
 * 主要导出：lockSummaryField、unlockSummaryField、mergeSummaryRevision。
 */
import type { MeetingSummary } from "../types";

// 支持逐条锁定（manualLocks 以 `${key}:${index}` 寻址）的列表型字段。
const listKeys = ["keyPoints", "decisions", "openQuestions", "risks", "nextSteps"] as const;
export type SummaryListKey = typeof listKeys[number];

/**
 * 与 keyPoints 平行的附属数组（证据时间/要点标题）按同一套锁定语义重建：
 * 基底取 incoming，锁定的行沿用 current 的对应值（越界补到尾部）；
 * 两边都没有该数组时返回 undefined，不写入空数组。
 */
function mirrorKeyPointField<T>(
  current: readonly (T | null)[] | undefined,
  incoming: readonly (T | null)[] | undefined,
  locks: Set<string>
): (T | null)[] | undefined {
  if (!current && !incoming) return undefined;
  const next: (T | null)[] = (incoming ?? []).map((value) => value ?? null);
  (current ?? []).forEach((value, index) => {
    if (!locks.has(`keyPoints:${index}`)) return;
    const kept = value ?? null;
    if (index < next.length) next[index] = kept;
    else next.push(kept);
  });
  return next;
}

/** 把某个纪要字段加入手动锁定集合（Set 去重），锁定后 AI 重算不会覆盖它。 */
export function lockSummaryField(summary: MeetingSummary, key: string) {
  return {
    ...summary,
    manualLocks: Array.from(new Set([...(summary.manualLocks ?? []), key]))
  };
}

/** 解除一个手动锁定（再次点击锁定标记时调用），该条目恢复由 AI 更新。 */
export function unlockSummaryField(summary: MeetingSummary, key: string) {
  return {
    ...summary,
    manualLocks: (summary.manualLocks ?? []).filter((item) => item !== key)
  };
}

/** 切换锁定状态：已锁定则解锁，未锁定则锁定。 */
export function toggleSummaryLock(summary: MeetingSummary, key: string) {
  return (summary.manualLocks ?? []).includes(key)
    ? unlockSummaryField(summary, key)
    : lockSummaryField(summary, key);
}

/**
 * 删除列表型字段的一行（如手动移除一条关键结论）：
 * - 该行的锁随之移除，其后同字段的锁索引左移一位，避免锁落到错误的行上；
 * - keyPoints 的证据时间数组同步切掉同位元素，保持与文本逐位对齐。
 */
export function removeSummaryListItem(summary: MeetingSummary, key: SummaryListKey, removeIndex: number): MeetingSummary {
  const prefix = `${key}:`;
  const manualLocks = (summary.manualLocks ?? []).flatMap((lock) => {
    if (!lock.startsWith(prefix)) return [lock];
    const index = Number(lock.slice(prefix.length));
    if (!Number.isInteger(index)) return [lock];
    if (index === removeIndex) return [];
    if (index > removeIndex) return [`${prefix}${index - 1}`];
    return [lock];
  });
  const next: MeetingSummary = {
    ...summary,
    [key]: summary[key].filter((_, index) => index !== removeIndex),
    manualLocks,
    stale: false
  };
  if (key === "keyPoints") {
    if (Array.isArray(summary.keyPointTimes)) {
      next.keyPointTimes = summary.keyPointTimes.filter((_, index) => index !== removeIndex);
    }
    if (Array.isArray(summary.keyPointHeadlines)) {
      next.keyPointHeadlines = summary.keyPointHeadlines.filter((_, index) => index !== removeIndex);
    }
  }
  return next;
}

/**
 * 把 AI 返回的新纪要（incoming）合入当前纪要（current）：
 * - "topics" 整体锁定时沿用 current 的主题列表（其余情况取 incoming）；
 * - 列表字段以 incoming 为主，但被 `key:index` 锁定的条目沿用 current 的原文并保持原位；
 * - 行动项按 id 合并：被 `action:<id>` 锁定的条目优先保留（AI 结果中同 id 的位置原位替换，
 *   AI 结果中不存在的补回到末尾），其余取 incoming；
 * - 合并结果清除 stale 标记。
 */
export function mergeSummaryRevision(
  current: MeetingSummary,
  incoming: MeetingSummary
): MeetingSummary {
  const locks = new Set(current.manualLocks ?? []);
  const merged: MeetingSummary = {
    ...incoming,
    manualLocks: [...locks],
    stale: false,
    visualSummary: incoming.visualSummary
      ?? (current.visualSummary ? { ...current.visualSummary, stale: true } : undefined)
  };

  // 主题整列表锁定：AI 不得整体改写讨论主题。
  merged.topics = locks.has("topics")
    ? current.topics.filter((value) => typeof value === "string")
    : (incoming.topics ?? []).filter((value) => typeof value === "string");

  for (const key of listKeys) {
    // 防御式过滤：剔除 AI 返回中的非字符串脏数据。
    const next = (incoming[key] ?? []).filter((value) => typeof value === "string");
    // 按索引回填锁定条目：锁定的是“当前位置的内容”，AI 改动该位置时以用户版本为准；
    // AI 列表变短时锁定条目补到尾部（内容不丢，顺序尽量保位）。
    current[key].forEach((value, index) => {
      if (!locks.has(`${key}:${index}`)) return;
      if (index < next.length) next[index] = value;
      else next.push(value);
    });
    merged[key] = next;
  }

  // keyPointTimes / keyPointHeadlines 与 keyPoints 平行重建：锁定的行沿用 current
  // 的附属值，其余取 incoming；两边都没有（旧数据）时不写入，避免全 null 噪音。
  const mirroredTimes = mirrorKeyPointField(current.keyPointTimes, incoming.keyPointTimes, locks);
  if (mirroredTimes) merged.keyPointTimes = mirroredTimes;
  const mirroredHeadlines = mirrorKeyPointField(current.keyPointHeadlines, incoming.keyPointHeadlines, locks);
  if (mirroredHeadlines) merged.keyPointHeadlines = mirroredHeadlines;

  const lockedActions = current.actionItems.filter((item) => locks.has(`action:${item.id}`));
  // 行动项合并：incoming 的骨架顺序保留，其中被锁定的 id 用用户版本原位替换；
  // AI 结果里没有的锁定行动项按 current 顺序补回末尾，保证用户编辑过的行动项不丢失。
  const lockedById = new Map(lockedActions.map((item) => [item.id, item]));
  merged.actionItems = [
    ...incoming.actionItems.map((item) => lockedById.get(item.id) ?? item),
    ...lockedActions.filter((item) => !incoming.actionItems.some((other) => other.id === item.id))
  ];
  return merged;
}
