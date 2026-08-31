import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MeetingSummary } from "../types";
import {
  buildSummaryContentMotion,
  emptySummaryContentMotion,
  findEnteringItemIds,
  type SummaryContentMotion
} from "../lib/content-motion";

/** 只把当前会话中新出现的稳定 id 标记为入场；首次加载和切换会议保持静止。 */
export function useEnteringItemIds(scopeId: string, ids: readonly string[]) {
  const previousRef = useRef<{ scopeId: string; ids: Set<string> }>({
    scopeId,
    ids: new Set(ids)
  });
  const entering = useMemo(() => {
    return findEnteringItemIds(previousRef.current.scopeId, scopeId, previousRef.current.ids, ids);
  }, [scopeId, ids]);

  useLayoutEffect(() => {
    previousRef.current = { scopeId, ids: new Set(ids) };
  }, [scopeId, ids]);
  return entering;
}

/**
 * 仅在 AI 纪要 revision 改变时生成动效元数据。普通输入会刷新比较基线，但不会
 * 触发高亮；新增标记在 2.5 秒后清理，避免成为永久视觉噪音。
 */
export function useSummaryContentMotion(meetingId: string, summary: MeetingSummary) {
  const previousRef = useRef<{ meetingId: string; summary: MeetingSummary }>({ meetingId, summary });
  const [motion, setMotion] = useState<SummaryContentMotion>(emptySummaryContentMotion);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    if (previous.meetingId !== meetingId) {
      previousRef.current = { meetingId, summary };
      setMotion(emptySummaryContentMotion());
      return;
    }
    if (summary.updatedAt && summary.updatedAt !== previous.summary.updatedAt) {
      setMotion(buildSummaryContentMotion(previous.summary, summary));
    }
    previousRef.current = { meetingId, summary };
  }, [meetingId, summary]);

  useEffect(() => {
    if (!motion.revision) return;
    const timer = window.setTimeout(() => setMotion(emptySummaryContentMotion()), 2_500);
    return () => window.clearTimeout(timer);
  }, [motion.revision]);

  return motion;
}
