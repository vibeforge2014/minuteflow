import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CloudCheck,
  DotsThree,
  Export,
  GearSix,
  LockKey,
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
import { SettingsDialog } from "./components/SettingsDialog";
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
    createMeeting,
    updateMeeting,
    deleteMeeting,
    updatePreferences,
    clearError
  } = useMeetingStore();
  const [newMeetingOpen, setNewMeetingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string>();
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [seekToMs, setSeekToMs] = useState<number | null>(null);
  const completedImports = useRef(new Set<string>());

  useEffect(() => {
    initialize();
    api.licensing.getStatus().then(setLicenseStatus).catch(() => setLicenseStatus(null));
  }, [initialize]);

  useEffect(() => api.updates.onAvailable((result) => {
    if (result.update) {
      setToast(`发现新版本 ${result.update.version}，可前往“设置 → 软件更新”下载。`);
    }
  }), []);

  useEffect(() => {
    api.imports.list().then((jobs) => {
      setImportJobs(jobs);
      jobs.filter((job) => job.status === "complete").forEach((job) => completedImports.current.add(job.id));
    }).catch(() => {});
    return api.imports.onJobUpdated((job) => {
      setImportJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      if (job.status === "complete" && !completedImports.current.has(job.id)) {
        completedImports.current.add(job.id);
        setToast(`“${job.title}”已完成导入，点击任务可查看结果。`);
        void refreshMeetings();
      }
    });
  }, [refreshMeetings]);

  useEffect(() => {
    if (!loading && (!preferences.systemPermissionsCompleted || preferences.permissionsVersion < 2)) setPermissionsOpen(true);
  }, [loading, preferences.permissionsVersion, preferences.systemPermissionsCompleted]);

  useEffect(() => {
    if (!loading && preferences.systemPermissionsCompleted && !preferences.onboardingCompleted) setOnboardingOpen(true);
  }, [loading, preferences.onboardingCompleted, preferences.systemPermissionsCompleted]);

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
  const recorder = useMeetingRecorder(meeting);

  useEffect(() => {
    if (recorder.warning) {
      // Surface license-required errors from the main process as the paywall
      // rather than a generic toast. The code is prefixed in the message
      // because custom Error properties do not survive the contextBridge.
      if (recorder.warning.startsWith("[LICENSE_REQUIRED]")) {
        setPaywallReason(recorder.warning.replace(/^\[LICENSE_REQUIRED\]\s*/, ""));
        setPaywallOpen(true);
        return;
      }
      setToast(recorder.warning);
    }
  }, [recorder.warning]);

  // Flush the recorder when the window closes so the last audio chunk is not
  // lost; the main-process before-quit handler is the backstop.
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

  const handleCreate = async (input: CreateMeetingInput) => {
    const created = await createMeeting(input);
    setNewMeetingOpen(false);
    setToast("会议已创建，可以开始录音。");
    return created;
  };

  const handleImport = async () => {
    if (!requirePremium("导入录音并自动处理")) return;
    const files = await api.imports.choose();
    if (!files.length) return;
    setImportCandidates((current) => [...current, ...files]);
    setImportOpen(true);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    if (!event.dataTransfer.files.length || !requirePremium("导入录音并自动处理")) return;
    try {
      const files = await api.imports.fromDropped(Array.from(event.dataTransfer.files));
      setImportCandidates((current) => [...current, ...files]);
      setImportOpen(true);
    } catch (error) { setToast(error instanceof Error ? error.message : "无法读取拖入的文件。"); }
  };

  const handleMeetingChange = (next: Meeting) => {
    updateMeeting(next.id, () => next);
  };

  if (loading && !meeting) {
    return (
      <div className="app-loading">
        <BrandMark className="app-loading__mark" size={42} />
        <p>正在打开MinuteFlow…</p>
      </div>
    );
  }

  return (
    <div className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <Sidebar
        meetings={meetings}
        selectedId={selectedId}
        onSelect={selectMeeting}
        onNew={() => setNewMeetingOpen(true)}
        onImport={handleImport}
        importCount={importJobs.filter((job) => !["complete", "cancelled", "failed"].includes(job.status)).length}
        onTemplates={() => setNewMeetingOpen(true)}
        onTrash={() => setTrashOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="main-pane">
        {meeting ? (
          <>
            <header className="document-header">
              <div className="document-header__title">
                <input
                  aria-label="会议标题"
                  value={meeting.title}
                  onChange={(event) => handleMeetingChange({ ...meeting, title: event.target.value })}
                />
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
                <div className="export-wrap">
                  <button className="button button--primary button--small" onClick={() => {
                    if (requirePremium("导出会议文档与完整备份")) setExportOpen((value) => !value);
                  }}>
                    <Export size={16} /> 导出
                  </button>
                  {exportOpen && (
                    <ExportMenu
                      meeting={meeting}
                      onClose={() => setExportOpen(false)}
                      onDone={(message) => setToast(message)}
                    />
                  )}
                </div>
                <div className="export-wrap">
                  <button
                    className="icon-button"
                    aria-label="更多选项"
                    onClick={() => setMoreOpen((value) => !value)}
                  >
                    <DotsThree size={22} weight="bold" />
                  </button>
                  {moreOpen && (
                    <div className="more-menu">
                      <button onClick={async () => {
                        try {
                          await api.recordings.open(meeting.id);
                        } catch (error) {
                          setToast(error instanceof Error ? error.message : "无法打开录音位置。");
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
                      <button className="is-danger" onClick={async () => {
                        await deleteMeeting(meeting.id);
                        setMoreOpen(false);
                        setToast("会议已移到最近删除，可在会议库中恢复。");
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

            <MeetingPlayer meetingId={meeting.id} durationSeconds={meeting.durationSeconds} seekToMs={seekToMs} onTimeChange={setPlaybackMs} />

            <DocumentWorkspace
              meeting={meeting}
              onChange={handleMeetingChange}
              onGenerateSummary={() => {
                if (requirePremium("生成 AI 会议纪要")) recorder.generateSummary(false);
              }}
              summaryBusy={recorder.summaryBusy}
            />

            <RecorderBar
              meeting={meeting}
              phase={recorder.phase}
              elapsed={recorder.elapsed}
              levels={recorder.levels}
              queue={recorder.queue}
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
                setToast(`已在 ${time} 添加重点标记。`);
              }}
            />
          </>
        ) : (
          <EmptyState onNew={() => setNewMeetingOpen(true)} onImport={handleImport} />
        )}
      </main>

      {meeting && rightPanelOpen && (
        <TranscriptPanel
          meeting={meeting}
          onChange={handleMeetingChange}
          onClose={() => setRightPanelOpen(false)}
          playbackMs={playbackMs}
          onSeek={(ms) => { setSeekToMs(null); requestAnimationFrame(() => setSeekToMs(ms)); }}
        />
      )}

      <NewMeetingDialog
        open={newMeetingOpen}
        onClose={() => setNewMeetingOpen(false)}
        onCreate={handleCreate}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DeletedMeetingsDialog
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={initialize}
      />
      <OnboardingDialog
        open={onboardingOpen}
        onComplete={async () => {
          await updatePreferences({ ...preferences, onboardingCompleted: true });
          setOnboardingOpen(false);
        }}
        onConfigureModels={async () => {
          await updatePreferences({ ...preferences, onboardingCompleted: true });
          setOnboardingOpen(false);
          setSettingsOpen(true);
        }}
      />
      <SystemPermissionsDialog
        open={permissionsOpen}
        onComplete={async () => {
          await updatePreferences({ ...preferences, systemPermissionsCompleted: true, permissionsVersion: 2 });
          setPermissionsOpen(false);
        }}
      />
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
          setToast(`${jobs.length} 个录音已归档并加入后台队列。`);
        }}
        onRetry={(id) => void api.imports.retry(id)}
        onCancel={(id) => void api.imports.cancel(id)}
        onOpenMeeting={(id) => { selectMeeting(id); setImportOpen(false); }}
        onConfigure={() => { setImportOpen(false); setSettingsOpen(true); }}
      />

      {(error || toast) && (
        <Toast
          message={error || toast || ""}
          onClose={() => {
            clearError();
            setToast(null);
            recorder.setWarning(null);
          }}
        />
      )}

      <button
        className="floating-settings"
        aria-label="打开设置"
        onClick={() => setSettingsOpen(true)}
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
