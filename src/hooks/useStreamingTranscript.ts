import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Meeting, TranscriptSegment } from "../types";
import {
  absorbTranscriptSegments,
  displayedTranscriptSegments,
  emptyRevealState,
  revealPending,
  revealTick,
  seedTranscriptReveal
} from "../lib/transcript-reveal";
import { TYPEWRITER_TICK_MS } from "../lib/typewriter";

/**
 * 转录流式揭示：转录进行中，新到达的文本按 typewriter 节奏逐拍铺开，
 * 与 AI 问答的回答同一观感。历史内容、切换会议与 Reduced Motion 直接透传
 * （不打字机）；会话结束立即把剩余内容揭示到位。
 * @param meeting 当前会议（以 meeting.transcript 为唯一事实源，仅显示层截断）
 * @param active 是否处于转录进行中（导入任务未终结，或会议进行中）
 */
export function useStreamingTranscript(meeting: Meeting, active: boolean): TranscriptSegment[] {
  const stateRef = useRef(emptyRevealState());
  const meetingRef = useRef(meeting);
  const [revision, setRevision] = useState(0);
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enabled = active && !reducedMotion;
  meetingRef.current = meeting;

  // 切换会议：已有内容全部视为已揭示，只有之后的新增量才流式铺开。
  useLayoutEffect(() => {
    seedTranscriptReveal(meetingRef.current.transcript, stateRef.current, enabled);
    setRevision((value) => value + 1);
    // 有意只在会议切换时执行：中途的 enabled 变化由下方 absorb 兜底。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  // 新内容到达：登记揭示记账（新段入队、追加增量入队、改写立即到位）。
  useLayoutEffect(() => {
    absorbTranscriptSegments(meeting.transcript, stateRef.current, enabled);
    setRevision((value) => value + 1);
  }, [meeting.transcript, enabled]);

  // 出字循环：常驻轻量定时器，队列空转一拍即过（不做 DOM 工作）。
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (!revealPending(stateRef.current)) return;
      const ticked = revealTick(meetingRef.current.transcript, stateRef.current);
      if (ticked) setRevision((value) => value + 1);
    }, TYPEWRITER_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return useMemo(
    () => displayedTranscriptSegments(meeting.transcript, stateRef.current),
    // revision 触发出字后的重渲染；stateRef 是稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meeting.transcript, revision]
  );
}
