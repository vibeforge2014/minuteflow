import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CloudCheck,
  DotsThree,
  Export,
  GearSix,
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
import { useMeetingStore } from "./store/meetingStore";
import { useMeetingRecorder } from "./hooks/useMeetingRecorder";
import { api } from "./lib/api";
import type { CreateMeetingInput, Meeting } from "./types";
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
    selectMeeting,
    createMeeting,
    updateMeeting,
    appendTranscript,
    deleteMeeting,
    updatePreferences,
    clearError
  } = useMeetingStore();
  const [newMeetingOpen, setNewMeetingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (!loading && !preferences.onboardingCompleted) setOnboardingOpen(true);
  }, [loading, preferences.onboardingCompleted]);

  const meeting = useMemo(
    () => meetings.find((item) => item.id === selectedId),
    [meetings, selectedId]
  );
  const recorder = useMeetingRecorder(meeting);

  useEffect(() => {
    if (recorder.warning) setToast(recorder.warning);
  }, [recorder.warning]);

  const handleCreate = async (input: CreateMeetingInput) => {
    const created = await createMeeting(input);
    setNewMeetingOpen(false);
    setToast("会议已创建，可以开始录音。");
    return created;
  };

  const handleImport = async () => {
    const files = await api.imports.choose();
    if (!files.length) {
      setToast("在 Electron 应用中可选择 MP3、M4A、WAV、FLAC、WebM、MP4 或 MOV。");
      return;
    }
    const sttProfile = profiles.find((profile) => profile.kind === "stt" && profile.enabled);
    const llmProfile = profiles.find((profile) => profile.kind === "llm" && profile.enabled);
    if (sttProfile?.id) {
      setToast(`正在处理 ${files.length} 个文件，完成前请保持应用打开。`);
      for (const filePath of files) {
        try {
          await api.imports.process({
            filePath,
            sttProfileId: sttProfile.id,
            llmProfileId: llmProfile?.id,
            language: "zh"
          });
        } catch (error) {
          setToast(error instanceof Error ? error.message : "导入处理失败。");
        }
      }
      await initialize();
      setToast(`已完成 ${files.length} 个导入任务。`);
      return;
    }
    for (const file of files) {
      const name = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "导入的会议";
      const imported = await createMeeting({
        title: name,
        mode: "offline",
        participants: ["待识别"],
        goals: ["转录并整理导入的录音"],
        tags: ["导入"]
      });
      await updateMeeting(imported.id, (current) => ({
        ...current,
        notes: [`已导入：${file}`, "等待选择转录模型后开始处理。"],
        notesMarkdown: `已导入：${file}\n\n等待选择转录模型后开始处理。`
      }));
    }
    setToast(`已加入 ${files.length} 个导入任务；配置转录模型后即可处理。`);
  };

  const handleMeetingChange = (next: Meeting) => {
    updateMeeting(next.id, () => next);
  };

  if (loading && !meeting) {
    return (
      <div className="app-loading">
        <BrandMark className="app-loading__mark" size={42} />
        <p>正在打开会议助手…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        meetings={meetings}
        selectedId={selectedId}
        onSelect={selectMeeting}
        onNew={() => setNewMeetingOpen(true)}
        onImport={handleImport}
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
                  <button className="button button--primary button--small" onClick={() => setExportOpen((value) => !value)}>
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

            <DocumentWorkspace
              meeting={meeting}
              onChange={handleMeetingChange}
              onGenerateSummary={() => recorder.generateSummary(false)}
              summaryBusy={recorder.summaryBusy}
            />

            <RecorderBar
              meeting={meeting}
              phase={recorder.phase}
              elapsed={recorder.elapsed}
              levels={recorder.levels}
              queue={recorder.queue}
              onStart={recorder.start}
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
          onAppend={appendTranscript}
          onClose={() => setRightPanelOpen(false)}
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
    </div>
  );
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}
