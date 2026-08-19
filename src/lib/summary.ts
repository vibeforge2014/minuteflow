/**
 * 纪要合并工具：把 AI 生成的新版纪要合入当前纪要时，保留用户手动锁定（manualLocks）的内容。
 *
 * 所属层：渲染层纯工具函数（会议纪要合并策略）。
 * 主要导出：lockSummaryField、unlockSummaryField、mergeSummaryRevision。
 */
import type { MeetingSummary } from "../types";

// 支持逐条锁定（manualLocks 以 `${key}:${index}` 寻址）的列表型字段。
const listKeys = ["keyPoints", "decisions", "openQuestions", "risks", "nextSteps"] as const;

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
    stale: false
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
