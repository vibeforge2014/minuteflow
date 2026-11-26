import { SummaryProgress, type SummaryProgressState } from "./SummaryProgress";
/**
 * 中央会议文档（工作区中栏）：自上而下依次是日期/参与者行、标题、
 * 会议目标、个人笔记（Tiptap 富文本 + Markdown 源码/预览三态 + .md 导入）、
 * 实时纪要（滚动要点，stale 提示与手动总结）、行动项表格、决策/问题/风险/下一步网格。
 * 笔记以 Markdown 为真源（notesMarkdown 优先），编辑器与纯文本 notes 双向同步；
 * 手动编辑过的纪要字段经 lockSummaryField 打锁，AI 重新生成时不会覆盖。
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  CheckSquare,
  Eye,
  FileArrowUp,
  FileText,
  LinkSimple,
  ListBullets,
  Lock,
  LockOpen,
  Microphone,
  NotePencil,
  PencilSimple,
  Plus,
  Sparkle,
  Target,
  DotsThree,
  Trash,
  WarningCircle,
  X,
  XCircle
} from "@phosphor-icons/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TurndownService from "turndown";
import type { ImportJob, Meeting, ModelProfile, SummaryTemplateId } from "../types";
import { api } from "../lib/api";
import { lockSummaryField, removeSummaryListItem, toggleSummaryLock } from "../lib/summary";
import { displayParticipants } from "../lib/transcript";
import { formatDuration, formatInterval } from "../lib/format";
import { markdownToHtml } from "../lib/markdown";
import { useMeetingStore } from "../store/meetingStore";
import type { RecordingReadiness, WorkspaceStage } from "../lib/workspace";
import { VisualSummaryView } from "./VisualSummaryView";
import { TranscriptView, type TranscriptJump } from "./TranscriptPanel";
import { MinutesOverview, MinutesSections, MinutesSource, type MinutesSourceJump } from "./MinutesSections";
import { ImportProcessingMeta } from "./ImportProcessingMeta";
import { canRetryTranscriptionGaps, describeReviewProcessing, isActiveImportJob, isRetryableImportJob } from "../lib/import-status";
import type { ContentChangeKind } from "../lib/content-motion";
import type { LiveTranscriptionFailure } from "../services/recording";
import { useEnteringItemIds, useSummaryContentMotion } from "../hooks/useContentMotion";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { SUMMARY_TEMPLATES } from "../../shared/summary-templates.mjs";

interface DocumentWorkspaceProps {
  meeting: Meeting;
  stage: WorkspaceStage;
  splitWorkspace: boolean;
  readiness: RecordingReadiness;
  elapsed: number;
  recentlyFinalized: boolean;
  processingStatus?: string;
  /** 导入任务（转写视图顶部的即时状态行）。 */
  importJob?: ImportJob;
  sttProfiles: ModelProfile[];
  /** 重试/取消后台导入处理；失败后可直接在会后文档里恢复。 */
  onRetryImport?(id: string, sttProfileId?: string): void;
  onCancelImport?(id: string): void;
  /** 跳过说话人识别：转写已就绪时先用现有发言人占位继续生成纪要。 */
  onSkipDiarization?(id: string): void;
  /** 重新转录：用已归档录音重跑转写/识别/纪要（在线转写失败后的会后补救路径）。 */
  onRetranscribe?(): void;
  /** 当前播放位置（毫秒），转写视图中用于歌词式高亮。 */
  playbackMs?: number;
  playbackPlaying?: boolean;
  /** 点击转写时间戳时请求播放器跳转。 */
  onSeek?(ms: number): void;
  minutesJump: TranscriptJump | null;
  onJumpToMinutesSource: MinutesSourceJump;
  /** 空逐字稿在会后提供唯一、明确的恢复动作（继续录音）。 */
  emptyActionLabel?: string;
  onEmptyAction?(): void;
  onChange(meeting: Meeting): void;
  onStartRecording(): Promise<void>;
  onConfigureTranscription(): void;
  /** 实时转写连续失败（重试耗尽）：在转写视图顶部展示可操作的持久横幅。 */
  transcriptionFailure?: LiveTranscriptionFailure | null;
  /** 当前转写是否为本机 Whisper，决定横幅里的主行动文案。 */
  transcriptionIsLocal?: boolean;
  onUseLocalWhisper?(): void;
  onChooseTranscriptionService?(): void;
  onDismissTranscriptionFailure?(): void;
  onOpenPermissions(): void;
  /** 手动触发 AI 纪要（录音中为滚动增量，会后为终稿）。 */
  onGenerateSummary(): void;
  /** 会后：AI 读整份纪要与转写，只重炼关键结论这一节。 */
  onRefineKeyPoints(): void;
  /** 取消进行中的总结请求（生成按钮在 busy 态变为“取消”）。 */
  onCancelSummary(): void;
  /** 仅用普通纪要重试视觉版。 */
  onRetryVisualSummary(): void;
  visualSummaryError?: string;
  /** 纪要模板：只改归纳视角，不改纪要结构；生成前可选。 */
  summaryTemplate: SummaryTemplateId;
  onSummaryTemplateChange(template: SummaryTemplateId): void;
  summaryBusy: boolean;
  summaryProgress: SummaryProgressState | null;
  liveDocument: "notes" | "summary" | null;
  onCloseLiveDocument(): void;
}

