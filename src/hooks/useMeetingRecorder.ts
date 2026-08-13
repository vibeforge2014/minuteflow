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
  const updateSummary = useMeetingStore((state) => state.updateSummary);
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "paused" | "stopping">("idle");
  const [elapsed, setElapsed] = useState(meeting?.durationSeconds ?? 0);
  const [levels, setLevels] = useState({ microphone: 0, system: 0 });
  const [queue, setQueue] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const summaryTimerRef = useRef<number | null>(null);
  const meetingRef = useRef(meeting);
  const elapsedRef = useRef(elapsed);
  const preferencesSummaryIntervalRef = useRef(preferences.summaryIntervalSeconds);

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
    if (recorderRef.current) return;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsed(meeting?.durationSeconds ?? 0);
    if (meeting?.status === "recording") {
      setPhase("recording");
      timerRef.current = window.setInterval(() => {
        setElapsed((value) => value + 1);
      }, 1_000);
    } else {
      setPhase("idle");
    }
    return () => {
      if (!recorderRef.current && timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [meeting?.id]);

  const sttProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "stt" && profile.enabled),
    [profiles]
  );
  const llmProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "llm" && profile.enabled),
    [profiles]
  );

  const generateSummary = useCallback(async (final = false) => {
    const current = meetingRef.current;
    if (!current || summaryBusy) return;
    const baseVersion = current.updatedAt;
    setSummaryBusy(true);
    try {
      const summary = await api.summary.generate({
        profileId: llmProfile?.id,
        final,
        input: {
          title: current.title,
          goals: current.goals,
          notes: current.notes,
          transcript: current.transcript.filter((segment) => segment.status === "final"),
          previousSummary: current.summary
        }
      });
      const latest = meetingRef.current;
      if (!latest || latest.id !== current.id) return;
      if (!final && latest.updatedAt !== baseVersion) {
        await updateMeeting(current.id, (value) => ({
          ...value,
          summary: { ...value.summary, stale: true }
        }));
        setWarning("生成期间会议内容发生了变化，AI 结果未覆盖当前文档，请重新总结。");
        return;
      }
      await updateSummary(current.id, mergeSummaryRevision(latest.summary, summary));
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "生成纪要失败");
    } finally {
      setSummaryBusy(false);
    }
  }, [llmProfile?.id, summaryBusy, updateMeeting, updateSummary]);

  const generateSummaryRef = useRef(generateSummary);
  useEffect(() => {
    generateSummaryRef.current = generateSummary;
  }, [generateSummary]);

  const start = useCallback(async () => {
    if (!meeting || phase !== "idle") return;
    setPhase("starting");
    setWarning(null);
    try {
      const recorder = new MeetingRecorder(meeting, sttProfile, preferences.glossary, {
        onLevel: setLevels,
        onTranscriptionQueue: setQueue,
        onWarning: setWarning,
        onTranscript: (segment) => appendTranscript(meeting.id, segment)
      });
      recorderRef.current = recorder;
      await recorder.start();
      setElapsed(0);
      setPhase("recording");
      await updateMeeting(meeting.id, (current) => ({ ...current, status: "recording", durationSeconds: 0 }));
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
      summaryTimerRef.current = window.setInterval(
        () => generateSummary(false),
        preferences.summaryIntervalSeconds * 1_000
      );
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
  }, [appendTranscript, generateSummary, meeting, phase, preferences.glossary, preferences.summaryIntervalSeconds, sttProfile, updateMeeting]);

  const pause = useCallback(async () => {
    if (!meeting) return;
    if (phase === "recording") {
      recorderRef.current?.pause();
      setPhase("paused");
      if (timerRef.current) window.clearInterval(timerRef.current);
      await updateMeeting(meeting.id, (current) => ({ ...current, status: "paused", durationSeconds: elapsed }));
    } else if (phase === "paused") {
      recorderRef.current?.resume();
      setPhase("recording");
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
      await updateMeeting(meeting.id, (current) => ({ ...current, status: "recording" }));
    }
  }, [elapsed, meeting, phase, updateMeeting]);

  const stop = useCallback(async () => {
    if (!meeting || !["starting", "recording", "paused"].includes(phase)) return;
    if (phase === "starting") {
      setPhase("stopping");
      recorderRef.current?.cancelStart();
      return;
    }
    setPhase("stopping");
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
    try {
      if (recorderRef.current) await recorderRef.current.stop(elapsed);
      await updateMeeting(meeting.id, (current) => ({
        ...current,
        status: "complete",
        durationSeconds: elapsed
      }));
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "停止录音时发生错误");
    } finally {
      recorderRef.current = null;
      setPhase("idle");
      setLevels({ microphone: 0, system: 0 });
    }
  }, [elapsed, meeting, phase, updateMeeting]);

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
  }, []);

  useEffect(() => {
    const removeSuspend = api.system.onSuspend(() => {
      if (!recorderRef.current) return;
      recorderRef.current.pause();
      if (timerRef.current) window.clearInterval(timerRef.current);
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
      if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
      const intervalSeconds = meetingRef.current ? preferencesSummaryIntervalRef.current : 120;
      summaryTimerRef.current = window.setInterval(
        () => generateSummaryRef.current(false),
        intervalSeconds * 1_000
      );
      setWarning("系统已唤醒，已自动继续录音，请确认设备正常。");
    });
    return () => {
      removeSuspend();
      removeResume();
    };
  }, [updateMeeting]);

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
    generateSummary
  };
}
