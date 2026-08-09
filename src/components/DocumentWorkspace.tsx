import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CheckSquare,
  Eye,
  FileArrowUp,
  FileText,
  LinkSimple,
  ListBullets,
  NotePencil,
  PencilSimple,
  Plus,
  Target
} from "@phosphor-icons/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import DOMPurify from "dompurify";
import { marked } from "marked";
import TurndownService from "turndown";
import type { Meeting } from "../types";
import { api } from "../lib/api";
import { lockSummaryField } from "../lib/summary";
import { formatDuration, formatInterval } from "../lib/format";
import { useMeetingStore } from "../store/meetingStore";

interface DocumentWorkspaceProps {
  meeting: Meeting;
  onChange(meeting: Meeting): void;
  onGenerateSummary(): void;
  summaryBusy: boolean;
}

export function DocumentWorkspace({
  meeting,
  onChange,
  onGenerateSummary,
  summaryBusy
}: DocumentWorkspaceProps) {
  const summaryIntervalSeconds = useMeetingStore((state) => state.preferences.summaryIntervalSeconds);
  const [noteMode, setNoteMode] = useState<"rich" | "markdown" | "preview">("rich");
  const [importedFile, setImportedFile] = useState<string | null>(null);
  const meetingRef = useRef(meeting);
  const onChangeRef = useRef(onChange);
  meetingRef.current = meeting;
  onChangeRef.current = onChange;
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

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const next = markdownToHtml(meetingMarkdown(meeting));
    if (editor.getHTML() !== next) editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, meeting.id, meeting.notes, meeting.notesMarkdown]);

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

  const setStringList = (key: "goals", values: string[]) =>
    onChange({ ...meeting, [key]: values });

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
      <article className="meeting-document">
        <div className="document-date">
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
        <h1>{meeting.title}</h1>

        <DocumentSection icon={<Target size={20} weight="duotone" />} title="会议目标">
          <EditableList
            values={meeting.goals}
            placeholder="添加会议目标"
            onChange={(values) => setStringList("goals", values)}
          />
        </DocumentSection>

        <DocumentSection icon={<NotePencil size={20} weight="duotone" />} title="我的记录">
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
                onClick={() => editor?.chain().focus().insertContent(`[${formatDuration(meeting.durationSeconds)}] `).run()}
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
          icon={<FileText size={20} weight="duotone" />}
          title="实时纪要"
          badge={
            <span className="summary-cadence">
              <i /> 每 {formatInterval(summaryIntervalSeconds)} 更新
            </span>
          }
          action={
            <button
              className="text-button"
              onClick={onGenerateSummary}
              disabled={summaryBusy}
            >
              <ArrowClockwise size={15} className={summaryBusy ? "spin" : ""} />
              {meeting.summary.stale ? "更新纪要" : "立即总结"}
            </button>
          }
        >
          {meeting.summary.stale && (
            <div className="summary-stale">
              转录或笔记已修改，当前纪要需要更新。
            </div>
          )}
          <div className="summary-timeline">
            {meeting.summary.keyPoints.length ? meeting.summary.keyPoints.map((item, index) => (
              <div key={`kp-${index}`} className={index >= meeting.summary.keyPoints.length - 3 ? "is-new" : ""}>
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
                {index >= meeting.summary.keyPoints.length - 3 && <span>新增</span>}
              </div>
            )) : (
              <div className="section-empty">开始录音后，AI 会在这里整理关键进展。</div>
            )}
          </div>
        </DocumentSection>

        <DocumentSection icon={<CheckSquare size={20} weight="duotone" />} title="行动项">
          <div className="action-table">
            <div className="action-table__head">
              <span>任务</span><span>负责人</span><span>截止时间</span><span>状态</span>
            </div>
            {meeting.summary.actionItems.length ? meeting.summary.actionItems.map((item) => (
              <div className="action-row" key={item.id}>
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
              </div>
            )) : (
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

        <DocumentSection icon={<CheckSquare size={20} weight="duotone" />} title="决策、问题与下一步">
          <div className="summary-detail-grid">
            <EditableSummaryList title="已确认决策" values={meeting.summary.decisions} onChange={(values, index) => setSummaryList("decisions", values, index)} />
            <EditableSummaryList title="未决问题" values={meeting.summary.openQuestions} onChange={(values, index) => setSummaryList("openQuestions", values, index)} />
            <EditableSummaryList title="风险" values={meeting.summary.risks} onChange={(values, index) => setSummaryList("risks", values, index)} />
            <EditableSummaryList title="下一步" values={meeting.summary.nextSteps} onChange={(values, index) => setSummaryList("nextSteps", values, index)} />
          </div>
        </DocumentSection>
      </article>
    </div>
  );
}

function EditableSummaryList({
  title,
  values,
  onChange
}: {
  title: string;
  values: string[];
  onChange(values: string[], lockedIndex: number): void;
}) {
  return (
    <div className="summary-detail">
      <h3>{title}</h3>
      {values.length ? values.map((value, index) => (
        <textarea
          key={`${title}-${index}`}
          aria-label={`编辑${title} ${index + 1}`}
          rows={2}
          value={value}
          onChange={(event) => onChange(
            values.map((item, itemIndex) => itemIndex === index ? event.target.value : item),
            index
          )}
        />
      )) : <span>暂无</span>}
      <button
        className="text-button summary-detail__add"
        onClick={() => onChange([...values, `新的${title}`], values.length)}
      >
        <Plus size={13} />添加
      </button>
    </div>
  );
}

function DocumentSection({
  icon,
  title,
  badge,
  action,
  children
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="document-section">
      <header>
        <div className="document-section__title">{icon}<h2>{title}</h2>{badge}</div>
        {action}
      </header>
      {children}
    </section>
  );
}

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

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  headingStyle: "atx"
});

function meetingMarkdown(meeting: Meeting) {
  if (typeof meeting.notesMarkdown === "string") return meeting.notesMarkdown;
  return meeting.notes.map((item) => `- ${item}`).join("\n");
}

function markdownToHtml(markdown: string) {
  const rendered = marked.parse(markdown || "", { async: false, gfm: true });
  return DOMPurify.sanitize(String(rendered), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed"]
  }) || "<p></p>";
}

function htmlToMarkdown(html: string) {
  return turndown.turndown(html).trim();
}

function markdownToPlainText(markdown: string) {
  const container = document.createElement("div");
  container.innerHTML = markdownToHtml(markdown);
  return (container.textContent ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatMeetingDate(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
