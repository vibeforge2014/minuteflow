/**
 * 纪要合并工具：把 AI 生成的新版纪要合入当前纪要时，保留用户手动锁定（manualLocks）的内容。
 *
 * 所属层：渲染层纯工具函数（会议纪要合并策略）。
 * 主要导出：lockSummaryField、mergeSummaryRevision。
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

/**
 * 把 AI 返回的新纪要（incoming）合入当前纪要（current）：
 * - 列表字段以 incoming 为主，但被 `key:index` 锁定的条目沿用 current 的原文；
 * - 行动项按 id 覆盖：被 `action:<id>` 锁定的条目优先保留，其余取 incoming；
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

  for (const key of listKeys) {
    const next = [...(incoming[key] ?? [])];
    // 按索引回填锁定条目：锁定的是“当前位置的内容”，AI 改动该位置时以用户版本为准。
    current[key].forEach((value, index) => {
      if (locks.has(`${key}:${index}`)) next[index] = value;
    });
    // 防御式过滤：剔除 AI 返回中的非字符串脏数据。
    merged[key] = next.filter((value) => typeof value === "string");
  }

  const lockedActions = current.actionItems.filter((item) => locks.has(`action:${item.id}`));
  // 行动项合并：incoming 中未被锁定的 + 全部被锁定的，保证用户编辑过的行动项不丢失。
  merged.actionItems = [
    ...incoming.actionItems.filter((item) =>
      !lockedActions.some((locked) => locked.id === item.id)),
    ...lockedActions
  ];
  return merged;
}
