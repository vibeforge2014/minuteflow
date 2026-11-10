/**
 * 导出格式菜单：按用途分组列出导出目标（文档 / 排版分享 / 字幕数据 / 备份），
 * 点击后经 api.exports.save 走主进程系统保存框（浏览器端则触发下载）。
 * 所有格式都属于付费能力，由主进程 exports:save 统一校验授权。
 * 实际的文件生成逻辑在 electron/services/exports.mjs。
 */
import { BracketsCurly, FileDoc, FilePdf, FileText, ImageSquare, Package, Subtitles } from "@phosphor-icons/react";
import { api } from "../lib/api";
import type { Meeting } from "../types";

export function ExportMenu({
  meeting,
  onClose,
  onDone,
  onError,
  onPremiumRequired
}: {
  meeting: Meeting;
  onClose(): void;
  onDone(message: string): void;
  onError(message: string): void;
  /** 返回 true 表示可以继续（已授权）；false 表示已弹出付费墙。 */
  onPremiumRequired(reason: string, resume: () => void): boolean;
}) {
  /** 导出一种格式：用户取消保存框不提示成功；失败不静默卡住菜单。 */
  const runExport = async (format: string) => {
    try {
      const result = await api.exports.save(meeting, format);
      if (!result.canceled) onDone(`已导出 ${format.toUpperCase()} 文件。`);
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : "导出失败，请稍后重试。");
      onClose();
    }
  };

  const exportFormat = (format: string) => {
    // 激活成功后由付费墙的 resume 直接继续导出，不必让用户重新打开菜单。
    if (!onPremiumRequired("导出会议文档与完整备份", () => void runExport(format))) return;
    void runExport(format);
  };

  return (
    <div className="export-menu">
      <div className="export-menu__group">
        <span className="export-menu__label">文档</span>
        <button onClick={() => exportFormat("md")}><FileText size={17} /><span>Markdown</span></button>
        <button onClick={() => exportFormat("txt")}><FileText size={17} /><span>纯文本</span></button>
      </div>
      <div className="export-menu__group">
        <span className="export-menu__label">排版与分享</span>
        <button onClick={() => exportFormat("pdf")}><FilePdf size={17} /><span>PDF</span></button>
        <button onClick={() => exportFormat("docx")}><FileDoc size={17} /><span>Word 文档</span></button>
        {meeting.summary.visualSummary && !meeting.summary.visualSummary.stale && (
          <button onClick={() => exportFormat("visual-png")}><ImageSquare size={17} /><span>视觉纪要图</span></button>
        )}
      </div>
      <div className="export-menu__group">
        <span className="export-menu__label">字幕与数据</span>
        <button onClick={() => exportFormat("srt")}><Subtitles size={17} /><span>SRT 字幕</span></button>
        <button onClick={() => exportFormat("vtt")}><Subtitles size={17} /><span>VTT 字幕</span></button>
        <button onClick={() => exportFormat("json")}><BracketsCurly size={17} /><span>结构化 JSON</span></button>
      </div>
      <div className="export-menu__group">
        <span className="export-menu__label">完整备份</span>
        <button onClick={() => exportFormat("zip")}><Package size={17} /><span>含录音的备份包</span></button>
      </div>
    </div>
  );
}
