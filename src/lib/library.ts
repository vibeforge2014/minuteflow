/**
 * 会议库（左侧栏）分组与搜索高亮的纯逻辑：
 * 平时收藏的会议固定置顶展示，其余按「今天/本周/更早」归组；
 * 搜索时退回纯时间分组（收藏也按时间归组），让结果顺序可预期。
 *
 * 所属层：渲染层纯工具函数（供 Sidebar 与单元测试使用）。
 * 主要导出：groupLibraryMeetings、splitHighlight。
 */
import type { Meeting } from "../types";

/** 侧栏分组：favorites 为收藏置顶组，其余为时间组。 */
export interface LibraryGroup<T = Meeting> {
  key: "favorites" | "today" | "week" | "earlier";
  label: string;
  meetings: T[];
}

/**
 * 把会议列表切为侧栏分组。searching=true（正在搜索）时不生成收藏置顶组，
 * 全部会议按时间归组；否则收藏会议独占置顶组，时间组只保留未收藏的会议。
 * 输入顺序即组内展示顺序（后端按最近更新返回），空组不输出。
 */
export function groupLibraryMeetings<T extends { favorite: boolean; scheduledAt: string }>(
  meetings: T[],
  searching: boolean
): LibraryGroup<T>[] {
  const favorites: T[] = [];
  const buckets: Record<"today" | "week" | "earlier", T[]> = { today: [], week: [], earlier: [] };
  const anchor = Date.now();
  for (const meeting of meetings) {
    if (!searching && meeting.favorite) {
      favorites.push(meeting);
      continue;
    }
    const difference = (anchor - new Date(meeting.scheduledAt).getTime()) / 86_400_000;
    if (difference < 1) buckets.today.push(meeting);
    else if (difference < 7) buckets.week.push(meeting);
    else buckets.earlier.push(meeting);
  }
  const groups: LibraryGroup<T>[] = [];
  if (favorites.length) groups.push({ key: "favorites", label: "收藏", meetings: favorites });
  if (buckets.today.length) groups.push({ key: "today", label: "今天", meetings: buckets.today });
  if (buckets.week.length) groups.push({ key: "week", label: "本周", meetings: buckets.week });
  if (buckets.earlier.length) groups.push({ key: "earlier", label: "更早", meetings: buckets.earlier });
  return groups;
}

/** 高亮片段：match=true 的片段在侧栏渲染为 <mark>。 */
export interface HighlightPart {
  text: string;
  match: boolean;
}

/**
 * 把文本按搜索词切为高亮片段（大小写不敏感；中文直接子串匹配，无需分词）。
 * 搜索词为空白时原样返回单个未匹配片段，调用方按纯文本渲染。
 */
export function splitHighlight(text: string, query: string): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;
  let index = haystack.indexOf(target);
  while (index !== -1) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
    index = haystack.indexOf(target, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
