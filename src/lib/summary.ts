import type { MeetingSummary } from "../types";

const listKeys = ["keyPoints", "decisions", "openQuestions", "risks", "nextSteps"] as const;

export function lockSummaryField(summary: MeetingSummary, key: string) {
  return {
    ...summary,
    manualLocks: Array.from(new Set([...(summary.manualLocks ?? []), key]))
  };
}

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
    current[key].forEach((value, index) => {
      if (locks.has(`${key}:${index}`)) next[index] = value;
    });
    merged[key] = next.filter((value) => typeof value === "string");
  }

  const lockedActions = current.actionItems.filter((item) => locks.has(`action:${item.id}`));
  merged.actionItems = [
    ...incoming.actionItems.filter((item) =>
      !lockedActions.some((locked) => locked.id === item.id)),
    ...lockedActions
  ];
  return merged;
}
