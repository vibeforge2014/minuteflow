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
import type { LiveTranscriptionFailure } from "../services/recording";
import { useMeetingStore } from "../store/meetingStore";
import type { ImportJob, Meeting } from "../types";
import { mergeSummaryRevision } from "../lib/summary";
import { formatDuration } from "../lib/format";

export interface AudioLevels { microphone: number; system: number }

/**
 * 实时电平的外部存储：60fps 的采样绝不进入 React state，否则每次采样都会让
 * App（无 selector 订阅整个 store 时尤甚）连同逐字稿列表一起重渲染。
 * 消费方 subscribe 后直接改 DOM，current 供首帧取值。
 */
export interface LevelSource {
  current: AudioLevels;
  subscribe(listener: (levels: AudioLevels) => void): () => void;
}

export function useMeetingRecorder(meeting: Meeting | undefined, importTranscribing = false, importJob?: ImportJob) {
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
  // 实时电平（0-1）：外部存储 + 订阅，不驱动 React 重渲染（见 LevelSource）。
  const levelListeners = useRef(new Set<(levels: AudioLevels) => void>());
  const levelSource = useMemo<LevelSource>(() => ({
    current: { microphone: 0, system: 0 },
    subscribe(listener) {
      levelListeners.current.add(listener);
      return () => { levelListeners.current.delete(listener); };
    }
  }), []);
  const publishLevels = useCallback((next: AudioLevels) => {
    levelSource.current = next;
    for (const listener of levelListeners.current) listener(next);
  }, [levelSource]);
  // 待完成转写任务数，展示“转录队列”积压。
  const [queue, setQueue] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  // 实时转写重试耗尽后的持久故障态：转写面板/录音条据此展示「改用本地 Whisper」等入口。
  // 与 warning（Toast）分离，避免失败提示 3 秒后消失、用户来不及处理。
  const [transcriptionFailure, setTranscriptionFailure] = useState<LiveTranscriptionFailure | null>(null);
  /** 「暂时忽略」后抑制同一场失败的横幅，直到转写恢复成功或开始新录音。 */
  const transcriptionFailureDismissedRef = useRef(false);
  const [summaryProgress, setSummaryProgress] = useState<{ meetingId: string; startedAt: number; receiving: boolean; modelName?: string } | null>(null);
  const [visualSummaryFailure, setVisualSummaryFailure] = useState<{ meetingId: string; message: string } | null>(null);
  const summaryBusy = summaryProgress !== null && summaryProgress.meetingId === meeting?.id;

  // 正在录音的会议 id：与界面当前选中项解耦。用户录音中切换到别的会议时，
  // 暂停/停止/睡眠暂停/自动纪要仍必须作用于这场会议，而不是“现在看着的那场”。
  const [recordingMeetingId, setRecordingMeetingId] = useState<string | null>(null);
  const recordingMeetingRef = useRef<Meeting | null>(null);
  const recordingMeeting = useMeetingStore((state) =>
    recordingMeetingId ? state.meetings.find((item) => item.id === recordingMeetingId) : undefined
  );
  /** 取录音会议的最新快照（搜索可能把旧快照滤出列表，此时回退启动时的副本）。 */
  const resolveRecordingMeeting = useCallback((): Meeting | undefined => {
    const fallback = recordingMeetingRef.current;
    if (!fallback) return undefined;
    return useMeetingStore.getState().meetings.find((item) => item.id === fallback.id) ?? fallback;
  }, []);
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const summaryTimerRef = useRef<number | null>(null);
  // 导入转写期间的阶段性纪要定时器。与录音滚动定时器分开：导入转写不是录音会话，
  // 但同样需要在转写增长时定期出阶段性纪要，而不是等整段转录完成才 summaries。
  const importSummaryTimerRef = useRef<number | null>(null);
  const importInitialTriggerRef = useRef<number | null>(null);
  const importTranscribingRef = useRef(importTranscribing);
  importTranscribingRef.current = importTranscribing;
  const importJobRef = useRef(importJob);
  importJobRef.current = importJob;
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
    transcriptionFailureDismissedRef.current = false;
    setTranscriptionFailure(null);
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

  // 模型选择（智谱式多可用语义）：所有已配置档案同时可用；具体用哪个在任务开启时勾选。
  // stt 支持「本场录音」的临时选择（准备卡/录音条下拉），未选择时走该类默认档再退第一条可用；
  // llm（滚动纪要/手动生成纪要）走默认档——按任务换模型在 AI 问答的面板切换器里做。
  const [recordingSttProfileId, setRecordingSttProfileId] = useState<string | undefined>(undefined);
  const sttProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "stt" && profile.id === recordingSttProfileId)
      || profiles.find((profile) => profile.kind === "stt" && profile.isDefault)
      || profiles.find((profile) => profile.kind === "stt" && profile.enabled),
    [profiles, recordingSttProfileId]
  );
  const llmProfile = useMemo(
    () => (importJob?.llmProfileId
        ? profiles.find((profile) => profile.id === importJob.llmProfileId && profile.kind === "llm" && profile.transport !== "local-summary")
        : undefined)
      || profiles.find((profile) => profile.kind === "llm" && profile.transport !== "local-summary" && profile.isDefault)
      || profiles.find((profile) => profile.kind === "llm" && profile.transport !== "local-summary" && profile.enabled),
    [profiles, importJob?.llmProfileId]
  );

  // 录音中改选转写档案（例如在线 Whisper 不可用后切到本地 Whisper）立即生效：
  // 录音器每个 8 秒块读取最新档案，无需停止/重开录音。
  useEffect(() => {
    recorderRef.current?.updateSttProfile(sttProfile);
  }, [sttProfile]);

  const dismissTranscriptionFailure = useCallback(() => {
    transcriptionFailureDismissedRef.current = true;
    setTranscriptionFailure(null);
  }, []);

  /**
   * 生成 AI 纪要。final 省略时自动推导：会议不在录音/暂停中即为“会后终稿”，
   * 手动按钮因此能在录音结束后产出终稿总结（终稿路径不再不可达）。
   * 请求返回后合入最新会议，主题、笔记或转写在生成期间变化时将纪要标记为 stale。
   */
  const generateSummary = useCallback(async (final?: boolean, automatic = false) => {
    // 定时滚动纪要：录音会话总结正在录的那场（即使界面已切走）；导入转写总结当前
    // 正在看的那场（没有 recording meeting 时回退）。手动点击总结当前查看的会议。
    const selected = meetingRef.current;
    const current = automatic ? (resolveRecordingMeeting()
      ?? (importTranscribingRef.current
        ? useMeetingStore.getState().meetings.find((item) => item.id === selected?.id)
        : undefined))
      : useMeetingStore.getState().meetings.find((item) => item.id === selected?.id);
    if (!current || summaryBusyRef.current) return;
    // 导入转写的自动滚动没配总结模型时静默跳过：定时器每间隔触发，否则会反复弹
    // 「请先配置」toast。转写完成后主进程会进入 waiting_for_summary_model 给出明确提示；
    // 录音滚动与手动生成保持既有行为不变。
    if (automatic && !llmProfile && importTranscribingRef.current) return;
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
    const template = preferences.summaryTemplate ?? "general";
    summaryBusyRef.current = true;
    setSummaryProgress({
      meetingId: current.id,
      startedAt: Date.now(),
      receiving: false,
      modelName: llmProfile?.model || llmProfile?.name
    });
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
          previousSummary: current.summary,
          template
        }
      }, () => setSummaryProgress((progress) => progress && { ...progress, receiving: true }));
      const latest = useMeetingStore.getState().meetings.find((item) => item.id === current.id);
      // 新转录在模型生成期间到达是正常情况：把结果合入最新快照，并将尚未覆盖部分标记
      // 为 stale。人工锁定字段始终由 mergeSummaryRevision 保留，不再整次丢弃结果。
      if (!latest) return;
      // 导入期间：若主进程已进入终稿总结或已完成终稿（generationMode=online 且覆盖到本次或更晚），
      // 丢弃迟到的阶段性滚动结果，避免覆盖终稿；在 diarizing 阶段允许在途阶段性纪要正常落盘展示。
      const activeJob = importJobRef.current;
      const mainSummarizingOrDone = Boolean(
        activeJob && activeJob.meetingId === current.id
        && (activeJob.status === "summarizing" || activeJob.summaryComplete)
      );
      const finalArrived = !isFinal
        && (mainSummarizingOrDone
          || (latest.summary.generationMode === "online"
            && summary.sourceThroughMs !== undefined
            && (latest.summary.sourceThroughMs ?? 0) >= summary.sourceThroughMs));
      if (finalArrived) return;
      const latestThroughMs = latest.transcript
        .filter((segment) => segment.status === "final")
        .reduce((maximum, segment) => Math.max(maximum, segment.endMs), 0);
      const merged = mergeSummaryRevision(latest.summary, summary);
      // 记录本次归纳视角：本机兜底纪要也沿用用户选择的模板说明，界面据此显示模板标签。
      merged.template = template;
      merged.stale = latestThroughMs > (summary.sourceThroughMs ?? sourceThroughMs)
        || latest.title !== current.title
        || JSON.stringify(latest.notes) !== baseNotes;
      await updateSummary(current.id, merged);
      if (degraded && degradedReason) setWarning(degradedReason);
      else if (visualDegraded && visualDegradedReason) setWarning(visualDegradedReason);
    } catch (error) {
      // 「取消生成」触发的 AbortError 是用户主动结束请求，不是失败，静默收尾即可。
      const abort = (error as { name?: string })?.name === "AbortError"
        || /abort/i.test(String((error as Error)?.message ?? ""));
      if (!abort) setWarning(error instanceof Error ? error.message : "生成纪要失败");
    } finally {
      summaryBusyRef.current = false;
      setSummaryProgress(null);
    }
  }, [llmProfile?.id, preferences.summaryTemplate, resolveRecordingMeeting, updateSummary]);

  /**
   * AI 深度提炼关键结论：只覆盖 keyPoints 及其平行的标题/时间字段，其余纪要字段
   * （概览、议题、决策、行动项、风险、用户手改与锁）原样保留。提炼失败直接提示，
   * 不回退本机规则——那正是粗劣结论的来源。
   */
  const refineKeyPoints = useCallback(async () => {
    const current = meetingRef.current;
    if (!current || summaryBusyRef.current) return;
    const finalTranscript = current.transcript.filter((segment) => segment.status === "final");
    if (!finalTranscript.length) {
      setWarning("会议还没有可归纳的转写内容，无法深度提炼。");
      return;
    }
    summaryBusyRef.current = true;
    setSummaryProgress({ meetingId: current.id, startedAt: Date.now(), receiving: false });
    try {
      const refined = await api.summary.refineKeyPoints({
        meetingId: current.id,
        profileId: llmProfile?.id,
        input: {
          title: current.title,
          participants: current.participants,
          goals: current.goals,
          notes: current.notes,
          transcript: finalTranscript,
          previousSummary: current.summary,
          template: preferences.summaryTemplate ?? "general"
        }
      });
      const latest = useMeetingStore.getState().meetings.find((item) => item.id === current.id);
      if (!latest) return;
      // 用整份纪要作为 incoming 交给既有的合并器：列表锁、平行字段镜像、行动项锁定
      // 全部沿用既有规则；由于只有关键结论字段被替换，其他节保持不变。
      const merged = mergeSummaryRevision(latest.summary, {
        ...latest.summary,
        keyPoints: refined.keyPoints,
        keyPointTimes: refined.keyPointTimes,
        keyPointHeadlines: refined.keyPointHeadlines,
        generationMode: refined.generationMode
      });
      await updateSummary(current.id, merged);
    } catch (error) {
      const abort = (error as { name?: string })?.name === "AbortError"
        || /abort/i.test(String((error as Error)?.message ?? ""));
      if (!abort) setWarning(error instanceof Error ? error.message : "深度提炼关键结论失败");
    } finally {
      summaryBusyRef.current = false;
      setSummaryProgress(null);
    }
  }, [llmProfile?.id, preferences.summaryTemplate, updateSummary]);

  /** 只根据已经保存的普通纪要重试视觉版，不重复发送完整转录。 */
  const generateVisualSummary = useCallback(async () => {
    const current = meetingRef.current;
    if (!current || summaryBusyRef.current) return;
    setVisualSummaryFailure(null);
    summaryBusyRef.current = true;
    setSummaryProgress({ meetingId: current.id, startedAt: Date.now(), receiving: false });
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
      // 与普通纪要一致：用户取消不是失败，不弹告警。
      const abort = (error as { name?: string })?.name === "AbortError"
        || /abort/i.test(String((error as Error)?.message ?? ""));
      if (!abort) {
        const message = error instanceof Error ? error.message : "生成视觉纪要失败";
        if (message.startsWith("[LICENSE_REQUIRED]")) setWarning(message);
        else setVisualSummaryFailure({ meetingId: current.id, message });
      }
    } finally {
      summaryBusyRef.current = false;
      setSummaryProgress(null);
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
   * 导入转写期间的阶段性纪要：
   * 1. 导入转写速度远快于实时录音（数秒即可产出 30s+ 语音），因此不再空等 60 秒才发首次请求：
   *    一旦积累够首批可归纳内容（≥30s 或 ≥4 段），1.5 秒防抖后立即生成首版阶段性纪要；
   * 2. 之后每 20 秒（或用户设定更短间隔）随新增转写滚动刷新；
   * 3. 转写完成进入说话人分离（diarizing）时停止发起新轮次，但放行已在途的阶段性纪要，
   *    只在主进程真正进入终稿总结（summarizing）或用户暂停时才中止在途滚动请求。
   */
  const finalTranscriptMetrics = useMemo(() => {
    if (!meeting) return { count: 0, endMs: 0 };
    let count = 0;
    let endMs = 0;
    for (const segment of meeting.transcript) {
      if (segment.status !== "final" || !segment.text.trim()) continue;
      count += 1;
      if (segment.endMs > endMs) endMs = segment.endMs;
    }
    return { count, endMs };
  }, [meeting?.transcript]);
  const hasExistingSummary = Boolean(
    meeting && (
      meeting.summary.overview?.trim()
      || meeting.summary.discussionSections?.length
      || meeting.summary.keyPoints.length > 0
      || meeting.summary.actionItems.length > 0
    )
  );
  const importFirstSummaryReady = Boolean(
    importTranscribing
    && meeting
    && llmProfile
    && !hasExistingSummary
    && (finalTranscriptMetrics.count >= 4 || finalTranscriptMetrics.endMs >= 30_000)
  );

  useEffect(() => {
    if (!importTranscribing || !meeting || !llmProfile) return;
    const tick = () => generateSummaryRef.current(false, true);
    const intervalMs = Math.min(Math.max(15, preferencesSummaryIntervalRef.current), 25) * 1_000;
    importSummaryTimerRef.current = window.setInterval(tick, intervalMs);
    return () => {
      if (importSummaryTimerRef.current) window.clearInterval(importSummaryTimerRef.current);
      importSummaryTimerRef.current = null;
    };
  }, [importTranscribing, meeting?.id, llmProfile?.id]);

  // 达到首批可归纳门槛（≥4 段或 ≥30s 语音）即刻触发一次首版阶段性纪要：
  // 依赖布尔态而非段落计数，避免高频分块到达（每 0.5-1s 一块）不断重置定时器导致永不触发。
  useEffect(() => {
    if (!importFirstSummaryReady || summaryBusyRef.current) return;
    importInitialTriggerRef.current = window.setTimeout(() => {
      importInitialTriggerRef.current = null;
      void generateSummaryRef.current(false, true);
    }, 600);
    return () => {
      if (importInitialTriggerRef.current) {
        window.clearTimeout(importInitialTriggerRef.current);
        importInitialTriggerRef.current = null;
      }
    };
  }, [importFirstSummaryReady, meeting?.id, llmProfile?.id]);

  // 主进程进入终稿总结阶段时，取消任何仍在途的阶段性滚动请求，避免与终稿并发写库。
  useEffect(() => {
    if (!meeting?.id) return;
    if (importJob?.status === "summarizing" && summaryBusyRef.current) {
      void api.summary.cancel(meeting.id).catch(() => {});
    }
  }, [importJob?.status, meeting?.id]);

  /**
   * 开始录音。可传入 meeting 覆盖参数：一键「创建并开始录音」时，闭包里的 meeting
   * prop 还是旧选中项（store 更新尚未重渲染），需要直接对刚创建的会议启动；
   * 覆盖参数与 prop 指向同一会议时行为不变。启动仍走完整的麦克风校验与授权流程。
   */
  const start = useCallback(async (override?: Meeting) => {
    const target = override ?? meeting;
    if (!target || phase !== "idle") return;
    // 从启动瞬间就绑定会议：授权/取流期间切换选中项也不会丢掉归属。
    recordingMeetingRef.current = target;
    setRecordingMeetingId(target.id);
    stopRequestedDuringStartRef.current = false;
    setPhase("starting");
    setWarning(null);
    transcriptionFailureDismissedRef.current = false;
    setTranscriptionFailure(null);
    try {
      const recorder = new MeetingRecorder(target, sttProfile, preferences.glossary, {
        onLevel: publishLevels,
        onTranscriptionQueue: setQueue,
        onWarning: setWarning,
        onTranscriptionFailure: (failure) => {
          if (!transcriptionFailureDismissedRef.current) setTranscriptionFailure(failure);
        },
        onTranscriptionRecovered: () => {
          transcriptionFailureDismissedRef.current = false;
          setTranscriptionFailure(null);
        },
        onTranscript: (segment) => appendTranscript(target.id, segment),
        onProvisional: (segment) => appendProvisionalTranscript(target.id, segment),
        onProvisionalSettled: (segmentId) => dropProvisionalTranscript(target.id, segmentId)
      }, { transcriptionLanguage: preferences.transcriptionLanguage });
      recorderRef.current = recorder;
      await recorder.start();
      // 用户在授权/取流期间按了停止，而取消信号晚于录音器最后一次检查：直接中止会话，
      // 会议退回草稿，状态机归位（否则会“看起来停了、实际在录”）。
      if (stopRequestedDuringStartRef.current) {
        stopRequestedDuringStartRef.current = false;
        recorderRef.current = null;
        recordingMeetingRef.current = null;
        setRecordingMeetingId(null);
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
      recordingMeetingRef.current = null;
      setRecordingMeetingId(null);
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
  }, [appendProvisionalTranscript, appendTranscript, dropProvisionalTranscript, meeting, phase, preferences.glossary, preferences.transcriptionLanguage, publishLevels, restartSummaryTimer, sttProfile, updateMeeting]);

  const pause = useCallback(async () => {
    // 绑定录音会议：切换选中项后暂停/继续仍写回正在录的那场。
    const target = resolveRecordingMeeting() ?? meeting;
    if (!target) return;
    if (phase === "recording") {
      recorderRef.current?.pause();
      setPhase("paused");
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      // 暂停期间转录不再增长，滚动总结定时器一并停下，不做无谓的远程调用。
      if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
      summaryTimerRef.current = null;
      await updateMeeting(target.id, (current) => ({ ...current, status: "paused", durationSeconds: elapsed }));
    } else if (phase === "paused") {
      recorderRef.current?.resume();
      setPhase("recording");
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
      restartSummaryTimer();
      await updateMeeting(target.id, (current) => ({ ...current, status: "recording" }));
    }
  }, [elapsed, meeting, phase, resolveRecordingMeeting, restartSummaryTimer, updateMeeting]);

  const stop = useCallback(async () => {
    const target = resolveRecordingMeeting() ?? meeting;
    if (!target || !["starting", "recording", "paused"].includes(phase)) return;
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
      if (recorder) await recorder.stop(elapsed, () => flushMeeting(target.id));
      // 收尾前清掉仍在途的临时（provisional）转写段，避免“转写中…”残留到会后文档。
      dropProvisionalTranscript(target.id);
      await updateMeeting(target.id, (current) => ({
        ...current,
        // 没有活跃录音器却走到停止（防御路径，正常已被恢复逻辑拦下）：
        // 宁可标记“已中断”也不能把无音频产物的会议标成“已完成”。
        status: recorder ? "complete" : "interrupted",
        durationSeconds: elapsed
      }));
      if (recorder) await flushMeeting(target.id);
    } catch (error) {
      setWarning(error instanceof Error ? error.message : "停止录音时发生错误");
    } finally {
      recorderRef.current = null;
      recordingMeetingRef.current = null;
      setRecordingMeetingId(null);
      setPhase("idle");
      publishLevels({ microphone: 0, system: 0 });
    }
  }, [dropProvisionalTranscript, elapsed, flushMeeting, meeting, phase, publishLevels, resolveRecordingMeeting, updateMeeting]);

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (summaryTimerRef.current) window.clearInterval(summaryTimerRef.current);
    if (importSummaryTimerRef.current) window.clearInterval(importSummaryTimerRef.current);
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
      const current = resolveRecordingMeeting();
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
  }, [resolveRecordingMeeting, restartSummaryTimer, updateMeeting]);

  return {
    phase,
    elapsed,
    levels: levelSource,
    queue,
    /** 正在录音的会议（录音中切换选中项后仍指向它），供全局录音入口与错误绑定使用。 */
    recordingMeetingId,
    recordingMeeting: recordingMeeting ?? (recordingMeetingId ? recordingMeetingRef.current ?? undefined : undefined),
    /** 本场录音显式勾选的转写档案 id；undefined = 跟随默认档。 */
    recordingSttProfileId,
    /** 任务开启时勾选转写模型：录音中切换从下一个 8 秒块生效，无需重开录音。 */
    selectSttProfile: setRecordingSttProfileId,
    /** 本场实际使用的转写档案（勾选 > 默认档 > 第一条可用），录音条/准备卡展示用。 */
    activeSttProfile: sttProfile,
    warning,
    transcriptionFailure,
    summaryBusy,
    summaryProgress: summaryBusy ? summaryProgress : null,
    visualSummaryError: visualSummaryFailure?.meetingId === meeting?.id ? visualSummaryFailure?.message : undefined,
    setWarning,
    dismissTranscriptionFailure,
    start,
    pause,
    stop,
    generateSummary,
    refineKeyPoints,
    generateVisualSummary,
    cancelSummary
  };
}
