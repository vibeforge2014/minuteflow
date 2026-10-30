/**
 * 桌面工作台根组件：组装左侧会议库、中央会议文档/播放器、右侧转录面板与底部录音条，
 * 并统一管理各类对话框（新建、设置、导入、付费墙、系统权限、新手引导）与全局 Toast。
 *
 * 所属层：渲染层 UI 编排（组合 store、录音 hook 与 api 事件）。
 * 主要导出：App。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CloudCheck,
  DotsThree,
  Export,
  GearSix,
  LockKey,
  PlayCircle,
  FolderOpen,
  SidebarSimple,
  Star,
  Trash
} from "@phosphor-icons/react";
import { Sidebar } from "./components/Sidebar";
import { DocumentWorkspace } from "./components/DocumentWorkspace";
import { ChatPanel } from "./components/ChatPanel";
import { RecorderBar } from "./components/RecorderBar";
import { RecordingDock } from "./components/RecordingDock";
import { NewMeetingDialog } from "./components/NewMeetingDialog";
import { quickMeetingTitle } from "./lib/format";
import { SettingsDialog, type SettingsFocus, type SettingsTab } from "./components/SettingsDialog";
import { ExportMenu } from "./components/ExportMenu";
import { Toast } from "./components/Toast";
import { EmptyState } from "./components/EmptyState";
import { ConfirmDialog, useConfirmDialog } from "./components/ConfirmDialog";
import { DeletedMeetingsDialog } from "./components/DeletedMeetingsDialog";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { PaywallDialog } from "./components/PaywallDialog";
import { SystemPermissionsDialog } from "./components/SystemPermissionsDialog";
import { ImportDrawer } from "./components/ImportDrawer";
import { MeetingPlayer } from "./components/MeetingPlayer";
import { useMeetingStore } from "./store/meetingStore";
import { useMeetingRecorder } from "./hooks/useMeetingRecorder";
import { useExitPresence } from "./hooks/useExitPresence";
import { api } from "./lib/api";
import type { CreateMeetingInput, ImportCandidate, ImportJob, LicenseStatus, Meeting } from "./types";
import { BrandMark } from "./components/BrandMark";
import { buildRecordingReadiness, deriveWorkspaceStage, isLocalTranscriptionTransport, shouldAutoOpenRightPanel, type WorkspaceStage } from "./lib/workspace";
import { describeImportProcessing, mergeImportJob, mergeImportJobs, selectMeetingImportJob } from "./lib/import-status";
import type { SystemPermissionStatus } from "./types";
import { finishPermissionSetup, shouldOpenPermissionSetup } from "./lib/permissions";

export function App() {
  const forceMacPermissionPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get("permissionPreview") === "mac";
  const {
    meetings,
    selectedId,
    loading,
    saving,
    error,
    profiles,
    preferences,
    initialize,
    refreshMeetings,
    selectMeeting,
    mergeImportedMeeting,
    createMeeting,
    updateMeeting,
    deleteMeeting,
    updatePreferences,
    clearError
  } = useMeetingStore();
  // —— 本地 UI 状态：各类弹层开关、导入队列、播放进度等，不进入 Zustand 全局 store ——
  const [newMeetingOpen, setNewMeetingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 打开设置时的初始页（如更新提示直达「软件更新」）；undefined 表示沿用上次页。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>();
  /** 打开设置时的定位意图：直达本地 Whisper 或在线转写表单，而不是让用户自己找。 */
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus>();
  const [trashOpen, setTrashOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string>();
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 成功提示：可附带一个直达动作（更新提示 → 打开软件更新）。 */
  const [toast, setToast] = useState<{ message: string; action?: { label: string; run: () => void } } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  // 任务列表是否已从主进程回填：回填前无法判断“这场会议是否正在处理”，
  // 重新转录入口必须等它完成，否则页面重载/重挂载时会先闪出一次按钮。
  const [importJobsLoaded, setImportJobsLoaded] = useState(false);
  /** 从导入抽屉去配置模型：关闭设置后回到原流程，而不是让用户重新找入口。 */
  const settingsReturnRef = useRef<"import" | null>(null);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [seekToMs, setSeekToMs] = useState<number | null>(null);
  const [playerAvailable, setPlayerAvailable] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<SystemPermissionStatus | null>(null);
  const [recentlyFinalizedId, setRecentlyFinalizedId] = useState<string | null>(null);
  // 已提示过“导入完成/失败”的任务 id 集合：防止事件订阅重放历史任务时重复弹 Toast。
  const completedImports = useRef(new Set<string>());
  const failedImports = useRef(new Set<string>());
  const previousWorkspaceRef = useRef<{ meetingId: string; stage: WorkspaceStage } | null>(null);
  const autoLayoutKeyRef = useRef("");
  // 重新转录的 IPC 在途标记：双击不会创建第二条任务，也不会弹「已有处理中的任务」。
  const retranscribeRequestRef = useRef(false);
  // 重新转录的应用内确认（替代原生 window.confirm，保持设计系统一致）。
  const retranscribeConfirm = useConfirmDialog();

  /** 统一的提示入口：可附带直达动作（如更新提示一键打开软件更新）。 */
  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    setToast(action ? { message, action } : { message });
  }, []);

  /** 打开设置，可选直达某个标签页与具体配置表单。 */
  const openSettings = useCallback((tab?: SettingsTab, focus?: SettingsFocus) => {
    setSettingsTab(tab);
    setSettingsFocus(focus);
    setSettingsOpen(true);
  }, []);

  /** 打开某场导入生成的会议（Toast 动作与系统通知共用）：必要时先清掉过滤。 */
  const openImportedMeeting = useCallback((meetingId: string) => {
    const store = useMeetingStore.getState();
    if (store.search.trim()) void store.setSearch("");
    store.selectMeeting(meetingId);
    setImportOpen(false);
  }, []);

  // 启动时加载会议/模型/偏好，并拉取一次授权状态（付费墙开关）。
  useEffect(() => {
    initialize();
    api.licensing.getStatus().then(setLicenseStatus).catch(() => setLicenseStatus(null));
  }, [initialize]);

  // 发现新版本：提示附带「打开软件更新」直达按钮，不再要求用户手动找设置入口。
  useEffect(() => api.updates.onAvailable((result) => {
    if (result.update) {
      notify(`发现新版本 ${result.update.version}。`, { label: "打开软件更新", run: () => openSettings("updates") });
    }
  }), [notify, openSettings]);

  // 导入队列：先回填历史任务，再订阅主进程推送的任务更新；任务完成时提示一次并刷新会议列表。
  useEffect(() => {
    api.imports.list().then((jobs) => {
      // 回填与推送可能并发：按 id 合并，避免较旧的列表快照覆盖刚到的任务状态。
      setImportJobs((current) => mergeImportJobs(current, jobs));
      jobs.filter((job) => job.status === "complete").forEach((job) => completedImports.current.add(job.id));
      jobs.filter((job) => job.status === "failed").forEach((job) => failedImports.current.add(job.id));
    }).catch(() => {}).finally(() => setImportJobsLoaded(true));
    return api.imports.onJobUpdated((job) => {
      setImportJobs((current) => mergeImportJob(current, job));
      if (job.status === "complete" && !completedImports.current.has(job.id)) {
        completedImports.current.add(job.id);
        notify(`「${job.title}」的转写与纪要已就绪。`, {
          label: "打开会议",
          run: () => openImportedMeeting(job.meetingId)
        });
        void refreshMeetings();
      }
      if (job.status === "failed") {
        if (!failedImports.current.has(job.id)) {
          failedImports.current.add(job.id);
          notify(`「${job.title}」处理失败：${job.error || "未知原因"}。可打开任务队列重试。`);
        }
      } else {
        // 失败后重试再次失败时仍要提醒，因此离开 failed 就复位一次。
        failedImports.current.delete(job.id);
      }
    });
  }, [notify, openImportedMeeting, refreshMeetings]);

  // 点击系统通知：回到应用并直接打开对应的会议（失败任务会停在文档里的重试入口）。
  useEffect(() => api.imports.onOpenMeeting((meetingId) => {
    if (meetingId) openImportedMeeting(meetingId);
  }), [openImportedMeeting]);

  // 导入分段完成后主进程直接推送会议快照；只合并后台拥有的字段，避免覆盖用户正在写的笔记。
  useEffect(() => api.imports.onMeetingUpdated((updatedMeeting) => {
    mergeImportedMeeting(updatedMeeting);
  }), [mergeImportedMeeting]);

  // 首次运行引导分两道门：先系统权限（版本化流程，v2 会重新弹出），完成后再新手引导。
  // permissionSetupResume 让从系统设置重启的用户无论历史完成状态如何都能回到当前流程。
  useEffect(() => {
    if (!loading && (forceMacPermissionPreview || shouldOpenPermissionSetup(preferences))) setPermissionsOpen(true);
  }, [forceMacPermissionPreview, loading, preferences.permissionSetupResume, preferences.permissionsVersion, preferences.systemPermissionsCompleted]);

  useEffect(() => {
    if (
      !loading
      && !forceMacPermissionPreview
      && !preferences.permissionSetupResume
      && preferences.systemPermissionsCompleted
      && !preferences.onboardingCompleted
    ) setOnboardingOpen(true);
  }, [forceMacPermissionPreview, loading, preferences.onboardingCompleted, preferences.permissionSetupResume, preferences.systemPermissionsCompleted]);

  // 付费功能守卫：已授权直接放行；未授权则记住触发原因并弹出门槛（¥99 一次性购买）对话框。
  // resume 是“买完就该继续做的那一步”：激活成功后由关闭回调接续，不必让用户重走入口。
  const pendingPremiumActionRef = useRef<(() => void) | null>(null);
  const licenseStatusRef = useRef<LicenseStatus | null>(licenseStatus);
  useEffect(() => {
    licenseStatusRef.current = licenseStatus;
  }, [licenseStatus]);
  const requirePremium = (reason: string, resume?: () => void) => {
    if (licenseStatus?.state === "licensed") return true;
    pendingPremiumActionRef.current = resume ?? null;
    setPaywallReason(reason);
    setPaywallOpen(true);
    return false;
  };

  /** 打开导出菜单（付费墙激活后可从这里继续）。 */
  const openExportMenu = useCallback(() => {
    setMoreOpen(false);
    setExportOpen(true);
  }, []);

  /** 继续录音（追加式，笔记/转写/纪要都不丢）：点击即开始，不再弹确认窗。
   * 经 ref 转发最新闭包，回调身份稳定，可安全放进 effect 依赖与 Toast 动作。 */
  const continueRecordingRef = useRef<() => void>(() => {});
  continueRecordingRef.current = () => {
    if (!requirePremium("继续录音、实时转写与自动纪要", () => void recorder.start())) return;
    void recorder.start();
  };
  const continueRecording = useCallback(() => continueRecordingRef.current(), []);

  /** 付费墙关闭：已授权则继续被打断的动作；未购买则丢弃，避免下次误触发。 */
  const handlePaywallClose = useCallback(() => {
    const resume = pendingPremiumActionRef.current;
    pendingPremiumActionRef.current = null;
    setPaywallOpen(false);
    if (resume && licenseStatusRef.current?.state === "licensed") {
      // 等 200ms 的退场动画走完再执行，避免录音条/抽屉与对话框重叠出现。
      window.setTimeout(resume, 220);
    }
  }, []);

  const meeting = useMemo(
    () => meetings.find((item) => item.id === selectedId),
    [meetings, selectedId]
  );
  // 右侧面板退场保持：关闭后保留 240ms 播放收回动画（与 CSS panel-out 时长一致）。
  const panelPresence = useExitPresence(Boolean(rightPanelOpen && meeting), 240);
  // 搜索词与清除入口：区分「没有任何会议」和「搜索无结果」两种空状态。
  const search = useMeetingStore((state) => state.search);
  const setSearch = useMeetingStore((state) => state.setSearch);
  const searching = search.trim().length > 0;
  const meetingImportJob = useMemo(
    () => selectMeetingImportJob(importJobs, meeting?.id),
    [importJobs, meeting?.id]
  );
  useEffect(() => {
    setPlayerOpen(false);
    setPlayerAvailable(false);
    setPlaybackMs(0);
    setSeekToMs(null);
  }, [meeting?.id]);
  // 录音生命周期 hook：传入当前会议，返回 phase/elapsed/levels/queue 等驱动 RecorderBar 的状态。
  const recorder = useMeetingRecorder(meeting);
  // 录音态只属于发起录音的那场会议：切到别的会议时不能把它伪装成「会议进行中」。
  const selectedIsRecording = Boolean(meeting && recorder.recordingMeetingId === meeting.id);
  const selectedRecorderPhase = selectedIsRecording ? recorder.phase : "idle";
  const dockPhase = recorder.phase === "idle" ? null : recorder.phase;
  const recordingElsewhere = Boolean(
    dockPhase && recorder.recordingMeetingId && recorder.recordingMeetingId !== meeting?.id
  );
  const workspaceStage = meeting
    ? meetingImportJob && selectedRecorderPhase === "idle"
      ? "review"
      : deriveWorkspaceStage(meeting.status, selectedRecorderPhase)
    : null;
  const importProcessingStatus = useMemo(
    () => describeImportProcessing(meetingImportJob),
    [meetingImportJob]
  );
  const transcriptionProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "stt" && profile.isDefault)
      || profiles.find((profile) => profile.kind === "stt" && profile.enabled),
    [profiles]
  );
  /** 任务时勾选的转写档案清单（智谱式多可用：全部列出，含默认徽标排序）。 */
  const sttProfiles = useMemo(
    () => [...profiles.filter((profile) => profile.kind === "stt")]
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault))),
    [profiles]
  );
  /** 当前转写是否跑在本机：失败提示据此把「改用本地 Whisper」换成「检查本地模型」。 */
  const transcriptionIsLocal = isLocalTranscriptionTransport(transcriptionProfile?.transport);
  const recordingReadiness = useMemo(() => meeting ? buildRecordingReadiness({
    mode: meeting.mode,
    microphone: permissionStatus?.microphone ?? null,
    transcriptionProfileName: transcriptionProfile?.name
  }) : null, [meeting, permissionStatus?.microphone, transcriptionProfile?.name]);

  // 会前只读取权限状态，不触发系统授权；真正的麦克风请求仍由“开始录音”动作负责。
  const refreshPermissionStatus = useCallback(async () => {
    try {
      setPermissionStatus(await api.system.getPermissions());
    } catch {
      setPermissionStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!meeting || workspaceStage !== "prepare") return;
    void refreshPermissionStatus();
  }, [meeting?.id, refreshPermissionStatus, workspaceStage]);

  // 每次进入一个新阶段只应用一次默认布局；用户随后手动收起侧栏时不会被转写更新重新打开。
  useEffect(() => {
    if (!meeting || !workspaceStage) return;
    const key = `${meeting.id}:${workspaceStage}`;
    if (autoLayoutKeyRef.current === key) return;
    const previous = previousWorkspaceRef.current;
    if (previous?.meetingId === meeting.id && previous.stage === "live" && workspaceStage === "review") {
      setRecentlyFinalizedId(meeting.id);
      // 停止是单步操作，这里给出一键撤销入口：内容已保存，继续录音无缝追加。
      notify("录音已结束，内容已保存。", { label: "继续录音", run: continueRecording });
    } else if (previous?.meetingId !== meeting.id) {
      setRecentlyFinalizedId(null);
    }
    setRightPanelOpen(shouldAutoOpenRightPanel({
      stage: workspaceStage,
      transcriptCount: meeting.transcript.length,
      hasProcessingStatus: Boolean(importProcessingStatus)
    }));
    previousWorkspaceRef.current = { meetingId: meeting.id, stage: workspaceStage };
    autoLayoutKeyRef.current = key;
  }, [continueRecording, importProcessingStatus, meeting?.id, meeting?.transcript.length, notify, workspaceStage]);

  useEffect(() => {
    if (recorder.warning) {
      // Surface license-required errors from the main process as the paywall
      // rather than a generic toast. The code is prefixed in the message
      // because custom Error properties do not survive the contextBridge.
      // 中文补充：主进程的“需要授权”错误以 [LICENSE_REQUIRED] 前缀编码在 message 中，
      // 因为自定义 Error 属性过不了 contextBridge；这里解码后转成付费墙而非普通 Toast。
      if (recorder.warning.startsWith("[LICENSE_REQUIRED]")) {
        setPaywallReason(recorder.warning.replace(/^\[LICENSE_REQUIRED]\s*/, ""));
        setPaywallOpen(true);
        return;
      }
      if (recorder.warning.startsWith("[MICROPHONE_PERMISSION_REQUIRED]")) {
        setPermissionsOpen(true);
        recorder.setWarning(null);
        return;
      }
      const message = recorder.warning;
      // 立即消费 warning（而不是保留字符串）：否则连续两次内容相同的警告
      // 不会重新触发本 effect，第二次提示会被静默吞掉。
      recorder.setWarning(null);
      notify(message);
    }
  }, [recorder.warning]);

  // 首次转写失败时补一个带动作的 Toast：用户可能正停在纪要页，看不到转写视图里的
  // 持久横幅。每个失败周期只在「出现」时提示一次；忽略横幅后 hook 会抑制后续失败回调，
  // 切换转写档案也不会让同一周期重复弹提示。
  const notifiedTranscriptionFailure = useRef(false);
  useEffect(() => {
    const failure = recorder.transcriptionFailure;
    if (!failure) {
      notifiedTranscriptionFailure.current = false;
      return;
    }
    if (notifiedTranscriptionFailure.current) return;
    notifiedTranscriptionFailure.current = true;
    notify("实时转写暂时不可用，录音仍在继续。", {
      label: transcriptionIsLocal ? "检查本地 Whisper" : "改用本地 Whisper",
      run: () => openSettings("transcription", "local-whisper")
    });
  }, [notify, openSettings, recorder.transcriptionFailure, transcriptionIsLocal]);

  // Flush the recorder when the window closes so the last audio chunk is not
  // lost; the main-process before-quit handler is the backstop.
  // 中文补充：窗口关闭前冲刷录音器，确保最后一个音频块落盘；主进程的 before-quit 是兜底。
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (recorder.phase === "recording" || recorder.phase === "paused") {
        event.preventDefault();
        event.returnValue = "";
        void recorder.stop();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [recorder]);

  // 稳定的 Toast 关闭回调：内联箭头函数会随 App 每次重渲染变化，导致 Toast 内部的
  // 自动关闭计时器被反复重置（录音中电平更新让 App 高频重渲染，提示将永远不消失）。
  const dismissToast = useCallback(() => setToast(null), []);

  const handleCreate = async (input: CreateMeetingInput, options?: { startRecording?: boolean }) => {
    const created = await createMeeting(input);
    setNewMeetingOpen(false);
    // 一键开会：对刚创建的会议立即启动录音（先过付费墙；启动仍会做真实麦克风校验）。
    if (options?.startRecording) {
      if (recorder.phase !== "idle") {
        notify(`「${recorder.recordingMeeting?.title ?? "另一场会议"}」正在录音，请先结束当前录音再开始新的。`);
        return created;
      }
      if (requirePremium("录音、实时转写与自动纪要", () => void recorder.start(created))) {
        await recorder.start(created);
      }
    } else {
      notify("会议已创建，可以开始录音。");
    }
    return created;
  };

  /** 免填写的一键开会：自动命名、固定线下麦克风模式（不区分线上线下），创建后立即录音转录。 */
  const handleQuickStart = () => {
    void handleCreate({
      title: quickMeetingTitle(),
      mode: "offline",
      participants: ["我"],
      goals: [],
      tags: []
    }, { startRecording: true });
  };

  // 全局快捷键：⌘K/Ctrl+K 聚焦会议搜索（与搜索框 kbd 提示一致）、⌘N/Ctrl+N 一键开会
  // （免填写直接录音，完整表单仍在侧栏「新建会议」的下拉箭头里）；
  // Esc 依次收起导出/更多菜单与导入抽屉。仅在无输入框抢占的场景下拦截（快捷键本身不冲突输入）。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("meeting-search")?.focus();
        return;
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        handleQuickStart();
        return;
      }
      if (event.key === "Escape") {
        if (moreOpen) { setMoreOpen(false); return; }
        if (exportOpen) { setExportOpen(false); return; }
        if (importOpen) { setImportOpen(false); return; }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exportOpen, importOpen, moreOpen]);

  // 导入入口（文件选择器 / 拖拽）：先过付费墙，再把候选文件交给右侧确认抽屉，确认后才入队归档。
  // 把“过墙”与“真正选文件”拆开，激活成功后可以从选文件这一步继续，而不是再弹一次付费墙。
  const pickImportFiles = async () => {
    const files = await api.imports.choose();
    if (!files.length) return;
    setImportCandidates((current) => [...current, ...files]);
    setImportOpen(true);
  };
  const applyDroppedFiles = async (dropped: File[]) => {
    try {
      const files = await api.imports.fromDropped(dropped);
      setImportCandidates((current) => [...current, ...files]);
      setImportOpen(true);
    } catch (error) { notify(error instanceof Error ? error.message : "无法读取拖入的文件。"); }
  };
  const handleImport = async () => {
    if (!requirePremium("导入录音并自动处理", () => void pickImportFiles())) return;
    await pickImportFiles();
  };

  // 拖拽导入走 IPC 把 File 转成主进程可读的候选描述（浏览器兜底实现则直接读 File 元信息）。
  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer.files);
    if (!dropped.length) return;
    if (!requirePremium("导入录音并自动处理", () => void applyDroppedFiles(dropped))) return;
    await applyDroppedFiles(dropped);
  };

  /**
   * 重试导入任务：失败、取消或等待网络时从持久化断点续跑。
   * 主进程会推送任务更新；这里同时乐观合并返回值，浏览器预览也能立即看到状态。
   */
  const retryImportJob = useCallback(async (id: string) => {
    try {
      const job = await api.imports.retry(id);
      if (job) setImportJobs((current) => [job, ...current.filter((item) => item.id !== id)]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "重试导入任务失败，请稍后再试。");
    }
  }, [notify]);

  /** 暂停导入任务：中止在途转录/说话人分离，已完成的转写内容保留，可随时继续。 */
  const cancelImportJob = useCallback(async (id: string) => {
    try {
      const job = await api.imports.cancel(id);
      if (job) setImportJobs((current) => [job, ...current.filter((item) => item.id !== id)]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "暂停导入任务失败，请稍后再试。");
    }
  }, [notify]);

  /** 跳过说话人识别：转写已经可用时先出纪要，不再等待长耗时的分离。 */
  const skipImportDiarizationJob = useCallback(async (id: string) => {
    try {
      const job = await api.imports.skipDiarization(id);
      if (job) setImportJobs((current) => [job, ...current.filter((item) => item.id !== id)]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "跳过发言人识别失败，请稍后再试。");
    }
  }, [notify]);

  /**
   * 重新转录当前会议：清空旧逐字稿，用已归档录音重跑转写/识别/纪要。
   * 典型场景是录音时在线转写不可用，会后换本地 Whisper 补跑整场；
   * 无归档录音、正在录音或已有任务在处理时，主进程会给出可读的错误原因。
   */
  const handleRetranscribe = async () => {
    const target = meeting;
    if (!target) return;
    if (recorder.phase !== "idle" && recorder.recordingMeetingId === target.id) {
      notify("这场会议正在录音，请先结束后再重新转录。");
      return;
    }
    if (!requirePremium("重新转录会议录音", () => void handleRetranscribe())) return;
    if (target.transcript.length > 0 && !(await retranscribeConfirm.confirm({
      title: "重新转录这场会议？",
      body: "会清空当前逐字稿，从已归档的录音重新识别并生成纪要；你的笔记和手动锁定的纪要内容会保留。",
      confirmLabel: "重新转录"
    }))) return;
    if (retranscribeRequestRef.current) return;
    retranscribeRequestRef.current = true;
    try {
      const job = await api.imports.retranscribe(target.id);
      // 立刻按返回的任务快照抬高「处理中」状态：不等推送到达，按钮就不会在启动瞬间闪回。
      setImportJobs((current) => mergeImportJob(current, job));
      setImportOpen(true);
    } catch (error) {
      notify((error instanceof Error ? error.message : "无法开始重新转录。").replace(/^Error invoking remote method '[^']+':\s*/, ""));
    } finally {
      retranscribeRequestRef.current = false;
    }
  };

  // 会议文档统一变更入口：整份替换，由 store 负责乐观更新 + 持久化。
  const handleMeetingChange = (next: Meeting) => {
    updateMeeting(next.id, () => next);
  };

  // 侧栏行内星标：切换收藏（收藏项固定在会议库顶部）。
  const handleToggleFavorite = useCallback((id: string) => {
    void updateMeeting(id, (current) => ({ ...current, favorite: !current.favorite }));
  }, [updateMeeting]);

  // 侧栏行内删除：软删除移入最近删除，可在「最近删除」中恢复。
  const handleDeleteMeeting = useCallback(async (id: string) => {
    try {
      await deleteMeeting(id);
      notify("会议已移到最近删除，可在最近删除中恢复。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除会议失败，请稍后重试。");
    }
  }, [deleteMeeting, notify]);

  // 首次加载且尚无可选会议时展示全屏 loading，避免闪烁空状态。
  if (loading && !meeting) {
    return (
      <div className="app-loading">
        <BrandMark className="app-loading__mark" size={42} />
        <p>正在打开MinuteFlow…</p>
      </div>
    );
  }

  // 无会议时逐字稿侧栏不可能渲染，也不预留它的栅格列——否则右侧留出的空白列
  // 会让空状态引导在视觉上偏离居中。
  return (
      <div
        className={`app-shell ${meeting ? "app-shell--document" : ""} ${rightPanelOpen && meeting ? "app-shell--right-open" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <Sidebar
        meetings={meetings}
        selectedId={selectedId}
        onSelect={selectMeeting}
        onQuickStart={handleQuickStart}
        onNew={() => setNewMeetingOpen(true)}
        onImport={handleImport}
        importCount={importJobs.filter((job) => !["complete", "cancelled", "failed"].includes(job.status)).length}
        importIssueCount={importJobs.filter((job) => job.status === "failed").length}
        onToggleFavorite={handleToggleFavorite}
        onDeleteMeeting={handleDeleteMeeting}
        onTrash={() => setTrashOpen(true)}
        onSettings={() => openSettings()}
      />

      <main className={`main-pane ${workspaceStage ? `main-pane--${workspaceStage}` : ""}`}>
        {meeting ? (
          <>
            <header className={`document-header document-header--${workspaceStage}`}>
              <div className="document-header__title">
                <div className="document-header__heading">
                  <input
                    aria-label="会议标题"
                    value={meeting.title}
                    onChange={(event) => handleMeetingChange({ ...meeting, title: event.target.value })}
                  />
                  <span className={`workspace-stage workspace-stage--${workspaceStage}`}>
                    {workspaceStage === "prepare" ? "会前准备" : workspaceStage === "live" ? "会议进行中" : "会后整理"}
                  </span>
                </div>
                <button
                  className={`icon-button ${meeting.favorite ? "is-active" : ""}`}
                  aria-label={meeting.favorite ? "取消收藏" : "收藏"}
                  aria-pressed={meeting.favorite}
                  title={meeting.favorite ? "取消收藏" : "收藏，固定在会议库顶部"}
                  onClick={() => handleMeetingChange({ ...meeting, favorite: !meeting.favorite })}
                >
                  <Star size={18} weight={meeting.favorite ? "fill" : "regular"} />
                </button>
              </div>
              <div className="document-header__actions">
                <span className="save-state">
                  <span className="save-state__content content-status-enter" key={saving ? "saving" : "saved"}>
                    {saving ? <ArrowClockwise size={16} className="spin" /> : <CloudCheck size={17} />}
                    {saving ? "正在保存" : "已保存到本机"}
                  </span>
                </span>
                {playerAvailable && (
                  <button
                    className={`button button--secondary button--small playback-trigger ${playerOpen ? "is-active" : ""}`}
                    aria-pressed={playerOpen}
                    title={playerOpen ? "收起录音回放" : "展开录音回放"}
                    onClick={() => setPlayerOpen((value) => !value)}
                  >
                    <PlayCircle size={16} weight={playerOpen ? "fill" : "regular"} />回放
                  </button>
                )}
                <div className="export-wrap">
                  <button className="button button--primary button--small" aria-expanded={exportOpen} onClick={() => {
                    if (requirePremium("导出会议文档与完整备份", openExportMenu)) openExportMenu();
                  }}>
                    <Export size={16} /> 导出
                  </button>
                  {exportOpen && (
                    <ExportMenu
                      meeting={meeting}
                      onClose={() => setExportOpen(false)}
                      onDone={(message) => notify(message)}
                    />
                  )}
                </div>
                <div className="export-wrap">
                  <button
                    className="icon-button"
                    aria-label="更多选项"
                    aria-expanded={moreOpen}
                    title="更多会议操作"
                    onClick={() => {
                      setExportOpen(false);
                      setMoreOpen((value) => !value);
                    }}
                  >
                    <DotsThree size={22} weight="bold" />
                  </button>
                  {moreOpen && (
                    <div className="more-menu">
                      <button onClick={async () => {
                        try {
                          await api.recordings.open(meeting.id);
                        } catch (error) {
                          notify(error instanceof Error ? error.message : "无法打开录音位置。");
                        }
                        setMoreOpen(false);
                      }}>
                        <FolderOpen size={16} />打开录音文件夹
                      </button>
                      <button onClick={() => {
                        handleMeetingChange({ ...meeting, favorite: !meeting.favorite });
                        setMoreOpen(false);
                      }}>
                        <Star size={16} weight={meeting.favorite ? "fill" : "regular"} />
                        {meeting.favorite ? "取消收藏" : "添加到收藏"}
                      </button>
                      {workspaceStage === "review" && (
                        <button onClick={() => {
                          setMoreOpen(false);
                          continueRecording();
                        }}>
                          <PlayCircle size={16} />继续录音
                        </button>
                      )}
                        <button className="is-danger" onClick={() => {
                          setMoreOpen(false);
                          void handleDeleteMeeting(meeting.id);
                        }}>
                        <Trash size={16} />移到最近删除
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className={`icon-button ${rightPanelOpen ? "is-active" : ""}`}
                  aria-label={rightPanelOpen ? "关闭 AI 问答侧栏" : "打开 AI 问答侧栏"}
                  aria-pressed={rightPanelOpen}
                  title={rightPanelOpen ? "关闭 AI 问答侧栏" : "围绕这场会议向 AI 提问"}
                  onClick={() => setRightPanelOpen((value) => !value)}
                >
                  <SidebarSimple size={19} />
                </button>
              </div>
            </header>

            <MeetingPlayer
              key={`${meeting.id}:${meetingImportJob?.audioAssetId || "pending"}`}
              meetingId={meeting.id}
              durationSeconds={meeting.durationSeconds}
              seekToMs={seekToMs}
              open={playerOpen}
              onClose={() => {
                // 收起播放器时同步清除回放高亮位置，转写视图不再指向已停止的播放点。
                setPlayerOpen(false);
                setPlaybackMs(0);
              }}
              onAvailabilityChange={setPlayerAvailable}
              onTimeChange={setPlaybackMs}
              onError={notify}
            />

            <DocumentWorkspace
              meeting={meeting}
              stage={workspaceStage!}
              readiness={recordingReadiness!}
              elapsed={recorder.elapsed}
              recentlyFinalized={recentlyFinalizedId === meeting.id}
              processingStatus={importProcessingStatus}
              importJob={meetingImportJob}
              onRetryImport={(id) => void retryImportJob(id)}
              onCancelImport={(id) => void cancelImportJob(id)}
              onSkipDiarization={(id) => void skipImportDiarizationJob(id)}
              onRetranscribe={importJobsLoaded ? () => void handleRetranscribe() : undefined}
              playbackMs={playbackMs}
              onSeek={(ms) => {
                // 没有可用音频（未录制/文件缺失）时不打开播放器，避免出现一个必然报错的空播放器。
                if (!playerAvailable) {
                  notify("这场会议没有可回放的音频文件；转录时间戳仍可作为内容定位使用。");
                  return;
                }
                setPlayerOpen(true);
                setSeekToMs(null);
                requestAnimationFrame(() => setSeekToMs(ms));
              }}
              emptyActionLabel={workspaceStage === "review" ? "继续录音" : undefined}
              onEmptyAction={workspaceStage === "review" ? continueRecording : undefined}
              onChange={handleMeetingChange}
              onStartRecording={async () => {
                if (recorder.phase !== "idle") {
                  notify(`「${recorder.recordingMeeting?.title ?? "另一场会议"}」正在录音，请先结束当前录音。`);
                  return;
                }
                if (!requirePremium("录音、实时转写与自动纪要", () => void recorder.start())) return;
                await recorder.start();
              }}
              onConfigureTranscription={() => openSettings("transcription")}
              transcriptionFailure={selectedIsRecording ? recorder.transcriptionFailure : null}
              transcriptionIsLocal={transcriptionIsLocal}
              onUseLocalWhisper={() => openSettings("transcription", "local-whisper")}
              onChooseTranscriptionService={() => openSettings("transcription", "online-transcription")}
              onDismissTranscriptionFailure={recorder.dismissTranscriptionFailure}
              onOpenPermissions={() => setPermissionsOpen(true)}
              onGenerateSummary={() => {
                // final 由 hook 按会议状态自动推导：录音/暂停中为滚动增量，会后为终稿总结。
                if (requirePremium("生成 AI 会议纪要", () => void recorder.generateSummary())) void recorder.generateSummary();
              }}
              onCancelSummary={() => void recorder.cancelSummary()}
              onRetryVisualSummary={() => {
                if (requirePremium("生成视觉会议纪要", () => void recorder.generateVisualSummary())) void recorder.generateVisualSummary();
              }}
              summaryBusy={recorder.summaryBusy}
            />

            {workspaceStage === "live" && (
              <RecorderBar
                meeting={meeting}
                phase={recorder.phase}
                elapsed={recorder.elapsed}
                levels={recorder.levels}
                queue={recorder.queue}
                transcriptionReady={recordingReadiness?.hasTranscription ?? false}
                sttProfiles={sttProfiles}
                activeSttProfileId={recorder.activeSttProfile?.id}
                activeSttProfileName={recorder.activeSttProfile?.name}
                onSelectSttProfile={(profileId) => recorder.selectSttProfile(profileId)}
                onManageTranscription={() => openSettings("transcription")}
                transcriptionFailed={Boolean(recorder.transcriptionFailure)}
                onFixTranscription={() => openSettings("transcription", "local-whisper")}
                onStart={async () => {
                  if (!requirePremium("录音、实时转写与自动纪要", () => void recorder.start())) return;
                  await recorder.start();
                }}
                onPause={recorder.pause}
                onStop={recorder.stop}
                onMark={() => {
                  const time = formatDuration(recorder.elapsed);
                  const marker = `[${time}] 重点标记`;
                  handleMeetingChange({
                    ...meeting,
                    notes: [...meeting.notes, marker],
                    notesMarkdown: [meeting.notesMarkdown || meeting.notes.join("\n\n"), marker].filter(Boolean).join("\n\n")
                  });
                  notify(`已在 ${time} 添加重点标记。`);
                }}
              />
            )}
          </>
        ) : searching ? (
          <EmptyState
            variant="search"
            onClear={() => void setSearch("")}
          />
        ) : (
          <EmptyState onNew={handleQuickStart} onTemplate={() => setNewMeetingOpen(true)} onImport={handleImport} />
        )}
      </main>

      {/* 录音中切到别的会议：保持录音可见可停，点「回到录音」跳回原会议。 */}
      {recordingElsewhere && dockPhase && recorder.recordingMeeting && (
        <RecordingDock
          title={recorder.recordingMeeting.title}
          phase={dockPhase}
          elapsed={recorder.elapsed}
          onOpen={() => {
            if (searching) void setSearch("");
            selectMeeting(recorder.recordingMeeting!.id);
          }}
          onPause={() => void recorder.pause()}
          onStop={() => void recorder.stop()}
        />
      )}

      {/* 菜单遮罩：导出/更多菜单打开时拦截外部点击，点任意空白处即收起菜单。 */}
      {(exportOpen || moreOpen) && (
        <div
          className="menu-scrim"
          aria-hidden="true"
          onClick={() => {
            setExportOpen(false);
            setMoreOpen(false);
          }}
        />
      )}

      {meeting && panelPresence.mounted && (
        <ChatPanel
          meeting={meeting}
          closing={panelPresence.closing}
          onClose={() => setRightPanelOpen(false)}
          onOpenSettings={() => openSettings("llm")}
        />
      )}

      <NewMeetingDialog
        open={newMeetingOpen}
        onClose={() => setNewMeetingOpen(false)}
        onCreate={handleCreate}
      />
      <SettingsDialog open={settingsOpen} initialTab={settingsTab} initialFocus={settingsFocus} licenseStatus={licenseStatus} onLicenseStatusChange={setLicenseStatus} recordingActive={recorder.phase !== "idle"} onClose={() => {
        setSettingsOpen(false);
        // 首次配置期间从设置返回时继续留在向导当前步骤，不提前写入完成标记。
        if (!preferences.onboardingCompleted) setOnboardingOpen(true);
        // 从导入抽屉进入设置：保存/关闭后回到抽屉，候选文件与任务队列都还在。
        if (settingsReturnRef.current === "import") {
          settingsReturnRef.current = null;
          setImportOpen(true);
        }
      }} />
      <DeletedMeetingsDialog
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={initialize}
      />
      <ConfirmDialog open={retranscribeConfirm.open} request={retranscribeConfirm.request} onSettle={retranscribeConfirm.settle} />
      <OnboardingDialog
        open={onboardingOpen && !settingsOpen}
        profiles={profiles}
        onComplete={async () => {
          await updatePreferences({ ...preferences, onboardingCompleted: true });
          setOnboardingOpen(false);
        }}
        onConfigureModels={(tab, focus) => {
          setOnboardingOpen(false);
          openSettings(tab, focus);
        }}
      />
      <SystemPermissionsDialog
        open={permissionsOpen}
        returningUser={preferences.permissionSetupResume || (preferences.systemPermissionsCompleted && preferences.permissionsVersion < 2)}
        onComplete={async () => {
          await updatePreferences(finishPermissionSetup(preferences));
          setPermissionsOpen(false);
          void refreshPermissionStatus();
        }}
        onSkip={async () => {
          // 跳过首run权限墙：只记录“已走完该流程”，不动系统权限。
          // 之后用户第一次点“开始录音”时会按需引导授权（含被拒绝时重新打开本对话框）。
          await updatePreferences(finishPermissionSetup(preferences));
          setPermissionsOpen(false);
          notify("已跳过授权。首次开始录音时会再引导你完成麦克风授权。");
        }}
      />
      <PaywallDialog
        open={paywallOpen}
        reason={paywallReason}
        status={licenseStatus}
        onStatusChange={setLicenseStatus}
        onClose={handlePaywallClose}
      />
      <ImportDrawer
        open={importOpen}
        candidates={importCandidates}
        jobs={importJobs}
        profiles={profiles}
        onClose={() => setImportOpen(false)}
        onPick={handleImport}
        onChange={setImportCandidates}
        onEnqueue={async (items, options) => {
          const jobs = await api.imports.enqueue(items, options);
          setImportJobs((current) => [...jobs, ...current.filter((item) => !jobs.some((job) => job.id === item.id))]);
          setImportCandidates([]);
          await refreshMeetings();
          if (jobs[0]?.meetingId) selectMeeting(jobs[0].meetingId);
          setImportOpen(false);
          // 转写进度现在在中央列「转写」视图：选中会议后按 live 阶段默认展示，无需再动右栏。
          notify(`${jobs.length} 个录音已归档并加入后台队列。`);
        }}
        onRetry={(id) => void retryImportJob(id)}
        onCancel={(id) => void cancelImportJob(id)}
        onSkipDiarization={(id) => void skipImportDiarizationJob(id)}
        onRemove={async (id) => {
          try {
            await api.imports.remove(id);
            setImportJobs((current) => current.filter((job) => job.id !== id));
          } catch (error) {
            notify(error instanceof Error ? error.message : "删除任务失败，请稍后重试。");
          }
        }}
        onOpenMeeting={(id) => { selectMeeting(id); setImportOpen(false); }}
        onConfigure={() => {
          settingsReturnRef.current = "import";
          setImportOpen(false);
          openSettings();
        }}
      />

      {/* 错误与操作反馈分成两条独立 Toast 叠放：store 错误（警告样式）不再吞掉
          导入/导出等成功提示，反之亦然。 */}
      {(error || toast) && (
        <div className="toast-stack">
          {error && <Toast tone="warning" message={error} onClose={clearError} />}
          {toast && <Toast message={toast.message} action={toast.action ? { label: toast.action.label, run: toast.action.run } : undefined} onClose={dismissToast} />}
        </div>
      )}

      <button
        className="floating-settings"
        aria-label="打开设置"
        onClick={() => openSettings()}
      >
        <GearSix size={19} />
      </button>
      {licenseStatus?.state !== "licensed" && (
        <button className="floating-unlock" onClick={() => { setPaywallReason("解锁完整工作流"); setPaywallOpen(true); }}>
          <LockKey size={16} /> 解锁 MinuteFlow
        </button>
      )}
    </div>
  );
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}
