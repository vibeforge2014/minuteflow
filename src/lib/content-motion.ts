import type { MeetingSummary } from "../types";

/** 内容变更的展示语义；只用于视图层，不进入持久化数据。 */
export type ContentChangeKind = "unchanged" | "added" | "updated" | "appended";

/** 首次加载/切换作用域不入场；同一作用域只返回真正新增的稳定 id。 */
export function findEnteringItemIds(
  previousScopeId: string,
  nextScopeId: string,
  previousIds: ReadonlySet<string>,
  nextIds: readonly string[]
) {
  if (previousScopeId !== nextScopeId) return new Set<string>();
  return new Set(nextIds.filter((id) => !previousIds.has(id)));
}

export interface TextChange {
  kind: ContentChangeKind;
  prefix: string;
  suffix: string;
}

/**
 * 区分文本首次出现、尾部续写和识别修正。自然段落会跨采集块增长，因此续写不能
 * 被当成整行替换，否则每次返回都会让旧文字闪烁。
 */
export function classifyTextChange(previous: string, next: string): TextChange {
  if (previous === next) return { kind: "unchanged", prefix: next, suffix: "" };
  if (!previous && next) return { kind: "added", prefix: "", suffix: next };
  if (previous && next.startsWith(previous)) {
    return { kind: "appended", prefix: previous, suffix: next.slice(previous.length) };
  }
  return { kind: "updated", prefix: next, suffix: "" };
}

/**
 * 按稳定身份比较列表。身份存在且内容改变为 updated；新身份为 added。
 * 字符串列表没有数据库 id 时由调用方提供“内容 + 重复次数”的稳定身份。
 */
export function classifyListChanges<T>(
  previous: readonly T[],
  next: readonly T[],
  identity: (item: T, index: number, values: readonly T[]) => string,
  fingerprint: (item: T) => string = (item) => JSON.stringify(item)
): ContentChangeKind[] {
  const previousByIdentity = new Map(previous.map((item, index, values) => [
    identity(item, index, values),
    fingerprint(item)
  ]));
  return next.map((item, index, values) => {
    const key = identity(item, index, values);
    const oldFingerprint = previousByIdentity.get(key);
    if (oldFingerprint === undefined) return "added";
    return oldFingerprint === fingerprint(item) ? "unchanged" : "updated";
  });
}

/** 为可能重复的字符串生成“值 + 当前出现序号”身份。 */
export function stringOccurrenceIdentity(item: string, index: number, values: readonly string[]) {
  let occurrence = 0;
  for (let itemIndex = 0; itemIndex <= index; itemIndex += 1) {
    if (values[itemIndex] === item) occurrence += 1;
  }
  return `${item}\u0000${occurrence}`;
}

/**
 * 字符串列表先保留完全相同（含重复次数）的条目，再把同位置未匹配内容视为改写；
 * 其余才是新增。这样 AI 改写一句话不会错误显示成全新的结论。
 */
export function classifyStringListChanges(previous: readonly string[], next: readonly string[]) {
  const previousKeys = previous.map(stringOccurrenceIdentity);
  const nextKeys = next.map(stringOccurrenceIdentity);
  const matchedPrevious = new Set<number>();
  const matchedNext = new Set<number>();
  nextKeys.forEach((key, nextIndex) => {
    const previousIndex = previousKeys.findIndex((candidate, index) => candidate === key && !matchedPrevious.has(index));
    if (previousIndex < 0) return;
    matchedPrevious.add(previousIndex);
    matchedNext.add(nextIndex);
  });
  return next.map((_, index) => {
    if (matchedNext.has(index)) return "unchanged" as const;
    if (index < previous.length && !matchedPrevious.has(index)) {
      matchedPrevious.add(index);
      return "updated" as const;
    }
    return "added" as const;
  });
}

export type SummaryListField = "topics" | "keyPoints" | "decisions" | "openQuestions" | "risks" | "nextSteps";

export interface SummaryContentMotion {
  revision?: string;
  lists: Record<SummaryListField, ContentChangeKind[]>;
  actions: Record<string, ContentChangeKind>;
}

export const emptySummaryContentMotion = (): SummaryContentMotion => ({
  lists: {
    topics: [],
    keyPoints: [],
    decisions: [],
    openQuestions: [],
    risks: [],
    nextSteps: []
  },
  actions: {}
});

/** 比较两次真正的 AI 纪要版本；手动逐字编辑不会调用此函数触发动效。 */
export function buildSummaryContentMotion(
  previous: MeetingSummary,
  next: MeetingSummary
): SummaryContentMotion {
  const fields: SummaryListField[] = [
    "topics",
    "keyPoints",
    "decisions",
    "openQuestions",
    "risks",
    "nextSteps"
  ];
  const lists = Object.fromEntries(fields.map((field) => [
    field,
    classifyStringListChanges(previous[field], next[field])
  ])) as SummaryContentMotion["lists"];
  const actionKinds = classifyListChanges(
    previous.actionItems,
    next.actionItems,
    (item) => item.id,
    (item) => JSON.stringify(item)
  );
  return {
    revision: next.updatedAt,
    lists,
    actions: Object.fromEntries(next.actionItems.map((item, index) => [item.id, actionKinds[index]]))
  };
}
