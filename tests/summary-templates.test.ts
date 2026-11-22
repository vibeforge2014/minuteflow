import { describe, expect, it } from "vitest";
import { SUMMARY_TEMPLATES, SUMMARY_TEMPLATE_IDS, summaryTemplateById } from "../shared/summary-templates.mjs";
import { buildSummaryPrompt } from "../electron/services/providers.mjs";

const baseInput = {
  title: "周会",
  participants: ["我", "发言人 2"],
  goals: ["对齐进度"],
  notes: [],
  transcript: [
    { startMs: 0, endMs: 4_000, speakerName: "我", text: "先同步一下本周进展。" },
    { startMs: 4_000, endMs: 9_000, speakerName: "发言人 2", text: "接口联调还差风控白名单。" }
  ],
  previousSummary: {}
};

describe("meeting summary templates", () => {
  it("exposes four stable presets with matching ids", () => {
    expect(SUMMARY_TEMPLATE_IDS).toEqual(["general", "weekly", "interview", "retro"]);
    expect(SUMMARY_TEMPLATES.map((template) => template.label)).toEqual(["通用会议", "周会同步", "访谈调研", "项目复盘"]);
  });

  it("falls back to the general template for unknown ids", () => {
    expect(summaryTemplateById(undefined).id).toBe("general");
    expect(summaryTemplateById("nope").id).toBe("general");
  });

  it("injects the selected template guidance without changing the JSON contract", () => {
    const weekly = buildSummaryPrompt({ ...baseInput, template: "weekly" }, true);
    expect(weekly).toContain("本次纪要模板：周会同步");
    expect(weekly).toContain("本期进展");
    expect(weekly).toContain("结构：topics, keyPoints, decisions, actionItems, openQuestions, risks, nextSteps");
    const retro = buildSummaryPrompt({ ...baseInput, template: "retro" }, true);
    expect(retro).toContain("本次纪要模板：项目复盘");
    expect(retro).toContain("根因");
  });

  it("defaults to the general template when none is chosen", () => {
    const prompt = buildSummaryPrompt(baseInput, false);
    expect(prompt).toContain("本次纪要模板：通用会议");
    expect(prompt).toContain("请只根据新增内容更新滚动纪要");
  });

  it.each([false, true])("uses the edited meeting topic as context (final: %s)", (final) => {
    const prompt = buildSummaryPrompt({ ...baseInput, title: "登录改版与灰度发布评审" }, final);
    expect(prompt).toContain("当前会议主题：登录改版与灰度发布评审");
    expect(prompt).toContain("结论、决策和行动项须有会议内容支撑");
  });
});
