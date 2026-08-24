/**
 * 录音编排 hook：把 MeetingRecorder 服务（采集/分块/落盘）接入 React 与 Zustand store。
 * 职责包括：录音生命周期状态机（idle→starting→recording⇄paused→stopping）、每秒计时、
 * 滚动 AI 纪要定时器（暂停即停）、转写段落入账（定稿走节流落盘，临时段仅内存展示）、
 * 手动/自动总结（含取消与降级提示）、系统睡眠/唤醒的暂停与自动恢复，
 * 以及“录音中刷新页面”的假录音态修复（无录音器时按已中断收场）。
 *
 * 所属层：渲染层 hooks（连接 services/recording 与 store 的适配层）。
 * 主要导出：useMeetingRecorder。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { MeetingRecorder } from "../services/recording";
import { useMeetingStore } from "../store/meetingStore";
import type { Meeting } from "../types";
import { mergeSummaryRevision } from "../lib/summary";
import { formatDuration } from "../lib/format";

export function useMeetingRecorder(meeting: Meeting | undefined) {
  const profiles = useMeetingStore((state) => state.profiles);
  const preferences = useMeetingStore((state) => state.preferences);
  const updateMeeting = useMeetingStore((state) => state.updateMeeting);
  const appendTranscript = useMeetingStore((state) => state.appendTranscript);
  const appendProvisionalTranscript = useMeetingStore((state) => state.appendProvisionalTranscript);
  const dropProvisionalTranscript = useMeetingStore((state) => state.dropProvisionalTranscript);
  const flushMeeting = useMeetingStore((state) => state.flushMeeting);
  const updateSummary = useMeetingStore((state) => state.updateSummary);
  // 录音状态机：idle 空闲 / starting 授权与取流中 / recording 录制中 / paused 暂停 / stopping 收尾落盘中。
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "paused" | "stopping">("idle");
  const [elapsed, setElapsed] = useState(meeting?.durationSeconds ?? 0);
  // 实时电平（0-1），由 MeetingRecorder 的 AnalyserNode 回调驱动底部工具条的波形动画。
  const [levels, setLevels] = useState({ microphone: 0, system: 0 });
  // 待完成转写任务数，展示“转录队列”积压。
  const [queue, setQueue] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const summaryTimerRef = useRef<number | null>(null);
  // ref 镜像：让定时器与事件回调读到最新的会议/时长/偏好，而不必重建定时器。
  const meetingRef = useRef(meeting);
  const elapsedRef = useRef(elapsed);
  const preferencesSummaryIntervalRef = useRef(preferences.summaryIntervalSeconds);
  // 忙碌锁用 ref 而非 state：定时器回调与快速连点在 state 尚未提交时也能正确互斥。
  const summaryBusyRef = useRef(false);
  // starting 阶段用户按了停止（最后一次取消检查之后的兜底路径）。
  const stopRequestedDuringStartRef = useRef(false);

  useEffect(() => {
    meetingRef.current = meeting;
  }, [meeting]);

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  useEffect(() => {
    preferencesSummaryIntervalRef.current = preferences.summaryIntervalSeconds;
  }, [preferences.summaryIntervalSeconds]);

  useEffect(() => {
    // 切换会议（或首次挂载）且当前没有活跃录音器时，回到 idle 展示态。
    // 注意：录音器不可能跨渲染进程刷新存活，所以挂载时看到的 status=recording
    // 一定是上次录音被刷新/崩溃打断的残留——按“已中断”收场并明确告知用户，
    // 绝不能伪装成还在录音（那样停止时会把没有音频产物的会议标成已完成）。
    if (recorderRef.current) return;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsed(meeting?.durationSeconds ?? 0);
    setPhase("idle");
    if (meeting?.status === "recording" || meeting?.status === "paused") {
      void updateMeeting(meeting.id, (current) => ({ ...current, status: "interrupted" }));
      setWarning("上次录音因窗口刷新或异常退出未能正常结束，这场会议已标记为“已中断”；录音文件（如已落盘）仍保留。");
    }
    return () => {
      if (!recorderRef.current && timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [meeting?.id, updateMeeting]);

  // 订阅主进程推送的录音写盘失败：录音过程中即时告警（磁盘满/IO 错误），
  // 不必等停止收尾时才知道整个会话已损坏。
  useEffect(() => {
    const remove = api.recordings.onWriteError(({ message }) => {
      setWarning(`录音写盘出现问题：${message}`);
    });
    return remove;
  }, []);

  // 从已启用的档案中选出第一个 stt（转写）与 llm（总结）配置，作为本次会话使用的模型。
  const sttProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "stt" && profile.enabled),
    [profiles]
  );
  const llmProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "llm" && profile.enabled),
    [profiles]
  );

  /**
   * 生成 AI 纪要。final 省略时自动推导：会议不在录音/暂停中即为“会后终稿”，
   * 手动按钮因此能在录音结束后产出终稿总结（终稿路径不再不可达）。
   * 乐观并发保护：请求前记下会议的 updatedAt（baseVersion），返回后若已变化，
   * 只把纪要标记为 stale 而不覆盖文档，避免用旧转写冲掉用户刚写入的内容。
   * 主进程降级（未配置 LLM 或在线失败回退本地引擎）时返回 degraded 标记，
   * 这里合入结果的同时用 warning 告知用户，不再静默。
   */
  const generateSummary = useCallback(async (final?: boolean, automatic = false) => {
    const current = meetingRef.current;
    if (!current || summaryBusyRef.current) return;
    const isFinal = final ?? !["recording", "paused"].includes(current.status);
    const finalTranscript = current.transcript.filter((segment) => segment.status === "final");
    const sourceThroughMs = finalTranscript.reduce((maximum, segment) => Math.max(maximum, segment.endMs), 0);
    if (automatic) {
      const previousThroughMs = current.summary.sourceThroughMs ?? 0;
      const newSegments = finalTranscript.filter((segment) => segment.endMs > previousThroughMs).length;
      // 定时器只在真正积累出可归纳内容时调用模型，避免静音或零碎片段产生空请求。
      if (sourceThroughMs - previousThroughMs < 30_000 && newSegments < 4) return;
    }
    const baseNotes = JSON.stringify(current.notes);
    summaryBusyRef.current = true;
    setSummaryBusy(true);
    try {
      const { degraded, degradedReason, visualDegraded, visualDegradedReason, ...summary } = await api.summary.generate({
        meetingId: current.id,
        profileId: llmProfile?.id,
        final: isFinal,
        input: {
          title: current.title,
          participants: current.participants,
          goals: current.goals,
          notes: current.notes,
          transcript: finalTranscript,
          previousSummary: current.summary
        }
      });
      const latest = meetingRef.current;
      // 新转录在模型生成期间到达是正常情况：把结果合入最新快照，并将尚未覆盖部分标记
      // 为 stale。人工锁定字段始终由 mergeSummaryRevision 保留，不再整次丢弃结果。
      if (!latest || latest.id !== current.id) return;
      const latestThroughMs = latest.transcript
        .filter((segment) => segment.status === "final")
        .reduce((maximum, segment) => Math.max(maximum, segment.endMs), 0);
      const merged = mergeSummaryRevision(latest.summary, summary);
      merged.stale = latestThroughMs > (summary.sourceThroughMs ?? sourceThroughMs)
        || JSON.stringify(latest.notes) !== baseNotes;
      await updateSummary(current.id, merged);
      if (degraded && degradedReason) setWarning(degradedReason);
      else if (visualDegraded && visualDegradedReason) setWarning(visualDegradedReason);
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "生成纪要失败");
    } finally {
      summaryBusyRef.current = false;
      setSummaryBusy(false);
    }
  }, [llmProfile?.id, updateMeeting, updateSummary]);

  /** 只根据已经保存的普通纪要重试视觉版，不重复发送完整转录。 */
  const generateVisualSummary = useCallback(async () => {
    const current = meetingRef.current;
    if (!current || summaryBusyRef.current) return;
    summaryBusyRef.current = true;
    setSummaryBusy(true);
    try {
      const visualSummary = await api.summary.generateVisual({
        meetingId: current.id,
        profileId: llmProfile?.id,
        title: current.title,
        participants: current.participants,
        summary: current.summary
      });
      const latest = meetingRef.current;
      if (!latest || latest.id !== current.id) return;
      await updateSummary(current.id, { ...latest.summary, visualSummary });
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "生成视觉纪要失败");
    } finally {
      summaryBusyRef.current = false;
      setSummaryBusy(false);
    }
  }, [llmProfile?.id, updateSummary]);

  const generateSummaryRef = useRef(generateSummary);
  useEffect(() => {
    generateSummaryRef.current = generateSummary;
  }, [generateSummary]);

  /** 取消进行中的总结请求（主进程中止 AbortController），供“取消生成”按钮调用。 */
  const cancelSummary = useCallback(async () => {
    const current = meetingRef.current;
    if (!current) return;
    await api.summary.cancel(current.id).catch(() => {});
  }, []);

  /** 重启滚动纪要定时器：回调经 ref 取最新实例，间隔经 ref 取最新偏好。 */
  const restartSummaryTimer = useCallback(() => {
    if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
    summaryTimerRef.current = window.setInterval(
      () => generateSummaryRef.current(false, true),
      preferencesSummaryIntervalRef.current * 1_000
    );
  }, []);

  /**
   * 开始录音。可传入 meeting 覆盖参数：一键「创建并开始录音」时，闭包里的 meeting
   * prop 还是旧选中项（store 更新尚未重渲染），需要直接对刚创建的会议启动；
   * 覆盖参数与 prop 指向同一会议时行为不变。启动仍走完整的麦克风校验与授权流程。
   */
  const start = useCallback(async (override?: Meeting) => {
    const target = override ?? meeting;
    if (!target || phase !== "idle") return;
    stopRequestedDuringStartRef.current = false;
    setPhase("starting");
    setWarning(null);
    try {
      const recorder = new MeetingRecorder(target, sttProfile, preferences.glossary, {
        onLevel: setLevels,
        onTranscriptionQueue: setQueue,
        onWarning: setWarning,
        onTranscript: (segment) => appendTranscript(target.id, segment),
        onProvisional: (segment) => appendProvisionalTranscript(target.id, segment),
        onProvisionalSettled: (segmentId) => dropProvisionalTranscript(target.id, segmentId)
      });
      recorderRef.current = recorder;
      await recorder.start();
      // 用户在授权/取流期间按了停止，而取消信号晚于录音器最后一次检查：直接中止会话，
      // 会议退回草稿，状态机归位（否则会“看起来停了、实际在录”）。
      if (stopRequestedDuringStartRef.current) {
        stopRequestedDuringStartRef.current = false;
        recorderRef.current = null;
        setPhase("idle");
        await recorder.abort().catch(() => {});
        return;
      }
      setElapsed(0);
      setPhase("recording");
      await updateMeeting(target.id, (current) => ({ ...current, status: "recording", durationSeconds: 0 }));
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
      restartSummaryTimer();
    } catch (error) {
      recorderRef.current = null;
      // A failed/cancelled start must not leave a dangling summary timer that
      // would fire generateSummary against a meeting that never started.
      if (summaryTimerRef.current) {
        window.clearInterval(summaryTimerRef.current);
        summaryTimerRef.current = null;
      }
      setPhase("idle");
      if (!(error instanceof Error) || error.message !== "录音启动已取消。") {
        setWarning(error instanceof Error ? error.message : "无法开始录音");
      }
    }
  }, [appendProvisionalTranscript, appendTranscript, dropProvisionalTranscript, meeting, phase, preferences.glossary, restartSummaryTimer, sttProfile, updateMeeting]);

  const pause = useCallback(async () => {
    if (!meeting) return;
    if (phase === "recording") {
      recorderRef.current?.pause();
      setPhase("paused");
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      // 暂停期间转录不再增长，滚动总结定时器一并停下，不做无谓的远程调用。
      if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
      summaryTimerRef.current = null;
      await updateMeeting(meeting.id, (current) => ({ ...current, status: "paused", durationSeconds: elapsed }));
    } else if (phase === "paused") {
      recorderRef.current?.resume();
      setPhase("recording");
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
      restartSummaryTimer();
      await updateMeeting(meeting.id, (current) => ({ ...current, status: "recording" }));
    }
  }, [elapsed, meeting, phase, restartSummaryTimer, updateMeeting]);

  const stop = useCallback(async () => {
    if (!meeting || !["starting", "recording", "paused"].includes(phase)) return;
    if (phase === "starting") {
      // 记录停止意图：若取消信号来得及，start() 会以“已取消”异常收场；
      // 来不及（竞态）则 start() 成功返回后走 abort 兜底路径。
      stopRequestedDuringStartRef.current = true;
      setPhase("stopping");
      recorderRef.current?.cancelStart();
      return;
    }
    const recorder = recorderRef.current;
    setPhase("stopping");
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
    summaryTimerRef.current = null;
    try {
      if (recorder) await recorder.stop(elapsed);
      // 收尾前清掉仍在途的临时（provisional）转写段，避免“转写中…”残留到会后文档。
      dropProvisionalTranscript(meeting.id);
      await updateMeeting(meeting.id, (current) => ({
        ...current,
        // 没有活跃录音器却走到停止（防御路径，正常已被恢复逻辑拦下）：
        // 宁可标记“已中断”也不能把无音频产物的会议标成“已完成”。
        status: recorder ? "complete" : "interrupted",
        durationSeconds: elapsed
      }));
      if (recorder) await flushMeeting(meeting.id);
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "停止录音时发生错误");
    } finally {
      recorderRef.current = null;
      setPhase("idle");
      setLevels({ microphone: 0, system: 0 });
    }
  }, [dropProvisionalTranscript, elapsed, flushMeeting, meeting, phase, updateMeeting]);

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
  }, []);

  useEffect(() => {
    const removeSuspend = api.system.onSuspend(() => {
      if (!recorderRef.current) return;
      recorderRef.current.pause();
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
      summaryTimerRef.current = null;
      setPhase("paused");
      setWarning("系统已进入睡眠，录音已暂停并写入时间线。");
      const current = meetingRef.current;
      if (current) {
        updateMeeting(current.id, (value) => ({
          ...value,
          status: "paused",
          notes: [...value.notes, `[${formatDuration(elapsedRef.current)}] 系统进入睡眠，录音自动暂停`],
          notesMarkdown: [
            value.notesMarkdown || value.notes.join("\n\n"),
            `[${formatDuration(elapsedRef.current)}] 系统进入睡眠，录音自动暂停`
          ].filter(Boolean).join("\n\n")
        }));
      }
    });
    const removeResume = api.system.onResume(() => {
      if (!recorderRef.current) return;
      // After sleep/wake the recorder is paused; resume capture and restart the
      // periodic summary timer so rolling AI minutes keep updating. Without this,
      // a single sleep silently stops all automatic summaries for the session.
      try { recorderRef.current.resume(); } catch { /* recorder may already be stopped */ }
      setPhase("recording");
      restartSummaryTimer();
      setWarning("系统已唤醒，已自动继续录音，请确认设备正常。");
    });
    return () => {
      removeSuspend();
      removeResume();
    };
  }, [restartSummaryTimer, updateMeeting]);

  return {
    phase,
    elapsed,
    levels,
    queue,
    warning,
    summaryBusy,
    setWarning,
    start,
    pause,
    stop,
    generateSummary,
    generateVisualSummary,
    cancelSummary
  };
}