export function DocumentWorkspace({
  meeting,
  stage,
  splitWorkspace,
  readiness,
  elapsed,
  recentlyFinalized,
  processingStatus,
  importJob,
  sttProfiles,
  onRetryImport,
  onCancelImport,
  onSkipDiarization,
  onRetranscribe,
  playbackMs = 0,
  playbackPlaying = false,
  onSeek,
  minutesJump,
  onJumpToMinutesSource,
  emptyActionLabel,
  onEmptyAction,
  onChange,
  onStartRecording,
  onConfigureTranscription,
  transcriptionFailure,
  transcriptionIsLocal = false,
  onUseLocalWhisper,
  onChooseTranscriptionService,
  onDismissTranscriptionFailure,
  onOpenPermissions,
  onGenerateSummary,
  onRefineKeyPoints,
  onCancelSummary,
  onRetryVisualSummary,
  visualSummaryError,
  summaryTemplate,
  onSummaryTemplateChange,
  summaryBusy,
  summaryProgress,
  liveDocument,
  onCloseLiveDocument
}: DocumentWorkspaceProps) {
  const showLiveDocument = splitWorkspace && liveDocument !== null;
  const liveDialogRef = useDialogFocus<HTMLElement>(showLiveDocument, { onEscape: onCloseLiveDocument });
  useEffect(() => {
    if (!showLiveDocument) return;
    const section = liveDialogRef.current?.querySelector(`.document-section--${liveDocument}`);
    section?.scrollIntoView({ block: "start" });
  }, [liveDialogRef, liveDocument, showLiveDocument]);
  const summaryIntervalSeconds = useMeetingStore((state) => state.preferences.summaryIntervalSeconds);
  const profiles = useMeetingStore((state) => state.profiles);
  const visualCapable = profiles.some((profile) => profile.kind === "llm" && profile.enabled
    && profile.options.visualSummaryEnabled && profile.options.visualSummaryVerifiedAt);
  const hasOrdinarySummary = Boolean(meeting.summary.overview || meeting.summary.discussionSections?.length)
    || meeting.summary.keyPoints.length > 0
    || meeting.summary.decisions.length > 0
    || meeting.summary.actionItems.length > 0
    || meeting.summary.openQuestions.length > 0
    || meeting.summary.risks.length > 0
    || meeting.summary.nextSteps.length > 0;
  const detailFields = [
    ["decisions", "已确认决策"],
    ["openQuestions", "未决问题"],
    ["risks", "风险"],
    ["nextSteps", "下一步"]
  ] as const;
  const emptyDetailFields = detailFields.filter(([key]) => !meeting.summary[key].length);
  const [summaryView, setSummaryView] = useState<"normal" | "visual">("normal");
  // 用户是否手动切换过纪要视图：true 时后台生成视觉纪要不再抢回视图，
  // 避免正在编辑普通纪要时字段突然消失。换会议/换阶段视为新上下文，重新自动选择。
  /** 会后文档头「更多」菜单：重新转录等低频维护动作收在这里，避免与主操作抢注意力。 */
  const [heroMenuOpen, setHeroMenuOpen] = useState(false);
  const [regeneratingSectionIndex, setRegeneratingSectionIndex] = useState<number | null>(null);
  const [sectionRegenError, setSectionRegenError] = useState("");
  const heroMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!heroMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!heroMenuRef.current?.contains(event.target as Node)) setHeroMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeroMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [heroMenuOpen]);
  useEffect(() => {
    setHeroMenuOpen(false);
    setRegeneratingSectionIndex(null);
    setSectionRegenError("");
  }, [meeting.id]);

  /** 局部重生成单个讨论议题章节，不覆盖其他章节与人工锁定项。 */
  const handleRegenerateSection = async (sectionIndex: number) => {
    if (regeneratingSectionIndex !== null || summaryBusy) return;
    setRegeneratingSectionIndex(sectionIndex);
    setSectionRegenError("");
    try {
      const result = await api.summary.regenerateSection({ meetingId: meeting.id, sectionIndex });
      onChange(result.meeting);
    } catch (error) {
      setSectionRegenError(error instanceof Error ? error.message : String(error));
    } finally {
      setRegeneratingSectionIndex(null);
    }
  };
  /** 中央列视图：AI 纪要文档 / 转写。会前只展示文档（还没有转写内容）。 */
  const [workspaceView, setWorkspaceView] = useState<"document" | "transcript">("document");
  // 会中固定展示转写，会前与会后默认展示文档。
  useEffect(() => {
    setWorkspaceView("document");
  }, [meeting.id, stage]);
  const showViewSwitch = stage === "review" && !splitWorkspace;
  const showTranscript = splitWorkspace || (showViewSwitch && workspaceView === "transcript");
  const showingImportSummaryProgress = importJob?.status === "summarizing" && Boolean(processingStatus);
  const reviewProcessing = describeReviewProcessing({
    meetingEnded: meeting.status === "complete",
    job: importJob
  });
  const visibleParticipants = displayParticipants(meeting.participants, meeting.transcript);
  /** 标签页遵循桌面键盘惯例：左右方向键切换，Home/End 到首尾。 */
  const handleWorkspaceTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === "Home"
      ? "document"
      : event.key === "End"
        ? "transcript"
        : workspaceView === "document" ? "transcript" : "document";
    setWorkspaceView(nextView);
    window.setTimeout(() => document.getElementById(nextView === "document" ? "summary-view-tab" : "transcript-tab")?.focus(), 0);
  };
  /** 笔记显示模式：富文本编辑 / Markdown 源码 / 只读预览。 */
  const [noteMode, setNoteMode] = useState<"rich" | "markdown" | "preview">("rich");
  /** 最近导入的 .md 文件名（显示导入成功提示）。 */
  const [importedFile, setImportedFile] = useState<string | null>(null);
  const summaryMotion = useSummaryContentMotion(meeting.id, meeting.summary);
  const enteringActionIds = useEnteringItemIds(
    `${meeting.id}:actions`,
    meeting.summary.actionItems.map((item) => item.id)
  );
  // onUpdate 回调里要访问「最新」的 meeting/onChange，用 ref 避免编辑器重建。
  const meetingRef = useRef(meeting);
  const onChangeRef = useRef(onChange);
  meetingRef.current = meeting;
  onChangeRef.current = onChange;
  // Tiptap 富文本编辑器：内容从 Markdown 渲染而来；每次编辑即时转回 Markdown 持久化，
  // 同时抽取纯文本行更新 notes（供搜索与 AI 纪要使用）。
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "写下你听到的内容，时间戳会自动关联当前会议…" })
    ],
    content: markdownToHtml(meetingMarkdown(meeting)),
    editorProps: { attributes: { class: "note-editor__content" } },
    onUpdate({ editor: currentEditor }) {
      const currentMeeting = meetingRef.current;
      const markdown = htmlToMarkdown(currentEditor.getHTML());
      const notes = currentEditor.getText({ blockSeparator: "\n" })
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      onChangeRef.current({ ...currentMeeting, notes, notesMarkdown: markdown });
    }
  });

  // 外部数据变化（切换会议、转写更新回写、Markdown 源码模式编辑）同步进编辑器；
  // 但用户正在编辑（聚焦）时不覆盖，避免光标跳动。
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const next = markdownToHtml(meetingMarkdown(meeting));
    if (editor.getHTML() !== next) editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, meeting.id, meeting.notes, meeting.notesMarkdown]);

  useEffect(() => {
    setSummaryView("normal");
  }, [meeting.id, stage]);

  /** 导入 .md 文件：规范化换行/BOM 后写入编辑器与 notesMarkdown，并切到预览态。 */
  const importMarkdown = async () => {
    const imported = await api.notes.importMarkdown();
    if (!imported) return;
    const markdown = imported.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    editor?.commands.setContent(markdownToHtml(markdown), { emitUpdate: false });
    onChange({
      ...meetingRef.current,
      notes: markdownToPlainText(markdown),
      notesMarkdown: markdown
    });
    setImportedFile(imported.filePath.split(/[\\/]/).pop() ?? "Markdown 笔记");
    setNoteMode("preview");
  };

  /** 修改会议目标列表。 */
  const setStringList = (key: "goals", values: string[]) =>
    onChange({ ...meeting, [key]: values });

  /** 关键结论折叠阈值：超过后收起为前 5 条 +「展开全部」；会议进行中始终全量展示。 */
  const [keyPointsExpanded, setKeyPointsExpanded] = useState(false);
  /** 刚通过「添加结论」插入的行索引：聚焦输入，失焦仍为空则自动移除。 */
  const [addingKeyPointIndex, setAddingKeyPointIndex] = useState<number | null>(null);
  /** Escape 回退用的行内旧值：记录 {index, value}，只回退当前聚焦行，
   *  避免其它行（如刚添加的空行）的瞬时 focus 污染回退值。 */
  const keyPointDraftRef = useRef<{ index: number; value: string } | null>(null);

  /**
   * 修改纪要的一个列表字段（要点/决策/未决问题/风险/下一步）。
   * 手动改动会把被编辑的那条加入 manualLocks（lockSummaryField），AI 下次生成不覆盖它。
   */
  const setSummaryList = (
    key: "keyPoints" | "decisions" | "openQuestions" | "risks" | "nextSteps",
    values: string[],
    lockedIndex: number
  ) => onChange({
    ...meeting,
    summary: lockSummaryField(
      { ...meeting.summary, [key]: values, stale: false },
      `${key}:${lockedIndex}`
    )
  });

  /** 添加一条空的关键结论：立即锁定 + 聚焦，失焦仍为空时由行内 onBlur 自动移除。
   *  折叠时先展开，保证新行可见并拿到焦点（否则它落在折叠区外，既看不到也聚不了焦）。 */
  const addKeyPoint = () => {
    const index = meeting.summary.keyPoints.length;
    setKeyPointsExpanded(true);
    onChange({
      ...meeting,
      summary: lockSummaryField({
        ...meeting.summary,
        keyPoints: [...meeting.summary.keyPoints, ""],
        ...(meeting.summary.keyPointTimes
          ? { keyPointTimes: [...meeting.summary.keyPointTimes, null] }
          : {}),
        ...(meeting.summary.keyPointHeadlines
          ? { keyPointHeadlines: [...meeting.summary.keyPointHeadlines, null] }
          : {}),
        stale: false
      }, `keyPoints:${index}`)
    });
    setAddingKeyPointIndex(index);
  };

  /** 编辑某条结论的要点标题（可空的平行数组；清空即回到单行形态）。 */
  const setKeyPointHeadline = (index: number, value: string) => {
    const headlines = meeting.summary.keyPointHeadlines
      ?? meeting.summary.keyPoints.map(() => null);
    onChange({
      ...meeting,
      summary: lockSummaryField({
        ...meeting.summary,
        keyPointHeadlines: headlines.map((item, itemIndex) =>
          itemIndex === index ? (value.trim() ? value.slice(0, 24) : null) : item),
        stale: false
      }, `keyPoints:${index}`)
    });
  };

  /** 删除一条关键结论（含锁重排与证据时间切片，见 removeSummaryListItem）。 */
  const removeKeyPoint = (index: number) =>
    onChange({ ...meeting, summary: removeSummaryListItem(meeting.summary, "keyPoints", index) });

  /** 关键结论回链：切到转写视图、定位并短暂高亮目标段落；有音频时同时请求播放器跳转。 */
  const jumpToTranscript: MinutesSourceJump = (ms, segmentId) => {
    if (splitWorkspace) onCloseLiveDocument();
    else setWorkspaceView("transcript");
    onJumpToMinutesSource(ms, segmentId);
  };

  /** 更新单个行动项字段；手动改动即锁定该行动项（`action:<id>`），防止 AI 重算时丢失。 */
  const updateAction = (id: string, patch: Partial<Meeting["summary"]["actionItems"][number]>) =>
    onChange({
      ...meeting,
      summary: lockSummaryField({
        ...meeting.summary,
        actionItems: meeting.summary.actionItems.map((item) =>
          item.id === id ? { ...item, ...patch } : item)
      }, `action:${id}`)
    });

  /** 手动新增一条行动项并锁定；空态与列表尾部共用同一个入口。 */
  const addActionItem = () => {
    const id = crypto.randomUUID();
    onChange({
      ...meeting,
      summary: lockSummaryField({
        ...meeting.summary,
        actionItems: [...meeting.summary.actionItems, {
          id,
          title: "新的行动项",
          owner: "待确认",
          dueDate: "待确认",
          status: "todo",
          done: false
        }]
      }, `action:${id}`)
    });
  };

  const meetingDocument = (!showTranscript || showLiveDocument) && (
      <article
        key={`${meeting.id}-${summaryView}`}
        id="summary-panel"
        role={showViewSwitch ? "tabpanel" : undefined}
        aria-labelledby={showViewSwitch ? "summary-view-tab" : undefined}
        className={`meeting-document meeting-document--${stage} ${summaryView === "visual" ? "meeting-document--visual" : ""}`}
      >
        {stage !== "prepare" && <h1 className="sr-only">{meeting.title}</h1>}
        <div className="document-date document-date--workspace-meta">
          {formatMeetingDate(meeting.scheduledAt)}
          <span>·</span>
          <input
            className="participants-editor"
            aria-label="参与者"
            value={visibleParticipants.join("、")}
            onChange={(event) => onChange({
              ...meeting,
              participants: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean)
            })}
            title="编辑参与者，用顿号或逗号分隔"
          />
        </div>

        {stage === "prepare" && (
          <section className="preparation-card" aria-labelledby="preparation-title">
            <div className="preparation-card__intro">
              <h1 id="preparation-title">一切就绪后，直接开始记录</h1>
            </div>
            <div className="readiness-grid">
              {readiness.items.map((item) => (
                <div className={`readiness-item readiness-item--${item.tone}`} key={item.id}>
                  <span className="readiness-item__icon">
                    {item.tone === "ready" ? <CheckCircle size={18} weight="fill" /> : item.tone === "attention" ? <WarningCircle size={18} weight="fill" /> : <Microphone size={18} />}
                  </span>
                  <div>
                    <small>{item.label}</small>
                    <strong>{item.value}</strong>
                    {item.detail && <p>{item.detail}</p>}
                  </div>
                  {item.id === "microphone" && readiness.microphoneNeedsAttention && (
                    <button className="text-button" onClick={onOpenPermissions}>查看授权</button>
                  )}
                  {item.id === "transcription" && (
                    <div className="readiness-item__actions">
                      <button className="text-button" onClick={onUseLocalWhisper}>本地 Whisper</button>
                      <button className="text-button" onClick={onConfigureTranscription}>
                        {readiness.hasTranscription ? "更换服务" : "在线服务"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button className="preparation-start" onClick={() => void onStartRecording()}>
              <Microphone size={20} weight="fill" />
              <strong>开始录音</strong>
              <CaretRight size={18} weight="bold" />
            </button>
          </section>
        )}

        {stage === "review" && (
          <section className={`review-hero ${recentlyFinalized || processingStatus ? "is-fresh" : ""} ${hasOrdinarySummary && !processingStatus && !summaryBusy ? "review-hero--compact" : ""}`}>
            <div className="review-hero__main">
              <div className="review-hero__head">
                {reviewProcessing && (
                  <span className="eyebrow">{reviewProcessing.eyebrow}</span>
                )}
                {!processingStatus && (
                  // 安静的文本切换，不再放第二个分段控件在工作区标签旁边。
                  <button
                    className="review-hero__view-toggle"
                    onClick={() => setSummaryView(summaryView === "visual" ? "normal" : "visual")}
                    aria-label={summaryView === "visual" ? "切换到普通纪要" : "切换到视觉纪要"}
                  >
                    {summaryView === "visual" ? <FileText size={14} /> : <Sparkle size={14} />}
                    {summaryView === "visual" ? "普通纪要" : "视觉纪要"}
                    {summaryView === "normal" && meeting.summary.visualSummary && !meeting.summary.visualSummary.stale && (
                      <i className="review-hero__view-dot" aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
              {importJob && processingStatus && !(splitWorkspace && showingImportSummaryProgress) && <ImportProcessingMeta job={importJob} />}
              {!processingStatus && summaryProgress && !splitWorkspace && <SummaryProgress progress={summaryProgress} />}
              {reviewProcessing && !showingImportSummaryProgress && <p>{reviewProcessing.detail}</p>}
              {!hasOrdinarySummary && !processingStatus && !summaryBusy && <p>{recentlyFinalized ? "录音已保存。" : "还没有纪要。"}</p>}
            </div>
            <div className="review-hero__side">
              {importJob?.status === "diarizing" && (
                <>
                  <button className="button button--secondary" onClick={() => setWorkspaceView("transcript")}>
                    <NotePencil size={16} />先看转写
                  </button>
                  {onSkipDiarization && (
                    <button className="button button--secondary" onClick={() => onSkipDiarization(importJob.id)}>
                      <CaretRight size={16} />跳过识别，生成纪要
                    </button>
                  )}
                </>
              )}
              {importJob && isActiveImportJob(importJob) && onCancelImport && !(splitWorkspace && showingImportSummaryProgress) && (
                <button
                  className="button button--secondary"
                  title="暂停后可随时继续，已完成的转写不会丢失"
                  onClick={() => onCancelImport(importJob.id)}
                >
                  <XCircle size={16} />暂停处理
                </button>
              )}
              {importJob && !isActiveImportJob(importJob) && isRetryableImportJob(importJob) && onRetryImport && (
                <button className="button button--primary" onClick={() => onRetryImport(importJob.id)}>
                  <ArrowClockwise size={16} />{canRetryTranscriptionGaps(importJob) ? "补转漏段" : "重试处理"}
                </button>
              )}
              {!splitWorkspace && !processingStatus && (summaryBusy ? (
                <button className="button button--secondary" onClick={onCancelSummary}><XCircle size={16} />取消生成</button>
              ) : summaryView === "normal" ? (
                <>
                  <label className="review-hero__template" title="模板只改变归纳视角（先看什么、怎么写行动项），纪要结构与编辑方式不变">
                    <span>纪要模板</span>
                    <select
                      value={summaryTemplate}
                      aria-label="选择纪要模板"
                      onChange={(event) => onSummaryTemplateChange(event.target.value as SummaryTemplateId)}
                    >
                      {SUMMARY_TEMPLATES.map((template) => (
                        <option key={template.id} value={template.id} title={template.description}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className={`button ${meeting.summary.stale || !hasOrdinarySummary ? "button--primary" : "button--secondary review-hero__generate"}`}
                    onClick={onGenerateSummary}
                  >
                    <ArrowClockwise size={16} />{meeting.summary.stale ? "更新纪要" : hasOrdinarySummary ? "重新生成纪要" : "生成最终纪要"}
                  </button>
                </>
              ) : null)}
              {!processingStatus && !summaryBusy && summaryView === "normal" && (hasOrdinarySummary || onRetranscribe) && (
                <div className="review-hero__more" ref={heroMenuRef}>
                  <button
                    className="icon-button icon-button--labeled review-hero__more-button"
                    aria-label="更多纪要操作"
                    aria-haspopup="menu"
                    aria-expanded={heroMenuOpen}
                    onClick={() => setHeroMenuOpen((open) => !open)}
                  >
                    <DotsThree size={20} weight="bold" />
                    <span>纪要操作</span>
                  </button>
                  {heroMenuOpen && (
                    <div className="review-hero__menu" role="menu" aria-label="更多纪要操作">
                      {hasOrdinarySummary && <button role="menuitem" onClick={() => { setHeroMenuOpen(false); onRefineKeyPoints(); }}>
                        <Sparkle size={14} />仅更新关键结论
                      </button>}
                      {onRetranscribe && <button role="menuitem" onClick={() => { setHeroMenuOpen(false); onRetranscribe(); }}>
                        <ArrowClockwise size={14} />重新转录
                      </button>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {stage === "review" && summaryView === "visual" && (
          <div className="content-view-enter">
            <VisualSummaryView
              meeting={meeting}
              participants={visibleParticipants}
              visual={meeting.summary.visualSummary}
              capable={Boolean(visualCapable)}
              busy={summaryBusy}
              error={visualSummaryError}
              onRetry={onRetryVisualSummary}
            />
          </div>
        )}

        <DocumentSection kind="goals" icon={<Target size={20} weight="duotone" />} title="会议目标">
          <EditableList
            values={meeting.goals}
            placeholder="添加会议目标"
            onChange={(values) => setStringList("goals", values)}
          />
        </DocumentSection>

        <DocumentSection kind="notes" icon={<NotePencil size={20} weight="duotone" />} title="我的记录">
          <div className="note-toolbar-row">
            <div className="editor-toolbar" aria-label="笔记格式工具栏">
              <button
                className={editor?.isActive("bold") ? "is-active" : ""}
                onClick={() => editor?.chain().focus().toggleBold().run()}
                aria-label="粗体"
                disabled={noteMode !== "rich"}
              >B</button>
              <button
                className={editor?.isActive("italic") ? "is-active" : ""}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                aria-label="斜体"
                disabled={noteMode !== "rich"}
              ><em>I</em></button>
              <button
                className={editor?.isActive("bulletList") ? "is-active" : ""}
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                aria-label="项目符号"
                disabled={noteMode !== "rich"}
              ><ListBullets size={17} /></button>
              <button
                onClick={() => editor?.chain().focus().insertContent(`[${formatDuration(stage === "live" ? elapsed : meeting.durationSeconds)}] `).run()}
                aria-label="插入时间戳"
                disabled={noteMode !== "rich"}
              ><LinkSimple size={16} /></button>
            </div>
            <div className="note-mode-switch" aria-label="笔记显示模式">
              <button className={noteMode === "rich" ? "is-active" : ""} onClick={() => setNoteMode("rich")}><PencilSimple size={14} />编辑</button>
              <button className={noteMode === "markdown" ? "is-active" : ""} onClick={() => setNoteMode("markdown")}><span>MD</span>源码</button>
              <button className={noteMode === "preview" ? "is-active" : ""} onClick={() => setNoteMode("preview")}><Eye size={14} />预览</button>
              <button onClick={importMarkdown}><FileArrowUp size={14} />导入 .md</button>
            </div>
          </div>
          {importedFile && <div className="note-imported-file">已导入并保存：{importedFile}</div>}
          {noteMode === "rich" && <EditorContent editor={editor} className="note-editor" />}
          {noteMode === "markdown" && (
            <textarea
              className="note-markdown-source"
              aria-label="Markdown 笔记源码"
              value={meetingMarkdown(meeting)}
              onChange={(event) => {
                const notesMarkdown = event.target.value;
                onChange({
                  ...meeting,
                  notesMarkdown,
                  notes: markdownToPlainText(notesMarkdown)
                });
              }}
              placeholder="# 标题\n\n- 会议笔记"
            />
          )}
          {noteMode === "preview" && (
            <div
              className="note-preview markdown-body"
              dangerouslySetInnerHTML={{ __html: markdownToHtml(meetingMarkdown(meeting)) }}
            />
          )}
        </DocumentSection>

        {meeting.summary.overview && summaryView === "normal" && (
          <MinutesOverview text={meeting.summary.overview} />
        )}
        <DocumentSection
          kind="summary"
          icon={<FileText size={20} weight="duotone" />}
          title={stage === "live" ? "会议进展" : "关键结论"}
          badge={
            <span className="summary-badge-group">
              <span className={`summary-cadence ${hasOrdinarySummary ? "" : "is-empty"} ${stage === "live" && summaryBusy ? "is-generating" : ""}`}>
                <i /> {hasOrdinarySummary
                  ? meeting.summary.generationMode === "local" ? "本机基础归纳" : "AI 自动整理"
                  : "尚未生成"}{stage === "live" ? ` · 约每 ${formatInterval(summaryIntervalSeconds)}` : ""}
              </span>
              {stage !== "live" && meeting.summary.detectedMeetingType && meeting.summary.detectedMeetingType !== "通用会议" && (
                <span className="summary-meta-pill" title="系统自动识别的会议类型">{meeting.summary.detectedMeetingType}</span>
              )}
              {stage !== "live" && meeting.summary.verification?.verified && (
                <span
                  className="summary-meta-pill summary-meta-pill--verified"
                  title={`高精度事实核验已完成（发现 ${meeting.summary.verification.issuesFound} 项，修订 ${meeting.summary.verification.issuesFixed} 项）${meeting.summary.verification.unverifiedNotes?.length ? `\n提示：${meeting.summary.verification.unverifiedNotes.join("；")}` : ""}`}
                >
                  <CheckCircle size={12} weight="fill" />已核验
                </span>
              )}
            </span>
          }

        >
          {meeting.summary.stale && (
            <div className="summary-stale">
              会议内容已更新，纪要待更新。
            </div>
          )}
          {summaryBusy && !meeting.summary.keyPoints.length ? (
            // 生成期且尚无结论：shimmer 骨架占位结论行，内容到位后整体消失。
            <div className="summary-skeleton" aria-hidden="true">
              <i style={{ width: "76%" }} /><i style={{ width: "88%" }} /><i style={{ width: "62%" }} />
            </div>
          ) : meeting.summary.keyPoints.length ? (
            (() => {
              const KEY_POINT_FOLD_LIMIT = 5;
              const folded = stage !== "live" && !keyPointsExpanded
                && meeting.summary.keyPoints.length > KEY_POINT_FOLD_LIMIT;
              const visibleKeyPoints = folded
                ? meeting.summary.keyPoints.slice(0, KEY_POINT_FOLD_LIMIT)
                : meeting.summary.keyPoints;
              return (
                <div className="summary-points">
                  {visibleKeyPoints.map((item, index) => {
                    const locked = meeting.summary.manualLocks?.includes(`keyPoints:${index}`) ?? false;
                    const timeMs = meeting.summary.keyPointTimes?.[index];
                    const headline = meeting.summary.keyPointHeadlines?.[index] ?? null;
                    const isAddingRow = index === addingKeyPointIndex;
                    return (
                      <div
                        key={`kp-${index}`}
                        className={`summary-point ${summaryMotion.lists.keyPoints[index] === "added" ? "is-new content-motion-enter" : summaryMotion.lists.keyPoints[index] === "updated" ? "content-motion-update" : ""}`}
                        style={{ animationDelay: `${Math.min(index, 3) * 30}ms` }}
                      >
                        <i aria-hidden="true" />
                        <div className="summary-point__body">
                          <input
                            className="summary-point__headline"
                            type="text"
                            aria-label={`纪要要点标题 ${index + 1}`}
                            placeholder="要点标题"
                            value={headline ?? ""}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === "Escape") {
                                event.preventDefault();
                                event.currentTarget.blur();
                              }
                            }}
                            onChange={(event) => setKeyPointHeadline(index, event.target.value)}
                          />
                          <textarea
                          aria-label={`编辑纪要 ${index + 1}`}
                          value={item}
                          rows={Math.max(1, Math.ceil(item.length / (headline ? 46 : 40)))}
                          autoFocus={isAddingRow}
                          // autoFocus 在部分挂载时序下不生效（如折叠展开同帧挂载），
                          // 用 ref 回调兜底保证新行稳定拿到焦点。
                          ref={isAddingRow ? (el) => el?.focus() : undefined}
                          onFocus={(event) => { keyPointDraftRef.current = { index, value: event.target.value }; }}
                          onBlur={() => {
                            if (!isAddingRow) return;
                            setAddingKeyPointIndex(null);
                            if (!item.trim()) removeKeyPoint(index);
                          }}
                          onKeyDown={(event) => {
                            // 一条结论一行：Enter 提交收起，Shift+Enter 保留手动换行；
                            // Escape 恢复聚焦时的旧值再收起。
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              const draft = keyPointDraftRef.current;
                              if (draft && draft.index === index && draft.value !== item) {
                                setSummaryList(
                                  "keyPoints",
                                  meeting.summary.keyPoints.map((value, itemIndex) =>
                                    itemIndex === index ? draft.value : value),
                                  index
                                );
                              }
                              event.currentTarget.blur();
                            }
                          }}
                          onChange={(event) => setSummaryList(
                            "keyPoints",
                            meeting.summary.keyPoints.map((value, itemIndex) =>
                              itemIndex === index ? event.target.value : value),
                            index
                          )}
                        />
                        </div>
                        <MinutesSource ms={timeMs} onJump={jumpToTranscript} />
                        <div className="summary-point__actions">
                          <button
                            className={`icon-button summary-lock ${locked ? "is-locked" : ""}`}
                            aria-label={locked ? "解除锁定，允许 AI 更新这条要点" : "锁定这条要点，AI 重新生成时不覆盖"}
                            title={locked ? "已锁定：AI 不覆盖。点击解锁。" : "未锁定。点击锁定后 AI 不覆盖这条。"}
                            onClick={() => onChange({
                              ...meeting,
                              summary: toggleSummaryLock(meeting.summary, `keyPoints:${index}`)
                            })}
                          >
                            {locked
                              ? <Lock size={13} weight="fill" />
                              : <LockOpen size={13} />}
                          </button>
                          <button
                            className="icon-button summary-remove"
                            aria-label="删除这条结论"
                            title="删除这条结论"
                            onClick={() => removeKeyPoint(index)}
                          >
                            <Trash size={13} />
                          </button>
                        </div>
                        {summaryMotion.lists.keyPoints[index] === "added" && <span className="content-status-enter">新增</span>}
                      </div>
                    );
                  })}
                  <button className="summary-point-add" onClick={addKeyPoint}>
                    <Plus size={13} />添加结论
                  </button>
                  {meeting.summary.keyPoints.length > KEY_POINT_FOLD_LIMIT && stage !== "live" && (
                    <button
                      className="summary-points__toggle"
                      aria-expanded={keyPointsExpanded}
                      onClick={() => setKeyPointsExpanded((value) => !value)}
                    >
                      {keyPointsExpanded ? "收起" : `展开全部 ${meeting.summary.keyPoints.length} 条`}
                    </button>
                  )}
                </div>
              );
            })()
          ) : (
            <div className="section-empty-row">
              <span>还没有关键结论。</span>
              <button className="text-button" onClick={addKeyPoint}><Plus size={13} />手动添加</button>
            </div>
          )}
        </DocumentSection>

        {summaryView === "normal" && (
          <>
            {sectionRegenError && <p className="summary-stale" role="alert">{sectionRegenError}</p>}
            <MinutesSections
              sections={meeting.summary.discussionSections}
              transcript={meeting.transcript}
              onJump={jumpToTranscript}
              onRegenerateSection={stage === "review" && !summaryBusy ? handleRegenerateSection : undefined}
              regeneratingIndex={regeneratingSectionIndex}
            />
          </>
        )}
        {meeting.summary.actionItems.length > 0 ? <DocumentSection kind="actions" icon={<CheckSquare size={20} weight="duotone" />} title="行动项">
          <div className="action-table">
            <div className="action-table__head">
              <span>任务</span><span>负责人</span><span>截止时间</span><span>状态</span>
            </div>
            {meeting.summary.actionItems.map((item) => {
              const actionLocked = meeting.summary.manualLocks?.includes(`action:${item.id}`) ?? false;
              const source = meeting.transcript.find((segment) => segment.status === "final" && item.evidenceSegmentIds?.includes(segment.id));
              return (
              <div
                className={`action-row ${enteringActionIds.has(item.id) || summaryMotion.actions[item.id] === "added" ? "content-motion-enter" : summaryMotion.actions[item.id] === "updated" ? "content-motion-update" : ""}`}
                key={item.id}
              >
                <div className="action-row__task">
                  <label>
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => updateAction(item.id, {
                        done: !item.done,
                        status: !item.done ? "done" : "todo"
                      })}
                    />
                    <input
                      aria-label={`编辑行动项 ${item.title}`}
                      className={item.done ? "is-done" : ""}
                      value={item.title}
                      onChange={(event) => updateAction(item.id, { title: event.target.value })}
                    />
                  </label>
                  <MinutesSource ms={source?.startMs} segmentId={source?.id} onJump={jumpToTranscript} />
                </div>
                <input aria-label="负责人" value={item.owner} onChange={(event) => updateAction(item.id, { owner: event.target.value })} />
                <input aria-label="截止时间" value={item.dueDate} onChange={(event) => updateAction(item.id, { dueDate: event.target.value })} />
                <select
                  aria-label="行动项状态"
                  className={`status status--${item.status}`}
                  value={item.status}
                  onChange={(event) => updateAction(item.id, {
                    status: event.target.value as typeof item.status,
                    done: event.target.value === "done"
                  })}
                >
                  <option value="todo">未开始</option>
                  <option value="in_progress">进行中</option>
                  <option value="done">已完成</option>
                </select>
                <button
                  className={`icon-button summary-lock ${actionLocked ? "is-locked" : ""}`}
                  aria-label={actionLocked ? "解除锁定，允许 AI 更新这条行动项" : "锁定这条行动项，AI 重新生成时不覆盖"}
                  title={actionLocked ? "已锁定：AI 不覆盖。点击解锁。" : "未锁定。点击锁定后 AI 不覆盖这条。"}
                  onClick={() => onChange({
                    ...meeting,
                    summary: toggleSummaryLock(meeting.summary, `action:${item.id}`)
                  })}
                >
                  {actionLocked ? <Lock size={13} weight="fill" /> : <LockOpen size={13} />}
                </button>
              </div>
              );
            })}
            <button className="text-button action-add" onClick={addActionItem}>
              <Plus size={14} />添加行动项
            </button>
          </div>
        </DocumentSection> : null}

        {detailFields.some(([key]) => meeting.summary[key].length > 0) && (
          <DocumentSection kind="details" icon={<CheckSquare size={20} weight="duotone" />} title="决策、问题与下一步">
            <div className="summary-detail-grid">
              {detailFields.filter(([key]) => meeting.summary[key].length > 0).map(([key, label]) => (
                <EditableSummaryList key={key} title={label} values={meeting.summary[key]}
                  motionKinds={summaryMotion.lists[key]} locks={meeting.summary.manualLocks} lockKey={key}
                  onToggleLock={(field) => onChange({ ...meeting, summary: toggleSummaryLock(meeting.summary, field) })}
                  onChange={(values, index) => setSummaryList(key, values, index)} />
              ))}
            </div>
          </DocumentSection>
        )}
        {stage !== "prepare" && (!meeting.summary.actionItems.length || emptyDetailFields.length > 0) && (
          <details className="minutes-add">
            <summary>补充纪要</summary>
            <div>
              {!meeting.summary.actionItems.length && <button className="text-button" onClick={addActionItem}>添加行动项</button>}
              {emptyDetailFields.map(([key, label]) => (
                <button className="text-button" key={key} onClick={() => setSummaryList(key, [`新的${label}`], 0)}>添加{label}</button>
              ))}
            </div>
          </details>
        )}
      </article>
  );

  return (
    <div className="document-scroll">
      {showViewSwitch && (
        <div className="workspace-view-switch-band">
          <div className="workspace-view-switch" role="tablist" aria-label="中央工作区内容" onKeyDown={handleWorkspaceTabKeyDown}>
            <button
              role="tab"
              id="summary-view-tab"
              aria-selected={workspaceView === "document"}
              tabIndex={workspaceView === "document" ? 0 : -1}
              className={workspaceView === "document" ? "is-active" : ""}
              onClick={() => setWorkspaceView("document")}
            >
              <FileText size={14} />AI 纪要
            </button>
            <button
              role="tab"
              id="transcript-tab"
              aria-selected={workspaceView === "transcript"}
              tabIndex={workspaceView === "transcript" ? 0 : -1}
              className={workspaceView === "transcript" ? "is-active" : ""}
              onClick={() => setWorkspaceView("transcript")}
            >
              <NotePencil size={14} />转写
            </button>
          </div>
        </div>
      )}
      {showTranscript ? (
        <div className="workspace-transcript" id="transcript-panel" role={showViewSwitch ? "tabpanel" : undefined} aria-labelledby={showViewSwitch ? "transcript-tab" : undefined}>
          <TranscriptView
            meeting={meeting}
            importJob={importJob}
            sttProfiles={sttProfiles}
            stage={stage}
            splitWorkspace={splitWorkspace}
            onChange={onChange}
            playbackMs={playbackMs}
            playbackPlaying={playbackPlaying}
            onSeek={onSeek}
            jumpTarget={minutesJump}
            emptyActionLabel={emptyActionLabel}
            onEmptyAction={onEmptyAction}
            summaryBusy={summaryBusy || Boolean(processingStatus)}
            transcriptionFailure={transcriptionFailure}
            transcriptionIsLocal={transcriptionIsLocal}
            onUseLocalWhisper={onUseLocalWhisper}
            onChooseTranscriptionService={onChooseTranscriptionService}
            onDismissTranscriptionFailure={onDismissTranscriptionFailure}
            onRetryImport={onRetryImport}
            onCancelImport={onCancelImport}
            onSkipDiarization={onSkipDiarization}
            onRetranscribe={onRetranscribe}
            onConfigureTranscription={onConfigureTranscription}
          />
        </div>
      ) : (
        meetingDocument
      )}
      {showLiveDocument && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onCloseLiveDocument();
        }}>
          <section ref={liveDialogRef} className="dialog live-document-dialog" role="dialog" aria-modal="true" aria-labelledby="live-document-title">
            <header>
              <h2 id="live-document-title">{liveDocument === "notes" ? "会议笔记" : "编辑纪要"}</h2>
              {liveDocument === "summary" && summaryProgress && (
                <>
                  <SummaryProgress progress={summaryProgress} />
                  <button className="text-button" onClick={onCancelSummary}>取消生成</button>
                </>
              )}
              <button className="icon-button" aria-label="关闭编辑" onClick={onCloseLiveDocument}><X size={19} /></button>
            </header>
            <div className="live-document-dialog__scroll">{meetingDocument}</div>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * 纪要四宫格里的一格：可编辑字符串列表（决策/未决问题/风险/下一步），编辑即锁定该条；
 * 行尾的锁标记显示锁定状态，点击可手动锁定/解锁（解锁后恢复由 AI 更新）。
 */
function EditableSummaryList({
  title,
  values,
  motionKinds,
  locks,
  lockKey,
  onToggleLock,
  onChange
}: {
  title: string;
  values: string[];
  motionKinds: ContentChangeKind[];
  locks?: string[];
  lockKey: "decisions" | "openQuestions" | "risks" | "nextSteps";
  onToggleLock(key: string): void;
  onChange(values: string[], lockedIndex: number): void;
}) {
  const enteringRows = useEnteringItemIds(`summary-detail:${title}`, values.map((_, index) => String(index)));
  return (
    <div className="summary-detail">
      <h3>{title}</h3>
      {values.length ? values.map((value, index) => {
        const locked = locks?.includes(`${lockKey}:${index}`) ?? false;
        return (
          <div
            className={`summary-detail-row ${enteringRows.has(String(index)) || motionKinds[index] === "added" ? "content-motion-enter" : motionKinds[index] === "updated" ? "content-motion-update" : ""}`}
            key={`${title}-${index}`}
            style={{ animationDelay: `${Math.min(index, 3) * 30}ms` }}
          >
            <textarea
              aria-label={`编辑${title} ${index + 1}`}
              rows={Math.max(1, Math.ceil(value.length / 34))}
              value={value}
              onChange={(event) => onChange(
                values.map((item, itemIndex) => itemIndex === index ? event.target.value : item),
                index
              )}
            />
            <button
              className={`icon-button summary-lock ${locked ? "is-locked" : ""}`}
              aria-label={locked ? `解除锁定这条${title}` : `锁定这条${title}`}
              title={locked ? "已锁定：AI 不覆盖。点击解锁。" : "未锁定。点击锁定后 AI 不覆盖这条。"}
              onClick={() => onToggleLock(`${lockKey}:${index}`)}
            >
              {locked ? <Lock size={13} weight="fill" /> : <LockOpen size={13} />}
            </button>
          </div>
        );
      }) : <span>暂无</span>}
      <button
        className="text-button summary-detail__add"
        onClick={() => onChange([...values, `新的${title}`], values.length)}
      >
        <Plus size={13} />添加
      </button>
    </div>
  );
}

/** 文档区块骨架：图标 + 标题 + 徽标 + 右侧动作按钮 + 内容。 */
function DocumentSection({
  kind,
  icon,
  title,
  badge,
  action,
  children
}: {
  kind: "goals" | "notes" | "summary" | "actions" | "details";
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`document-section document-section--${kind}`}>
      <header>
        <div className="document-section__title">{icon}<h2>{title}</h2>{badge}</div>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * 逐行编辑的字符串列表（会议目标用）：
 * 行内回车在下方插入空行、空行退格删除该行，底部输入框回车/失焦追加新项。
 */
function EditableList({
  values,
  placeholder,
  onChange
}: {
  values: string[];
  placeholder: string;
  onChange(values: string[]): void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) {
      onChange([...values, trimmed]);
      setDraft("");
    }
  };
  return (
    <ul className="editable-list">
      {values.map((value, index) => (
        <li key={`el-${index}`}>
          <input
            value={value}
            onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onChange([...values.slice(0, index + 1), "", ...values.slice(index + 1)]);
              }
              if (event.key === "Backspace" && !value && values.length > 1) {
                event.preventDefault();
                onChange(values.filter((_, itemIndex) => itemIndex !== index));
              }
            }}
          />
        </li>
      ))}
      <li className="editable-list__add">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
      </li>
    </ul>
  );
}

// HTML → Markdown 转换器（编辑器内容持久化为 Markdown 源）。
const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  headingStyle: "atx"
});

/** 取笔记的 Markdown 真源：优先 notesMarkdown；旧数据（无源码）由 notes 行拼装。 */
function meetingMarkdown(meeting: Meeting) {
  if (typeof meeting.notesMarkdown === "string") return meeting.notesMarkdown;
  return meeting.notes.map((item) => `- ${item}`).join("\n");
}

/** Markdown → 安全 HTML：marked 渲染后必须过 DOMPurify（禁 style/iframe 等），再进 dangerouslySetInnerHTML/编辑器。 */
// 实现抽取到 src/lib/markdown.ts，与 AI 问答气泡共用同一渲染管线。

/** HTML → Markdown（编辑器内容落盘）。 */
function htmlToMarkdown(html: string) {
  return turndown.turndown(html).trim();
}

/** Markdown → 纯文本行数组（写入 meeting.notes，供搜索与 AI 输入）。 */
function markdownToPlainText(markdown: string) {
  const container = document.createElement("div");
  container.innerHTML = markdownToHtml(markdown);
  return (container.textContent ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 文档头部日期显示：YYYY年M月D日 HH:mm。 */
function formatMeetingDate(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
