/**
 * 导出对话框：按「交付物」组织，而不是按文件格式堆菜单。
 *
 * 四个意图——纪要文档、原文转写、字幕、音频与备份——各自给出可选格式；
 * 选中后在右侧直接看到将要写进文件的内容，并可切换「带时间戳 / 带发言人」，
 * 避免用户先导出、再打开文件才发现格式不对。
 *
 * 预览与最终文件使用同一份排版实现（shared/export-formatters.mjs），
 * 因此预览不会和实际导出结果漂移。文件写入仍由主进程 exports:save 完成。
 */
import { useMemo, useState } from "react";
import {
  BracketsCurly,
  Export,
  FileDoc,
  FilePdf,
  FileText,
  ImageSquare,
  Package,
  Subtitles,
  Waveform,
  X
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { ExportOptions, Meeting } from "../types";
import { api } from "../lib/api";
import { markdown, subtitle } from "../../shared/export-formatters.mjs";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useExitPresence } from "../hooks/useExitPresence";

type IconType = ComponentType<{ size?: number; weight?: "regular" | "fill" | "duotone" }>;

interface ExportItem {
  /** 组内唯一键（同格式不同范围是两项）。 */
  key: string;
  format: string;
  label: string;
  hint: string;
  icon: IconType;
  scope?: ExportOptions["scope"];
  /** 没有录音文件时不可选。 */
  needsAudio?: boolean;
  /** 仅当视觉纪要就绪时出现。 */
  needsVisual?: boolean;
}

interface ExportGroup {
  id: string;
  label: string;
  description: string;
  items: ExportItem[];
}

const GROUPS: ExportGroup[] = [
  {
    id: "summary",
    label: "纪要文档",
    description: "给同事看的决策与行动项",
    items: [
      { key: "summary-docx", format: "docx", label: "Word 文档", hint: "可继续编辑，适合发到群里或归档", icon: FileDoc, scope: "summary" },
      { key: "summary-pdf", format: "pdf", label: "PDF", hint: "版式固定，适合打印或对外发送", icon: FilePdf, scope: "summary" },
      { key: "summary-md", format: "md", label: "Markdown", hint: "贴进语雀 / Notion / 仓库文档", icon: FileText, scope: "summary" }
    ]
  },
  {
    id: "transcript",
    label: "原文转写",
    description: "逐字稿，保留时间与发言人",
    items: [
      { key: "transcript-md", format: "md", label: "Markdown", hint: "带时间戳与发言人，便于检索", icon: FileText, scope: "transcript" },
      { key: "transcript-txt", format: "txt", label: "纯文本", hint: "只有正文，适合二次处理", icon: FileText, scope: "transcript" },
      { key: "transcript-docx", format: "docx", label: "Word 文档", hint: "要做批注或交给行政归档", icon: FileDoc, scope: "transcript" }
    ]
  },
  {
    id: "subtitle",
    label: "字幕",
    description: "可直接拖进剪辑软件",
    items: [
      { key: "subtitle-srt", format: "srt", label: "SRT 字幕", hint: "剪映 / PR / 播放器通用", icon: Subtitles },
      { key: "subtitle-vtt", format: "vtt", label: "VTT 字幕", hint: "网页播放器与在线课程", icon: Subtitles }
    ]
  },
  {
    id: "media",
    label: "音频与备份",
    description: "原始录音与完整资料",
    items: [
      { key: "media-audio", format: "audio", label: "原始音频", hint: "不转码、不重新封装", icon: Waveform, needsAudio: true },
      { key: "media-zip", format: "zip", label: "完整备份包", hint: "纪要 + 转写 + 字幕 + 录音", icon: Package },
      { key: "media-json", format: "json", label: "结构化 JSON", hint: "接入自建系统或做数据分析", icon: BracketsCurly }
    ]
  },
  {
    id: "visual",
    label: "视觉纪要",
    description: "已生成的图示版纪要",
    items: [
      { key: "visual-png", format: "visual-png", label: "PNG 长图", hint: "适合直接发到群里", icon: ImageSquare, needsVisual: true }
    ]
  }
];

const PREVIEW_LIMIT = 2_600;

