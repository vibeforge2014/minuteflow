import { describe, expect, it } from "vitest";
import { exportNameSuffix, markdown, subtitle } from "../shared/export-formatters.mjs";

const meeting = {
  title: "周会",
  scheduledAt: "2026-11-15 10:00",
  participants: ["我", "发言人 2"],
  durationSeconds: 120,
  goals: ["对齐进度"],
  notes: ["记得补白名单"],
  summary: {
    topics: ["发布节奏"],
    keyPoints: ["风控白名单是当前唯一阻塞"],
    decisions: ["本周五冻结代码"],
    actionItems: [{ title: "补白名单", owner: "发言人 2", dueDate: "周四", done: false }],
    openQuestions: ["灰度范围多大"],
    risks: ["白名单迟到会顺延发布"],
    nextSteps: ["周四前完成联调"]
  },
  transcript: [
    { startMs: 0, endMs: 4_000, speakerName: "我", text: "先同步本周进展。" },
    { startMs: 64_000, endMs: 70_000, speakerName: "发言人 2", text: "白名单还差一个人签字。" }
  ]
};

describe("export deliverables", () => {
  it("keeps the summary and transcript together by default", () => {
    const text = markdown(meeting);
    expect(text).toContain("## 关键要点");
    expect(text).toContain("## 完整转录");
    expect(text).toContain("- [00:01:04] **发言人 2**：白名单还差一个人签字。");
  });

  it("exports a summary-only document", () => {
    const text = markdown(meeting, { scope: "summary" });
    expect(text).toContain("## 已确认决策");
    expect(text).not.toContain("## 完整转录");
  });

  it("keeps the overview and discussion sections in the minutes export", () => {
    const detailedMeeting = {
      ...meeting,
      summary: {
        ...meeting.summary,
        overview: "发布前须补齐风控白名单。",
        discussionSections: [{
          title: "发布准备",
          points: [{ heading: "风控白名单", text: "还差一人签字。" }],
          table: { columns: ["事项", "状态"], rows: [["签字", "待确认"], ["联调", "已完成"]] }
        }]
      }
    };
    const text = markdown(detailedMeeting, { scope: "summary" });
    expect(text).toContain("## 会议概览\n\n发布前须补齐风控白名单。");
    expect(text).toContain("### 发布准备");
    expect(text).toContain("| 签字 | 待确认 |");
    expect(text).toContain("- 风控白名单：还差一人签字。");
    expect(markdown(detailedMeeting, { scope: "transcript" })).not.toContain("分议题纪要");
  });

  it("escapes pipes and newlines in table cells and tolerates a table without points", () => {
    const detailedMeeting = {
      ...meeting,
      summary: {
        ...meeting.summary,
        discussionSections: [{
          title: "风险盘点",
          // 只有表格、没有 points；单元格含管道符、换行、数字和 null。
          table: { columns: ["事项", "状态"], rows: [["A|B", "待\n确认"], [42, null]] }
        }]
      }
    };
    const text = markdown(detailedMeeting, { scope: "summary" });
    expect(text).toContain("### 风险盘点");
    expect(text).toContain("| A\\|B | 待 确认 |");
    expect(text).toContain("| 42 |  |");
    // 没有 points 时不输出列表也不抛错。
    expect(text).not.toContain("- undefined");
    expect(text).toContain("## 已确认决策");
  });

  it("exports a transcript-only document with optional timestamps and speakers", () => {
    const plain = markdown(meeting, { scope: "transcript", includeTimestamps: false, includeSpeakers: false });
    expect(plain).not.toContain("## 关键要点");
    expect(plain).toContain("- 白名单还差一个人签字。");
    expect(plain).not.toContain("00:01:04");
    // 参与者一行总会带人名，这里只断言逐字稿行没有发言人前缀。
    expect(plain).not.toContain("发言人 2：");
    expect(plain).not.toContain("**发言人 2**");
  });

  it("names exports by deliverable so summary and transcript do not overwrite each other", () => {
    expect(exportNameSuffix("summary")).toBe("-纪要");
    expect(exportNameSuffix("transcript")).toBe("-转写");
    expect(exportNameSuffix("all")).toBe("");
  });

  it("can drop speaker prefixes from subtitles but keeps the timeline", () => {
    const srt = subtitle(meeting, "srt", { includeSpeakers: false });
    expect(srt).toContain("00:00:00,000 --> 00:00:04,000");
    expect(srt).toContain("先同步本周进展。");
    expect(srt).not.toContain("我：先同步本周进展。");
    const vtt = subtitle(meeting, "vtt");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("发言人 2：白名单还差一个人签字。");
  });
});
