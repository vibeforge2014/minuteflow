/**
 * 会议导出与导入文件选择（Electron 主进程 / 服务层）。
 * 把会议渲染为 Markdown / 纯文本 / JSON / SRT / VTT / DOCX / PDF / ZIP，
 * 以及打开音视频导入文件选择器。输出排版依赖 formatters.mjs。
 * 主要导出：exportMeeting、chooseImportFiles。
 * 被 main.mjs 的 exports:save 与 imports:choose 通道调用。
 * 副作用：系统保存/打开对话框、写导出文件（PDF 借助隐藏窗口 printToPDF）。
 */
import { BrowserWindow, dialog } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { formatTime, markdown, subtitle } from "./formatters.mjs";

/** HTML 转义，防止会议内容中的尖括号破坏 PDF 导出页面结构。 */
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

/** 生成 PDF 导出用的 A4 打印页面（复用 markdown() 的文本，再转义 + 换行转 <br>）。 */
function printHtml(meeting) {
  const md = markdown(meeting);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; color:#1b1d22; line-height:1.7; font-size:13px; }
  h1 { font-size:26px; margin:0 0 18px; } h2 { font-size:17px; margin:22px 0 8px; border-bottom:1px solid #e8e9ed; padding-bottom:5px; }
  p { white-space:pre-wrap; } .content { max-width:760px; margin:auto; }
  </style></head><body><div class="content">${escapeHtml(md).replaceAll("\n", "<br>")}</div></body></html>`;
}

/** 用 docx 库把会议组装为 Word 文档 Buffer（标题 + 各章节 + 完整转录）。 */
async function docxBuffer(meeting) {
  const children = [
    new Paragraph({ text: meeting.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun(`时间：${meeting.scheduledAt}`)] }),
    new Paragraph({ children: [new TextRun(`参与者：${meeting.participants.join("、") || "未填写"}`)] })
  ];
  const section = (title, values) => {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
    for (const value of values?.length ? values : ["暂无"]) {
      children.push(new Paragraph({ text: value, bullet: { level: 0 } }));
    }
  };
  section("会议目标", meeting.goals);
  section("我的记录", meeting.notes);
  section("关键要点", meeting.summary?.keyPoints);
  section("已确认决策", meeting.summary?.decisions);
  section("行动项", meeting.summary?.actionItems?.map((item) => `${item.title}｜${item.owner || "待确认"}｜${item.dueDate || "待确认"}`));
  section("未决问题", meeting.summary?.openQuestions);
  section("完整转录", meeting.transcript.map((item) => `[${formatTime(item.startMs)}] ${item.speakerName}：${item.text}`));
  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

/**
 * 导出会议（exports:save 通道调用）。副作用：保存对话框 + 写目标文件。
 * PDF 用隐藏 BrowserWindow 加载打印页再 printToPDF（原生排版，无需外部依赖）；
 * ZIP 打包含 Markdown/JSON/SRT 及全部音频文件；用户取消对话框时返回 { canceled: true }。
 * @param {object} meeting 完整会议对象
 * @param {string} format md/txt/srt/vtt/json/docx/pdf/zip
 * @param {BrowserWindow} parentWindow 对话框的父窗口
 * @param {string[]} audioPaths 随 ZIP 附带的音频文件路径
 * @returns {Promise<{canceled: boolean, filePath?: string}>}
 */
export async function exportMeeting(meeting, format, parentWindow, audioPaths = []) {
  const extensions = {
    md: "md", txt: "txt", srt: "srt", vtt: "vtt", json: "json",
    docx: "docx", pdf: "pdf", zip: "zip"
  };
  const extension = extensions[format] ?? "md";
  const result = await dialog.showSaveDialog(parentWindow, {
    title: "导出会议",
    defaultPath: `${meeting.title}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  if (format === "pdf") {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printHtml(meeting))}`);
    const buffer = await window.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
    window.destroy();
    await writeFile(result.filePath, buffer);
  } else if (format === "docx") {
    await writeFile(result.filePath, await docxBuffer(meeting));
  } else if (format === "srt" || format === "vtt") {
    await writeFile(result.filePath, subtitle(meeting, format), "utf8");
  } else if (format === "json") {
    await writeFile(result.filePath, `${JSON.stringify(meeting, null, 2)}\n`, "utf8");
  } else if (format === "zip") {
    const zip = new JSZip();
    zip.file(`${meeting.title}.md`, markdown(meeting));
    zip.file(`${meeting.title}.json`, JSON.stringify(meeting, null, 2));
    zip.file(`${meeting.title}.srt`, subtitle(meeting, "srt"));
    for (const audioPath of audioPaths) {
      const audio = await readFile(audioPath).catch(() => null);
      if (audio) zip.file(`audio/${path.basename(audioPath)}`, audio);
    }
    await writeFile(result.filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  } else {
    await writeFile(result.filePath, markdown(meeting), "utf8");
  }
  return { canceled: false, filePath: result.filePath };
}

/**
 * 打开音视频多选对话框（imports:choose 通道调用）。
 * @returns {Promise<string[]>} 所选文件绝对路径；取消返回空数组
 */
export async function chooseImportFiles(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "导入录音或视频",
    properties: ["openFile", "multiSelections"],
    filters: [{
      name: "音频和视频",
      extensions: ["mp3", "m4a", "wav", "flac", "ogg", "webm", "mp4", "mov"]
    }]
  });
  return result.canceled ? [] : result.filePaths;
}
