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
      <button onClick={() => exportFormat("md")}><FileText size={17} /><span>Markdown<small>适合继续编辑</small></span></button>
      <button onClick={() => exportFormat("txt")}><FileText size={17} /><span>纯文本<small>通用文字备份</small></span></button>
      <button onClick={() => exportFormat("pdf")}><FilePdf size={17} /><span>PDF<small>适合分享和归档</small></span></button>
      {meeting.summary.visualSummary && !meeting.summary.visualSummary.stale && <button onClick={() => exportFormat("visual-png")}><ImageSquare size={17} /><span>视觉纪要图<small>PNG 信息图，适合直接分享</small></span></button>}
      <button onClick={() => exportFormat("docx")}><FileDoc size={17} /><span>Word 文档<small>保留会议结构</small></span></button>
      <button onClick={() => exportFormat("srt")}><Subtitles size={17} /><span>SRT 字幕<small>带时间轴的转录</small></span></button>
      <button onClick={() => exportFormat("vtt")}><Subtitles size={17} /><span>VTT 字幕<small>适合网页播放器</small></span></button>
      <button onClick={() => exportFormat("json")}><BracketsCurly size={17} /><span>结构化 JSON<small>用于迁移和二次处理</small></span></button>
      <button onClick={() => exportFormat("zip")}><Package size={17} /><span>完整备份包<small>纪要、转录与结构化数据</small></span></button>
    </div>
  );
}
