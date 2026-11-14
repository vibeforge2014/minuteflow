/**
 * 转写提示词与语言锁定纯逻辑单测。
 *
 * 锁死三条会影响准确率的规则：
 * 1) prompt 在固定预算内按「语言引导 → 前文 → 术语表」组装，且绝不把术语截成半词；
 * 2) 中文块带简体引导语、英文块不带中文引导语，避免 Mandarin 默认输出繁体；
 * 3) auto 模式首块锁定语种后，后续块不再逐块重新检测（短块误判的主因）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_MAX_CHARS,
  buildTranscriptionPrompt,
  inferLanguageFromText,
  normalizeGlossary,
  normalizeLanguage,
  resolveChunkLanguage,
  tailTranscriptText,
  transcriptionLanguageForEngine
} from "../electron/services/transcription-prompt.mjs";

describe("normalizeGlossary", () => {
  it("去空、去重并丢弃误粘贴的整段文字", () => {
    expect(normalizeGlossary([" MinuteFlow ", "", "Q3 复盘", "Q3 复盘", "x".repeat(41)]))
      .toEqual(["MinuteFlow", "Q3 复盘"]);
  });

  it("非数组输入不抛错", () => {
    expect(normalizeGlossary(undefined)).toEqual([]);
    expect(normalizeGlossary("MinuteFlow")).toEqual([]);
  });
});

describe("tailTranscriptText", () => {
  it("短文本原样返回并压平空白", () => {
    expect(tailTranscriptText("  我们  下周上线  ")).toBe("我们 下周上线");
  });

  it("超长文本从最近的句首开始，不把半句话带进下一块", () => {
    const text = "第一段讨论了预算安排。".repeat(20) + "最后确认了发布时间；" + "接下来讨论风险。";
    const tail = tailTranscriptText(text, 40);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.startsWith("第一")).toBe(false);
    expect(tail).toContain("风险");
  });
});

describe("buildTranscriptionPrompt", () => {
  it("中文带简体引导语；英文与 auto 首块都不带中文引导，避免语种被 prompt 带偏", () => {
    expect(buildTranscriptionPrompt({ language: "zh" })).toContain("简体中文");
    expect(buildTranscriptionPrompt({ language: "en" })).toBe("");
    expect(buildTranscriptionPrompt({ language: "" })).toBe("");
    expect(buildTranscriptionPrompt({ language: "en", glossary: ["MinuteFlow"] })).toBe("MinuteFlow");
    expect(buildTranscriptionPrompt({ language: "", glossary: ["MinuteFlow"] })).toBe("MinuteFlow");
  });

  it("前文与术语表都进入 prompt，且顺序稳定", () => {
    const prompt = buildTranscriptionPrompt({
      language: "zh",
      previousText: "上一块确认了 Q3 复盘的时间。",
      glossary: ["MinuteFlow", "SKU"]
    });
    expect(prompt.indexOf("简体中文")).toBeLessThan(prompt.indexOf("上一块"));
    expect(prompt.indexOf("上一块")).toBeLessThan(prompt.indexOf("MinuteFlow"));
    expect(prompt).toContain("MinuteFlow，SKU");
  });

  it("严格遵守预算，且不会把某个术语截成半个词", () => {
    const prompt = buildTranscriptionPrompt({
      language: "zh",
      maxChars: 40,
      glossary: ["MinuteFlow", "Q3复盘", "一个非常非常长的专有名词为了触发预算上限"]
    });
    expect(prompt.length).toBeLessThanOrEqual(40);
    expect(prompt).toContain("MinuteFlow");
    expect(prompt).not.toContain("一个非常");
  });

  it("默认预算不超过 Whisper 的 224 token 上限", () => {
    const prompt = buildTranscriptionPrompt({
      language: "zh",
      previousText: "前文。".repeat(100),
      glossary: Array.from({ length: 200 }, (_, index) => `术语${index}`)
    });
    expect(prompt.length).toBeLessThanOrEqual(DEFAULT_PROMPT_MAX_CHARS);
  });

  it("英文且没有任何上下文时返回空串（调用方不要传 prompt 参数）", () => {
    expect(buildTranscriptionPrompt({ language: "en", glossary: [], previousText: "" })).toBe("");
  });

  it("默认（auto）且没有其它上下文时返回空串，调用方不要传 prompt 参数", () => {
    expect(buildTranscriptionPrompt()).toBe("");
  });
});

describe("inferLanguageFromText", () => {
  it("中文与中英混合判为中文", () => {
    expect(inferLanguageFromText("我们下周发布 Q3 复盘")).toBe("zh");
    expect(inferLanguageFromText("确认一下时间")).toBe("zh");
  });

  it("纯英文判为英文，过短文本不下结论", () => {
    expect(inferLanguageFromText("Let us review the roadmap")).toBe("en");
    expect(inferLanguageFromText("嗯")).toBe("");
    expect(inferLanguageFromText("OK")).toBe("");
  });
});

describe("normalizeLanguage / resolveChunkLanguage", () => {
  it("引擎返回的语种别名与大小写都能归一", () => {
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("English")).toBe("en");
    expect(normalizeLanguage("auto")).toBe("");
    expect(normalizeLanguage(undefined)).toBe("");
  });

  it("用户显式指定的语言永远优先", () => {
    expect(resolveChunkLanguage({ configured: "en", resultLanguage: "zh", text: "我们下周上线" })).toBe("en");
  });

  it("auto 首块采信引擎结果；下一块沿用已锁定语言，不再随文本漂移", () => {
    expect(resolveChunkLanguage({ configured: "auto", resultLanguage: "zh", text: "hello world" })).toBe("zh");
    expect(resolveChunkLanguage({ configured: "auto", detected: "zh", resultLanguage: "", text: "hello world" })).toBe("zh");
  });

  it("引擎不给 language 时从识别文本兜底推断", () => {
    expect(resolveChunkLanguage({ configured: "", text: "请把 MinuteFlow 的排期确认一下" })).toBe("zh");
    expect(resolveChunkLanguage({ configured: "", text: "Please confirm the schedule" })).toBe("en");
    expect(resolveChunkLanguage({ configured: "", text: "嗯" })).toBe("");
  });
});

describe("transcriptionLanguageForEngine", () => {
  it("auto / 空值统一转成空串，避免 Python Whisper 与远程网关收到非法语言代码", () => {
    expect(transcriptionLanguageForEngine("auto")).toBe("");
    expect(transcriptionLanguageForEngine("AUTO")).toBe("");
    expect(transcriptionLanguageForEngine("detect")).toBe("");
    expect(transcriptionLanguageForEngine(undefined)).toBe("");
  });

  it("显式语种原样透传并统一小写", () => {
    expect(transcriptionLanguageForEngine("zh")).toBe("zh");
    expect(transcriptionLanguageForEngine(" EN ")).toBe("en");
    expect(transcriptionLanguageForEngine("yue")).toBe("yue");
  });
});

describe('per-model initial prompt',()=>{
  it('keeps the Simplified Chinese hint and gives initial prompt priority over history/terms',()=>{
    const prompt=buildTranscriptionPrompt({language:'zh',initialPrompt:'医疗会议术语'.repeat(20),previousText:'历史内容'.repeat(30),glossary:['术语表'],maxChars:50});
    expect(prompt).toMatch(/^以下是简体中文的会议记录。 医疗会议术语/);
    expect(prompt.length).toBeLessThanOrEqual(50);
    expect(prompt).not.toContain('历史内容');expect(prompt).not.toContain('术语表');
  });
  it('caps initial prompt at 80 characters and preserves legacy behavior when absent',()=>{
    expect(buildTranscriptionPrompt({language:'en',initialPrompt:'a'.repeat(100)})).toBe('a'.repeat(80));
    expect(buildTranscriptionPrompt({language:'en',initialPrompt:'abc',previousText:'previous',glossary:['term']})).toBe('abc previous term');
  });
});
