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
  WarningCircle,
  XCircle
} from "@phosphor-icons/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import DOMPurify from "dompurify";
import { marked } from "marked";
import TurndownService from "turndown";
import type { Meeting } from "../types";
import { api } from "../lib/api";
import { lockSummaryField, toggleSummaryLock } from "../lib/summary";
import { formatDuration, formatInterval } from "../lib/format";
import { useMeetingStore } from "../store/meetingStore";
import type { RecordingReadiness, WorkspaceStage } from "../lib/workspace";
import { VisualSummaryView } from "./VisualSummaryView";
import type { ContentChangeKind } from "../lib/content-motion";
import { useEnteringItemIds, useSummaryContentMotion } from "../hooks/useContentMotion";

interface DocumentWorkspaceProps {
  meeting: Meeting;
  stage: WorkspaceStage;
  readiness: RecordingReadiness;
  elapsed: number;
  recentlyFinalized: boolean;
  processingStatus?: string;
  onChange(meeting: Meeting): void;
  onStartRecording(): Promise<void>;
  onConfigureTranscription(): void;
  onOpenPermissions(): void;
  /** 手动触发 AI 总结（录音中为滚动增量，会后为终稿）。 */
  onGenerateSummary(): void;
  /** 取消进行中的总结请求（生成按钮在 busy 态变为“取消”）。 */
  onCancelSummary(): void;
  /** 仅用普通纪要重试视觉版。 */
  onRetryVisualSummary(): void;
  summaryBusy: boolean;
}

