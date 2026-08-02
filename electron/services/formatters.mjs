export const formatTime = (ms) => {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export function markdown(meeting) {
  const summary = meeting.summary ?? {};
  const list = (items) => items?.length ? items.map((item) => `- ${item}`).join("\n") : "- 暂无";
  const actions = summary.actionItems?.length
    ? summary.actionItems.map((item) => `- [${item.done ? "x" : " "}] ${item.title}｜负责人：${item.owner || "待确认"}｜截止：${item.dueDate || "待确认"}`).join("\n")
    : "- 暂无";
  return `# ${meeting.title}

- 时间：${meeting.scheduledAt}
- 参与者：${meeting.participants.join("、") || "未填写"}
- 时长：${formatTime(meeting.durationSeconds * 1000)}

## 会议目标
${list(meeting.goals)}

## 我的记录
${list(meeting.notes)}

## 关键要点
${list(summary.keyPoints)}

## 已确认决策
${list(summary.decisions)}

## 行动项
${actions}

## 未决问题
${list(summary.openQuestions)}

## 风险
${list(summary.risks)}

## 下一步
${list(summary.nextSteps)}

## 完整转录
${meeting.transcript.map((item) => `- [${formatTime(item.startMs)}] **${item.speakerName}**：${item.text}`).join("\n") || "- 暂无"}
`;
}

export function subtitle(meeting, type) {
  const timestamp = (ms, separator) => {
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1000);
    const millis = totalMs % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
  };
  if (type === "vtt") {
    return `WEBVTT\n\n${meeting.transcript.map((item) => `${timestamp(item.startMs, ".")} --> ${timestamp(item.endMs, ".")}\n${item.speakerName}：${item.text}`).join("\n\n")}\n`;
  }
  return `${meeting.transcript.map((item, index) => `${index + 1}\n${timestamp(item.startMs, ",")} --> ${timestamp(item.endMs, ",")}\n${item.speakerName}：${item.text}`).join("\n\n")}\n`;
}
