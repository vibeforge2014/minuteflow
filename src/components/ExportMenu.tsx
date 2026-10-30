/**
 * 导出格式菜单：列出八种导出目标（md/txt/pdf/docx/srt/vtt/json/zip），
 * 点击后经 api.exports.save 走主进程系统保存框（浏览器端则触发下载）。
 * 实际的文件生成逻辑在 electron/services/exports.mjs。
 */
import { BracketsCurly, FileDoc, FilePdf, FileText, ImageSquare, Package, Subtitles } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { Meeting } from "../types";

export function ExportMenu({
  meeting,
  onClose,
  onDone
}: {
  meeting: Meeting;
  onClose(): void;
  onDone(message: string): void;
}) {
  /** 导出一种格式：用户取消保存框不提示成功。 */
  const exportFormat = async (format: string) => {
    const result = await api.exports.save(meeting, format);
    if (!result.canceled) onDone(`已导出 ${format.toUpperCase()} 文件。`);
    onClose();
  };
  return (
    <div className="export-menu">
      <button onClick={() => exportFormat("md")}><FileText size={17} /><span>Markdown</span></button>
      <button onClick={() => exportFormat("txt")}><FileText size={17} /><span>纯文本</span></button>
      <button onClick={() => exportFormat("pdf")}><FilePdf size={17} /><span>PDF</span></button>
      {meeting.summary.visualSummary && !meeting.summary.visualSummary.stale && <button onClick={() => exportFormat("visual-png")}><ImageSquare size={17} /><span>视觉纪要图</span></button>}
      <button onClick={() => exportFormat("docx")}><FileDoc size={17} /><span>Word 文档</span></button>
      <button onClick={() => exportFormat("srt")}><Subtitles size={17} /><span>SRT 字幕</span></button>
      <button onClick={() => exportFormat("vtt")}><Subtitles size={17} /><span>VTT 字幕</span></button>
      <button onClick={() => exportFormat("json")}><BracketsCurly size={17} /><span>结构化 JSON</span></button>
      <button onClick={() => exportFormat("zip")}><Package size={17} /><span>完整备份包</span></button>
    </div>
  );
}