export function DocumentWorkspace({
  meeting,
  stage,
  readiness,
  elapsed,
  recentlyFinalized,
  processingStatus,
  onChange,
  onStartRecording,
  onConfigureTranscription,
  onOpenPermissions,
  onGenerateSummary,
  onCancelSummary,
  onRetryVisualSummary,
  summaryBusy
}: DocumentWorkspaceProps) {
  const summaryIntervalSeconds = useMeetingStore((state) => state.preferences.summaryIntervalSeconds);
  const profiles = useMeetingStore((state) => state.profiles);
  const visualCapable = profiles.some((profile) => profile.kind === "llm" && profile.enabled
    && profile.options.visualSummaryEnabled && profile.options.visualSummaryVerifiedAt);
  const hasOrdinarySummary = meeting.summary.keyPoints.length > 0
    || meeting.summary.decisions.length > 0
    || meeting.summary.actionItems.length > 0
    || meeting.summary.openQuestions.length > 0
    || meeting.summary.risks.length > 0
    || meeting.summary.nextSteps.length > 0;
  const [summaryView, setSummaryView] = useState<"normal" | "visual">("normal");
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
  // 同时抽取纯文本行更新 notes（供搜索与 AI 总结使用）。
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
    setSummaryView(stage === "review" && meeting.summary.visualSummary && !meeting.summary.visualSummary.stale ? "visual" : "normal");
  }, [meeting.id, stage]);

  useEffect(() => {
    if (stage === "review" && meeting.summary.visualSummary && !meeting.summary.visualSummary.stale) setSummaryView("visual");
  }, [meeting.summary.visualSummary?.generatedAt, stage]);

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

  return (
    <div className="document-scroll">
      <article className={`meeting-document meeting-document--${stage} ${summaryView === "visual" ? "meeting-document--visual" : ""}`}>
        <div className="document-date document-date--workspace-meta">
          {formatMeetingDate(meeting.scheduledAt)}
          <span>·</span>
          <input
            className="participants-editor"
            aria-label="参与者"
            value={meeting.participants.join("、")}
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
              <span className="eyebrow">会前准备</span>
              <h1 id="preparation-title">一切就绪后，直接开始记录</h1>
              <p>先确认录音范围、权限和转写方式。缺少转写服务不会影响本地录音。</p>
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
                    <p>{item.detail}</p>
                  </div>
                  {item.id === "microphone" && readiness.microphoneNeedsAttention && (
                    <button className="text-button" onClick={onOpenPermissions}>查看授权</button>
                  )}
                  {item.id === "transcription" && !readiness.hasTranscription && (
                    <button className="text-button" onClick={onConfigureTranscription}>配置转写</button>
                  )}
                </div>
              ))}
            </div>
            <button className="preparation-start" onClick={() => void onStartRecording()}>
              <Microphone size={20} weight="fill" />
              <span><strong>开始录音</strong><small>{meeting.mode === "online" ? "记录麦克风与系统音频" : "记录现场麦克风声音"}</small></span>
              <CaretRight size={18} weight="bold" />
            </button>
          </section>
        )}

        {stage === "live" && (
          <section className="live-context" aria-label="本次会议目标">
            <span><i />正在记录</span>
            <div>
              {meeting.goals.length
                ? meeting.goals.slice(0, 3).map((goal) => <span key={goal}>{goal}</span>)
                : <span>先专注记录，目标可以随时补充</span>}
            </div>
          </section>
        )}

        {stage === "review" && (
          <section className={`review-hero ${recentlyFinalized || processingStatus ? "is-fresh" : ""}`}>
            <div>
              <span className="eyebrow">{processingStatus ? "录音处理中" : "会后整理"}</span>
              <h1>{processingStatus || (recentlyFinalized ? "录音已安全保存" : "把讨论收束成清晰结果")}</h1>
              <p>{processingStatus
                ? "处理会在后台继续，你可以先补充笔记或查看已经出现的转写。"
                : meeting.summary.stale
                  ? "转写或笔记有了新内容，更新纪要后再确认行动项。"
                  : summaryView === "visual" && meeting.summary.visualSummary && !meeting.summary.visualSummary.stale
                    ? "视觉版已基于普通纪要生成；切回普通纪要可以继续编辑结论与行动项。"
                  : hasOrdinarySummary
                    ? `已整理 ${meeting.summary.keyPoints.length} 条结论和 ${meeting.summary.actionItems.length} 个行动项。`
                    : "录音和个人记录已保留；需要时再生成最终纪要。"}</p>
            </div>
            {!processingStatus && (summaryBusy ? (
              <button className="button button--secondary" onClick={onCancelSummary}><XCircle size={16} />取消生成</button>
            ) : (
              <button className="button button--primary" onClick={onGenerateSummary}>
                <ArrowClockwise size={16} />{meeting.summary.stale ? "更新纪要" : hasOrdinarySummary ? "重新生成纪要" : "生成最终纪要"}
              </button>
            ))}
          </section>
        )}

        {stage === "review" && (
          <div className="summary-view-switch" role="tablist" aria-label="纪要显示方式">
            <button role="tab" aria-selected={summaryView === "normal"} className={summaryView === "normal" ? "is-active" : ""} onClick={() => setSummaryView("normal")}>
              <FileText size={15} />普通纪要
            </button>
            <button role="tab" aria-selected={summaryView === "visual"} className={summaryView === "visual" ? "is-active" : ""} onClick={() => setSummaryView("visual")}>
              <Sparkle size={15} />视觉纪要
              {meeting.summary.visualSummary && !meeting.summary.visualSummary.stale && <span />}
            </button>
          </div>
        )}

        {stage === "review" && summaryView === "visual" && (
          <div className="content-view-enter">
            <VisualSummaryView
              meeting={meeting}
              visual={meeting.summary.visualSummary}
              capable={Boolean(visualCapable)}
              busy={summaryBusy}
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

        <DocumentSection
          kind="summary"
          icon={<FileText size={20} weight="duotone" />}
          title={stage === "live" ? "会议进展" : "关键结论"}
          badge={
            <span className="summary-cadence">
              <i /> {meeting.summary.keyPoints.length
                ? meeting.summary.generationMode === "local" ? "本机基础归纳" : "AI 自动整理"
                : "尚未生成"}{stage === "live" ? ` · 约每 ${formatInterval(summaryIntervalSeconds)}` : ""}
            </span>
          }
          action={stage === "review" ? undefined :
            summaryBusy ? (
              <button className="text-button" onClick={onCancelSummary} title="中止这次总结请求">
                <XCircle size={15} />取消生成
              </button>
            ) : (
              <button className="text-button" onClick={onGenerateSummary}>
                <ArrowClockwise size={15} />
                {meeting.summary.stale
                  ? "更新纪要"
                  : stage === "live"
                    ? "立即总结"
                    : "生成最终纪要"}
              </button>
            )
          }
        >
          {meeting.summary.stale && (
            <div className="summary-stale">
              转录或笔记已修改，当前纪要需要更新。
            </div>
          )}
          <div className="summary-timeline">
            {meeting.summary.keyPoints.length ? meeting.summary.keyPoints.map((item, index) => (
              <div
                key={`kp-${index}`}
                className={`${summaryMotion.lists.keyPoints[index] === "added" ? "is-new content-motion-enter" : summaryMotion.lists.keyPoints[index] === "updated" ? "content-motion-update" : ""}`}
                style={{ animationDelay: `${Math.min(index, 3) * 30}ms` }}
              >
                <time>{index + 1}</time>
                <textarea
                  aria-label={`编辑纪要 ${index + 1}`}
                  value={item}
                  rows={Math.max(1, Math.ceil(item.length / 54))}
                  onChange={(event) => setSummaryList(
                    "keyPoints",
                    meeting.summary.keyPoints.map((value, itemIndex) =>
                          itemIndex === index ? event.target.value : value),
                    index
                  )}
                />
                <button
                  className={`icon-button summary-lock ${meeting.summary.manualLocks?.includes(`keyPoints:${index}`) ? "is-locked" : ""}`}
                  aria-label={meeting.summary.manualLocks?.includes(`keyPoints:${index}`) ? "解除锁定，允许 AI 更新这条要点" : "锁定这条要点，AI 重新生成时不覆盖"}
                  title={meeting.summary.manualLocks?.includes(`keyPoints:${index}`) ? "已锁定：AI 不覆盖。点击解锁。" : "未锁定。点击锁定后 AI 不覆盖这条。"}
                  onClick={() => onChange({
                    ...meeting,
                    summary: toggleSummaryLock(meeting.summary, `keyPoints:${index}`)
                  })}
                >
                  {meeting.summary.manualLocks?.includes(`keyPoints:${index}`)
                    ? <Lock size={13} weight="fill" />
                    : <LockOpen size={13} />}
                </button>
                {summaryMotion.lists.keyPoints[index] === "added" && <span className="content-status-enter">新增</span>}
              </div>
            )) : (
              <div className="section-empty">转录产生后，这里会归纳关键结论与进展，不会重复抄录原文。</div>
            )}
          </div>
        </DocumentSection>

        <DocumentSection kind="actions" icon={<CheckSquare size={20} weight="duotone" />} title="行动项">
          <div className="action-table">
            <div className="action-table__head">
              <span>任务</span><span>负责人</span><span>截止时间</span><span>状态</span>
            </div>
            {meeting.summary.actionItems.length ? meeting.summary.actionItems.map((item) => {
              const actionLocked = meeting.summary.manualLocks?.includes(`action:${item.id}`) ?? false;
              return (
              <div
                className={`action-row ${enteringActionIds.has(item.id) || summaryMotion.actions[item.id] === "added" ? "content-motion-enter" : summaryMotion.actions[item.id] === "updated" ? "content-motion-update" : ""}`}
                key={item.id}
              >
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
            }) : (
              <div className="section-empty">暂无行动项。</div>
            )}
            <button
              className="text-button action-add"
              onClick={() => {
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
              }}
            >
              <Plus size={14} />添加行动项
            </button>
          </div>
        </DocumentSection>

        <DocumentSection kind="details" icon={<CheckSquare size={20} weight="duotone" />} title="决策、问题与下一步">
          <div className="summary-detail-grid">
            <EditableSummaryList title="已确认决策" values={meeting.summary.decisions} motionKinds={summaryMotion.lists.decisions} locks={meeting.summary.manualLocks} lockKey="decisions" onToggleLock={(key) => onChange({ ...meeting, summary: toggleSummaryLock(meeting.summary, key) })} onChange={(values, index) => setSummaryList("decisions", values, index)} />
            <EditableSummaryList title="未决问题" values={meeting.summary.openQuestions} motionKinds={summaryMotion.lists.openQuestions} locks={meeting.summary.manualLocks} lockKey="openQuestions" onToggleLock={(key) => onChange({ ...meeting, summary: toggleSummaryLock(meeting.summary, key) })} onChange={(values, index) => setSummaryList("openQuestions", values, index)} />
            <EditableSummaryList title="风险" values={meeting.summary.risks} motionKinds={summaryMotion.lists.risks} locks={meeting.summary.manualLocks} lockKey="risks" onToggleLock={(key) => onChange({ ...meeting, summary: toggleSummaryLock(meeting.summary, key) })} onChange={(values, index) => setSummaryList("risks", values, index)} />
            <EditableSummaryList title="下一步" values={meeting.summary.nextSteps} motionKinds={summaryMotion.lists.nextSteps} locks={meeting.summary.manualLocks} lockKey="nextSteps" onToggleLock={(key) => onChange({ ...meeting, summary: toggleSummaryLock(meeting.summary, key) })} onChange={(values, index) => setSummaryList("nextSteps", values, index)} />
          </div>
        </DocumentSection>
      </article>
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
              rows={2}
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
function markdownToHtml(markdown: string) {
  const rendered = marked.parse(markdown || "", { async: false, gfm: true });
  return DOMPurify.sanitize(String(rendered), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed"]
  }) || "<p></p>";
}

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
