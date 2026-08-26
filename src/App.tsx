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
import { TranscriptPanel } from "./components/TranscriptPanel";
import { RecorderBar } from "./components/RecorderBar";
import { NewMeetingDialog } from "./components/NewMeetingDialog";
import { SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { ExportMenu } from "./components/ExportMenu";
import { Toast } from "./components/Toast";
import { EmptyState } from "./components/EmptyState";
import { DeletedMeetingsDialog } from "./components/DeletedMeetingsDialog";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { PaywallDialog } from "./components/PaywallDialog";
import { SystemPermissionsDialog } from "./components/SystemPermissionsDialog";
import { ImportDrawer } from "./components/ImportDrawer";
import { MeetingPlayer } from "./components/MeetingPlayer";
import { useMeetingStore } from "./store/meetingStore";
import { useMeetingRecorder } from "./hooks/useMeetingRecorder";
import { api } from "./lib/api";
import type { CreateMeetingInput, ImportCandidate, ImportJob, LicenseStatus, Meeting } from "./types";
import { BrandMark } from "./components/BrandMark";
import { buildRecordingReadiness, deriveWorkspaceStage, shouldAutoOpenRightPanel, type WorkspaceStage } from "./lib/workspace";
import type { SystemPermissionStatus } from "./types";

export function App() {
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
  const [trashOpen, setTrashOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string>();
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<"transcript" | "summary">("transcript");
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 成功提示：可附带一个直达动作（更新提示 → 打开软件更新）。 */
  const [toast, setToast] = useState<{ message: string; action?: { label: string; run: () => void } } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [seekToMs, setSeekToMs] = useState<number | null>(null);
  const [playerAvailable, setPlayerAvailable] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<SystemPermissionStatus | null>(null);
  const [continueRecordingOpen, setContinueRecordingOpen] = useState(false);
  const [recentlyFinalizedId, setRecentlyFinalizedId] = useState<string | null>(null);
  // 已提示过“导入完成”的任务 id 集合：防止事件订阅重放历史任务时重复弹 Toast。
  const completedImports = useRef(new Set<string>());
  const previousWorkspaceRef = useRef<{ meetingId: string; stage: WorkspaceStage } | null>(null);
  const autoLayoutKeyRef = useRef("");

  /** 统一的提示入口：可附带直达动作（如更新提示一键打开软件更新）。 */
  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    setToast(action ? { message, action } : { message });
  }, []);

  /** 打开设置，可选直达某个标签页。 */
  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
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
      setImportJobs(jobs);
      jobs.filter((job) => job.status === "complete").forEach((job) => completedImports.current.add(job.id));
    }).catch(() => {});
    return api.imports.onJobUpdated((job) => {
      setImportJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      if (job.status === "complete" && !completedImports.current.has(job.id)) {
        completedImports.current.add(job.id);
        notify(`“${job.title}”已完成导入，可从左侧「导入录音」打开它，或直接在会议库中查看。`);
        void refreshMeetings();
      }
    });
  }, [refreshMeetings]);

  // 导入分段完成后主进程直接推送会议快照；只合并后台拥有的字段，避免覆盖用户正在写的笔记。
  useEffect(() => api.imports.onMeetingUpdated((updatedMeeting) => {
    mergeImportedMeeting(updatedMeeting);
  }), [mergeImportedMeeting]);

  // 首次运行引导分两道门：先系统权限（版本化流程，v2 会重新弹出），完成后再新手引导。
  useEffect(() => {
    if (!loading && (!preferences.systemPermissionsCompleted || preferences.permissionsVersion < 2)) setPermissionsOpen(true);
  }, [loading, preferences.permissionsVersion, preferences.systemPermissionsCompleted]);

  useEffect(() => {
    if (!loading && preferences.systemPermissionsCompleted && !preferences.onboardingCompleted) setOnboardingOpen(true);
  }, [loading, preferences.onboardingCompleted, preferences.systemPermissionsCompleted]);

  // 付费功能守卫：已授权直接放行；未授权则记住触发原因并弹出门槛（¥99 一次性购买）对话框。
  const requirePremium = (reason: string) => {
    if (licenseStatus?.state === "licensed") return true;
    setPaywallReason(reason);
    setPaywallOpen(true);
    return false;
  };

  const meeting = useMemo(
    () => meetings.find((item) => item.id === selectedId),
    [meetings, selectedId]
  );
  // 搜索词与清除入口：区分「没有任何会议」和「搜索无结果」两种空状态。
  const search = useMeetingStore((state) => state.search);
  const setSearch = useMeetingStore((state) => state.setSearch);
  const searching = search.trim().length > 0;
  const meetingImportJob = useMemo(
    () => meeting ? importJobs.find((job) => job.meetingId === meeting.id) : undefined,
    [importJobs, meeting]
  );
  useEffect(() => {
    setPlayerOpen(false);
    setPlayerAvailable(false);
    setPlaybackMs(0);
    setSeekToMs(null);
  }, [meeting?.id]);
  // 录音生命周期 hook：传入当前会议，返回 phase/elapsed/levels/queue 等驱动 RecorderBar 的状态。
  const recorder = useMeetingRecorder(meeting);
  const workspaceStage = meeting
    ? meetingImportJob && recorder.phase === "idle"
      ? "review"
      : deriveWorkspaceStage(meeting.status, recorder.phase)
    : null;
  const importProcessingStatus = useMemo(
    () => describeImportProcessing(meetingImportJob),
    [meetingImportJob]
  );
  const transcriptionProfile = useMemo(
    () => profiles.find((profile) => profile.kind === "stt" && profile.enabled),
    [profiles]
  );
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
    } else if (previous?.meetingId !== meeting.id) {
      setRecentlyFinalizedId(null);
    }
    setRightPanelOpen(shouldAutoOpenRightPanel({
      stage: workspaceStage,
      transcriptCount: meeting.transcript.length,
      hasProcessingStatus: Boolean(importProcessingStatus)
    }));
    if (workspaceStage !== "prepare") {
      setRightPanelTab("transcript");
    }
    previousWorkspaceRef.current = { meetingId: meeting.id, stage: workspaceStage };
    autoLayoutKeyRef.current = key;
  }, [importProcessingStatus, meeting?.id, workspaceStage]);

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
      if (requirePremium("录音、实时转写与自动纪要")) void recorder.start(created);
    } else {
      notify("会议已创建，可以开始录音。");
    }
    return created;
  };

  // 全局快捷键：⌘K/Ctrl+K 聚焦会议搜索（与搜索框 kbd 提示一致）、⌘N/Ctrl+N 新建会议；
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
        setNewMeetingOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (continueRecordingOpen) { setContinueRecordingOpen(false); return; }
        if (moreOpen) { setMoreOpen(false); return; }
        if (exportOpen) { setExportOpen(false); return; }
        if (importOpen) { setImportOpen(false); return; }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [continueRecordingOpen, exportOpen, importOpen, moreOpen]);

  // 导入入口（文件选择器 / 拖拽）：先过付费墙，再把候选文件交给右侧确认抽屉，确认后才入队归档。
  const handleImport = async () => {
    if (!requirePremium("导入录音并自动处理")) return;
    const files = await api.imports.choose();
    if (!files.length) return;
    setImportCandidates((current) => [...current, ...files]);
    setImportOpen(true);
  };

  // 拖拽导入走 IPC 把 File 转成主进程可读的候选描述（浏览器兜底实现则直接读 File 元信息）。
  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    if (!event.dataTransfer.files.length || !requirePremium("导入录音并自动处理")) return;
    try {
      const files = await api.imports.fromDropped(Array.from(event.dataTransfer.files));
      setImportCandidates((current) => [...current, ...files]);
      setImportOpen(true);
    } catch (error) { notify(error instanceof Error ? error.message : "无法读取拖入的文件。"); }
  };

  // 会议文档统一变更入口：整份替换，由 store 负责乐观更新 + 持久化。
  const handleMeetingChange = (next: Meeting) => {
    updateMeeting(next.id, () => next);
  };

  // 侧栏行内星标：切换收藏（收藏项固定在会议库顶部）。
  const handleToggleFavorite = useCallback((id: string) => {
    void updateMeeting(id, (current) => ({ ...current, favorite: !current.favorite }));
  }, [updateMeeting]);

  // 首次加载且尚无可选会议时展示全屏 loading，避免闪烁空状态。
  if (loading && !meeting) {
    return (
      <div className="app-loading">
        <BrandMark className="app-loading__mark" size={42} />
        <p>正在打开MinuteFlow…</p>
      </div>
    );
  }

  return (
    <div
      className={`app-shell ${rightPanelOpen ? "app-shell--right-open" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <Sidebar
        meetings={meetings}
        selectedId={selectedId}
        onSelect={selectMeeting}
        onNew={() => setNewMeetingOpen(true)}
        onImport={handleImport}
        importCount={importJobs.filter((job) => !["complete", "cancelled", "failed"].includes(job.status)).length}
        onToggleFavorite={handleToggleFavorite}
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
                  onClick={() => handleMeetingChange({ ...meeting, favorite: !meeting.favorite })}
                >
                  <Star size={18} weight={meeting.favorite ? "fill" : "regular"} />
                </button>
              </div>
              <div className="document-header__actions">
                <span className="save-state">
                  {saving ? <ArrowClockwise size={16} className="spin" /> : <CloudCheck size={17} />}
                  {saving ? "正在保存" : "已自动保存"}
                </span>
                {playerAvailable && (
                  <button
                    className={`button button--secondary button--small playback-trigger ${playerOpen ? "is-active" : ""}`}
                    onClick={() => setPlayerOpen((value) => !value)}
                  >
                    <PlayCircle size={16} weight={playerOpen ? "fill" : "regular"} />回放
                  </button>
                )}
                <div className="export-wrap">
                  <button className="button button--primary button--small" onClick={() => {
                    if (requirePremium("导出会议文档与完整备份")) {
                      setMoreOpen(false);
                      setExportOpen((value) => !value);
                    }
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
                          setContinueRecordingOpen(true);
                        }}>
                          <PlayCircle size={16} />继续录音
                        </button>
                      )}
                      <button className="is-danger" onClick={async () => {
                        await deleteMeeting(meeting.id);
                        setMoreOpen(false);
                        notify("会议已移到最近删除，可在会议库中恢复。");
                      }}>
                        <Trash size={16} />移到最近删除
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className={`icon-button ${rightPanelOpen ? "is-active" : ""}`}
                  aria-label="显示或隐藏转录面板"
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
              onClose={() => setPlayerOpen(false)}
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
              onChange={handleMeetingChange}
              onStartRecording={async () => {
                if (requirePremium("录音、实时转写与自动纪要")) await recorder.start();
              }}
              onConfigureTranscription={() => openSettings("transcription")}
              onOpenPermissions={() => setPermissionsOpen(true)}
              onGenerateSummary={() => {
                // final 由 hook 按会议状态自动推导：录音/暂停中为滚动增量，会后为终稿总结。
                if (requirePremium("生成 AI 会议纪要")) void recorder.generateSummary();
              }}
              onCancelSummary={() => void recorder.cancelSummary()}
              onRetryVisualSummary={() => {
                if (requirePremium("生成视觉会议纪要")) void recorder.generateVisualSummary();
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
                onStart={async () => {
                  if (requirePremium("录音、实时转写与自动纪要")) await recorder.start();
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
          <EmptyState onNew={() => setNewMeetingOpen(true)} onImport={handleImport} />
        )}
      </main>

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

      {meeting && rightPanelOpen && (
        <TranscriptPanel
          meeting={meeting}
          importJob={meetingImportJob}
          stage={workspaceStage!}
          tab={rightPanelTab}
          onTabChange={setRightPanelTab}
          onChange={handleMeetingChange}
          onClose={() => setRightPanelOpen(false)}
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
        />
      )}

      <NewMeetingDialog
        open={newMeetingOpen}
        onClose={() => setNewMeetingOpen(false)}
        onCreate={handleCreate}
      />
      <SettingsDialog open={settingsOpen} initialTab={settingsTab} onClose={() => {
        setSettingsOpen(false);
        // 首次配置期间从设置返回时继续留在向导当前步骤，不提前写入完成标记。
        if (!preferences.onboardingCompleted) setOnboardingOpen(true);
      }} />
      <DeletedMeetingsDialog
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={initialize}
      />
      <OnboardingDialog
        open={onboardingOpen && !settingsOpen}
        profiles={profiles}
        onComplete={async () => {
          await updatePreferences({ ...preferences, onboardingCompleted: true });
          setOnboardingOpen(false);
        }}
        onConfigureModels={(tab) => {
          setOnboardingOpen(false);
          openSettings(tab);
        }}
      />
      <SystemPermissionsDialog
        open={permissionsOpen}
        returningUser={preferences.systemPermissionsCompleted && preferences.permissionsVersion < 2}
        onComplete={async () => {
          await updatePreferences({ ...preferences, systemPermissionsCompleted: true, permissionsVersion: 2 });
          setPermissionsOpen(false);
          void refreshPermissionStatus();
        }}
        onSkip={async () => {
          // 跳过首run权限墙：只记录“已走完该流程”，不动系统权限。
          // 之后用户第一次点“开始录音”时会按需引导授权（含被拒绝时重新打开本对话框）。
          await updatePreferences({ ...preferences, systemPermissionsCompleted: true, permissionsVersion: 2 });
          setPermissionsOpen(false);
          notify("已跳过授权。首次开始录音时会再引导你完成麦克风授权。");
        }}
      />
      {meeting && continueRecordingOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setContinueRecordingOpen(false)}>
          <section className="dialog continue-recording-dialog" role="dialog" aria-modal="true" aria-labelledby="continue-recording-title">
            <header>
              <div>
                <h2 id="continue-recording-title">继续这场会议的录音？</h2>
                <p>新的声音会追加到当前会议；已有笔记、转写和纪要不会被清空。</p>
              </div>
            </header>
            <div className="continue-recording-dialog__body">
              <PlayCircle size={24} weight="duotone" />
              <span>录音开始后，工作区会重新进入会中模式。</span>
            </div>
            <footer>
              <button className="button" onClick={() => setContinueRecordingOpen(false)}>取消</button>
              <button className="button button--primary" onClick={async () => {
                setContinueRecordingOpen(false);
                if (requirePremium("继续录音、实时转写与自动纪要")) await recorder.start();
              }}>
                继续录音
              </button>
            </footer>
          </section>
        </div>
      )}
      <PaywallDialog
        open={paywallOpen}
        reason={paywallReason}
        status={licenseStatus}
        onStatusChange={setLicenseStatus}
        onClose={() => setPaywallOpen(false)}
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
          setRightPanelOpen(true);
          setRightPanelTab("transcript");
          notify(`${jobs.length} 个录音已归档并加入后台队列。`);
        }}
        onRetry={(id) => void api.imports.retry(id)}
        onCancel={(id) => void api.imports.cancel(id)}
        onOpenMeeting={(id) => { selectMeeting(id); setImportOpen(false); }}
        onConfigure={() => { setImportOpen(false); openSettings(); }}
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

function describeImportProcessing(job: ImportJob | undefined) {
  if (!job || job.status === "complete" || job.status === "cancelled") return undefined;
  if (job.status === "failed") return "录音处理已暂停，可在导入队列中重试";
  if (job.status === "waiting_for_model") return "录音已归档，等待配置转写模型";
  if (job.status === "waiting_for_audio_tool") return "录音已归档，等待音频组件恢复";
  if (job.status === "transcribing" || job.stage === "transcribing") {
    return job.totalChunks
      ? `正在转写第 ${Math.min((job.completedChunks || 0) + 1, job.totalChunks)}/${job.totalChunks} 段`
      : "正在生成第一段转写";
  }
  if (job.status === "diarizing") return "转写完成，正在识别发言人";
  if (job.status === "summarizing") return "转写完成，正在整理会议纪要";
  if (job.status === "copying" || job.stage === "copying") return "正在安全归档录音";
  return "录音已加入处理队列";
}