export function ExportDialog({
  open,
  meeting,
  hasAudio,
  onClose,
  onDone,
  onError,
  onPremiumRequired
}: {
  /** 由外层控制显隐：关闭时播放收回动画后再卸载。 */
  open: boolean;
  meeting: Meeting;
  /** 是否存在可导出的录音文件：决定「原始音频」是否可选。 */
  hasAudio: boolean;
  onClose(): void;
  onDone(message: string): void;
  onError(message: string): void;
  /** 返回 true 表示已授权；false 表示已弹出付费墙。 */
  onPremiumRequired(reason: string, resume: () => void): boolean;
}) {
  const { mounted, closing } = useExitPresence(open, 170);
  const dialogRef = useDialogFocus<HTMLElement>(open, { onEscape: onClose, initialFocus: ".export-dialog__actions .button--primary" });
  const [selectedKey, setSelectedKey] = useState("summary-docx");
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [includeSpeakers, setIncludeSpeakers] = useState(true);
  const [busy, setBusy] = useState(false);

  const visualReady = Boolean(meeting.summary.visualSummary && !meeting.summary.visualSummary.stale);
  const groups = useMemo(
    () => GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => (!item.needsAudio || hasAudio) && (!item.needsVisual || visualReady))
      }))
      .filter((group) => group.items.length > 0),
    [hasAudio, visualReady]
  );
  const selected = groups.flatMap((group) => group.items).find((item) => item.key === selectedKey) ?? groups[0]?.items[0];
  const group = groups.find((candidate) => candidate.items.some((item) => item.key === selected?.key));

  /** 预览文本：与导出共用同一排版实现；不可预览的二进制格式给结构性说明。 */
  const preview = useMemo(() => {
    if (!selected) return null;
    if (selected.format === "audio") return null;
    if (selected.format === "zip") {
      return `完整备份包内包含：\n- ${meeting.title}.md（纪要 + 完整转写）\n- ${meeting.title}.json（结构化数据）\n- ${meeting.title}.srt（字幕）\n${hasAudio ? "- audio/（原始录音文件）" : "- 无录音文件"}`;
    }
    if (selected.format === "json") {
      return JSON.stringify(meeting, null, 2).slice(0, PREVIEW_LIMIT);
    }
    if (selected.format === "visual-png") return null;
    if (selected.format === "srt" || selected.format === "vtt") {
      return subtitle(meeting, selected.format, { includeSpeakers });
    }
    return markdown(meeting, {
      scope: selected.scope ?? "all",
      includeTimestamps,
      includeSpeakers
    });
  }, [meeting, selected, includeSpeakers, includeTimestamps, hasAudio]);

  const transcriptOptions = selected?.scope === "transcript";
  const speakerOption = transcriptOptions || selected?.format === "srt" || selected?.format === "vtt";

  if (!mounted || !selected) return null;

  const runExport = async () => {
    setBusy(true);
    try {
      const result = await api.exports.save(meeting, selected.format, {
        scope: selected.scope,
        includeTimestamps,
        includeSpeakers
      });
      if (!result.canceled) {
        // 多轨录音一次导出会写出多个文件：提示里说清条数，避免用户以为只导出了第一条。
        const writtenFileCount = result.filePaths?.length ?? 0;
        onDone(writtenFileCount > 1
          ? `已导出 ${writtenFileCount} 条音轨（文件名以轨道区分）。`
          : `已导出${selected.label}。`);
        onClose();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "导出失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const startExport = () => {
    // 激活成功后由付费墙的 resume 直接继续导出，不必让用户重新选一遍。
    if (!onPremiumRequired("导出会议文档与完整备份", () => void runExport())) return;
    void runExport();
  };

  return (
    <div
      className={`modal-backdrop ${closing ? "is-closing" : ""}`}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <header className="export-dialog__header">
          <div>
            <h2 id="export-dialog-title"><Export size={18} weight="duotone" />导出会议</h2>
            <p>{meeting.title}</p>
          </div>
          <button className="icon-button" aria-label="关闭导出" onClick={onClose}><X size={17} /></button>
        </header>

        <div className="export-dialog__body">
          <nav className="export-dialog__groups" aria-label="选择导出交付物">
            {groups.map((candidate) => (
              <div className="export-dialog__group" key={candidate.id}>
                <div className="export-dialog__group-head">
                  <strong>{candidate.label}</strong>
                  <span>{candidate.description}</span>
                </div>
                {candidate.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.key === selected.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`export-dialog__item ${active ? "is-active" : ""}`}
                      aria-pressed={active}
                      onClick={() => setSelectedKey(item.key)}
                    >
                      <Icon size={17} weight={active ? "fill" : "regular"} />
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.hint}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="export-dialog__preview" aria-live="polite">
            <div className="export-dialog__preview-head">
              <strong>{group?.label} · {selected.label}</strong>
              <span>{selected.hint}</span>
            </div>
            {preview === null ? (
              <p className="export-dialog__preview-empty">
                {selected.format === "audio"
                  ? "将原样复制这份会议的录音文件，不做转码或重新封装；麦克风与系统声音两条轨会分别导出。"
                  : "视觉纪要会渲染成一张可分享的长图，内容来自已确认的纪要。"}
              </p>
            ) : (
              <pre className="export-dialog__preview-text">{preview.slice(0, PREVIEW_LIMIT)}</pre>
            )}
            {(transcriptOptions || speakerOption) && (
              <div className="export-dialog__options">
                {transcriptOptions && (
                  <label>
                    <input
                      type="checkbox"
                      checked={includeTimestamps}
                      onChange={(event) => setIncludeTimestamps(event.target.checked)}
                    />
                    带时间戳
                  </label>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={includeSpeakers}
                    onChange={(event) => setIncludeSpeakers(event.target.checked)}
                  />
                  带发言人
                </label>
                <span>字幕格式始终保留时间轴。</span>
              </div>
            )}
          </div>
        </div>

        <footer className="export-dialog__actions">
          <span className="export-dialog__note">文件保存到你选择的位置，不会上传云端。</span>
          <button className="button" onClick={onClose}>取消</button>
          <button className="button button--primary" disabled={busy} onClick={startExport}>
            {busy ? "正在导出…" : `导出${selected.label}`}
          </button>
        </footer>
      </section>
    </div>
  );
}
