/**
 * 会议内容的文字格式化（渲染层导出预览与主进程导出共用同一实现）。
 *
 * 之所以放在 shared/：导出前的预览必须和最终写盘的文件说同一句话——
 * 如果预览自己再拼一遍 Markdown，参数一多就一定会和导出结果漂移。
 *
 * 主要导出：formatTime、markdown、subtitle、exportNameSuffix。
 */

/** 毫秒 → HH:mm:ss（会议时长与转录时间戳共用）。 */
export const formatTime = (ms) => {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/** 导出范围：all=纪要+转写，summary=只导出纪要，transcript=只导出逐字稿。 */
const normalizeScope = (scope) => (scope === "summary" || scope === "transcript" ? scope : "all");

export const scopeLabel = (scope) => {
  const normalized = normalizeScope(scope);
  if (normalized === "summary") return "纪要";
  if (normalized === "transcript") return "转写";
  return "";
};

/**
 * 文件名后缀：按交付物区分，避免同一场会议的「纪要」和「转写」导出成同名文件互相覆盖。
 * @param {string} scope all / summary / transcript
 */
export function exportNameSuffix(scope) {
  const label = scopeLabel(scope);
  return label ? `-${label}` : "";
}

/**
 * 把会议渲染为 Markdown 文档。
 * options.scope 控制包含哪些部分；options.includeTimestamps / includeSpeakers
 * 只作用于逐字稿部分（纪要部分本来就没有时间戳与发言人前缀）。
 * @param {object} meeting 完整会议对象
 * @param {{scope?: string, includeTimestamps?: boolean, includeSpeakers?: boolean}} [options]
 * @returns {string} Markdown 文本
 */
export function markdown(meeting, options = {}) {
  const scope = normalizeScope(options.scope);
  const includeTimestamps = options.includeTimestamps !== false;
  const includeSpeakers = options.includeSpeakers !== false;
  const summary = meeting.summary ?? {};
  const list = (items) => (items?.length ? items.map((item) => `- ${item}`).join("\n") : "- 暂无");
  const actions = summary.actionItems?.length
    ? summary.actionItems.map((item) => `- [${item.done ? "x" : " "}] ${item.title}｜负责人：${item.owner || "待确认"}｜截止：${item.dueDate || "待确认"}`).join("\n")
    : "- 暂无";

  const blocks = [
    `# ${meeting.title}`,
    [
      `- 时间：${meeting.scheduledAt}`,
      `- 参与者：${meeting.participants.join("、") || "未填写"}`,
      `- 时长：${formatTime(meeting.durationSeconds * 1000)}`
    ].join("\n")
  ];

  if (scope !== "transcript") {
    blocks.push(
      ["## 会议目标", list(meeting.goals)].join("\n"),
      ["## 我的记录", list(meeting.notes)].join("\n"),
      ["## 关键要点", list(summary.keyPoints)].join("\n"),
      ["## 已确认决策", list(summary.decisions)].join("\n"),
      ["## 行动项", actions].join("\n"),
      ["## 未决问题", list(summary.openQuestions)].join("\n"),
      ["## 风险", list(summary.risks)].join("\n"),
      ["## 下一步", list(summary.nextSteps)].join("\n")
    );
  }

  if (scope !== "summary") {
    const lines = meeting.transcript.map((item) => {
      const time = includeTimestamps ? `[${formatTime(item.startMs)}] ` : "";
      const speaker = includeSpeakers ? `**${item.speakerName}**：` : "";
      return `- ${time}${speaker}${item.text}`;
    });
    blocks.push(["## 完整转录", lines.join("\n") || "- 暂无"].join("\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}

/**
 * 把转录生成字幕文本。
 * @param {object} meeting 会议对象
 * @param {"srt"|"vtt"} type SRT 用逗号毫秒并带序号，VTT 用点毫秒并带 WEBVTT 头
 * @param {{includeSpeakers?: boolean}} [options] 是否在字幕正文前加「发言人：」
 * @returns {string} 字幕文件内容
 */
export function subtitle(meeting, type, options = {}) {
  const includeSpeakers = options.includeSpeakers !== false;
  const timestamp = (ms, separator) => {
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1000);
    const millis = totalMs % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
  };
  const body = (item) => `${includeSpeakers ? `${item.speakerName}：` : ""}${item.text}`;
  if (type === "vtt") {
    return `WEBVTT\n\n${meeting.transcript.map((item) => `${timestamp(item.startMs, ".")} --> ${timestamp(item.endMs, ".")}\n${body(item)}`).join("\n\n")}\n`;
  }
  return `${meeting.transcript.map((item, index) => `${index + 1}\n${timestamp(item.startMs, ",")} --> ${timestamp(item.endMs, ",")}\n${body(item)}`).join("\n\n")}\n`;
}
