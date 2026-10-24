/**
 * Apple Speech 本机转录服务的纯逻辑单元测试：
 * 语言 → locale 映射、helper JSON 输出解析（成功/失败/部分结果/坏输出）。
 *
 */
import { describe, expect, it } from "vitest";
import { mapLanguageToLocale, parseHelperOutput, shouldSeedAppleSpeechProfile } from "../electron/services/apple-speech.mjs";

describe("mapLanguageToLocale", () => {
  it("空值与 auto 默认中文（首发语言优先级）", () => {
    expect(mapLanguageToLocale(undefined)).toBe("zh-CN");
    expect(mapLanguageToLocale("")).toBe("zh-CN");
    expect(mapLanguageToLocale("auto")).toBe("zh-CN");
  });

  it("常见短代码映射到主流 locale", () => {
    expect(mapLanguageToLocale("zh")).toBe("zh-CN");
    expect(mapLanguageToLocale("en")).toBe("en-US");
    expect(mapLanguageToLocale("ja")).toBe("ja-JP");
    expect(mapLanguageToLocale("ko")).toBe("ko-KR");
  });

  it("已带地区后缀的 BCP-47 值原样保留", () => {
    expect(mapLanguageToLocale("zh-TW")).toBe("zh-TW");
    expect(mapLanguageToLocale("en-GB")).toBe("en-GB");
    expect(mapLanguageToLocale("pt-BR")).toBe("pt-BR");
  });

  it("未知两位代码按语言补默认地区", () => {
    expect(mapLanguageToLocale("fr")).toBe("fr-FR");
    expect(mapLanguageToLocale("de")).toBe("de-DE");
  });
});

describe("parseHelperOutput", () => {
  it("解析成功输出：毫秒时间戳分段与全文", () => {
    const payload = parseHelperOutput(JSON.stringify({
      ok: true,
      onDeviceUsed: true,
      text: "好的，那我们开始今天的会议。",
      // helper 输出的 start/end 已经是毫秒整数（Swift 侧 timestamp*1000）。
      segments: [
        { start: 0, end: 570, text: "好的，" },
        { start: 570, end: 1200, text: "那我们" },
        { start: 1200, end: 1680, text: "   " }
      ]
    }));
    expect(payload.text).toBe("好的，那我们开始今天的会议。");
    expect(payload.onDeviceUsed).toBe(true);
    // 空白分段被过滤；毫秒值原样保留。
    expect(payload.segments).toHaveLength(2);
    expect(payload.segments[0]).toEqual({ startMs: 0, endMs: 570, text: "好的，" });
    expect(payload.segments[1]).toEqual({ startMs: 570, endMs: 1200, text: "那我们" });
  });

  it("无分段但全文非空时回退为整段", () => {
    const payload = parseHelperOutput(JSON.stringify({ ok: true, text: "只有全文", onDeviceUsed: false }));
    expect(payload.segments).toEqual([{ startMs: 0, endMs: 0, text: "只有全文" }]);
    expect(payload.partial).toBe(false);
  });

  it("多行 stdout 只取最后一行 JSON", () => {
    const stdout = `some noise\n${JSON.stringify({ ok: true, text: "结果", segments: [] })}\n`;
    expect(parseHelperOutput(stdout).text).toBe("结果");
  });

  it("失败输出抛出携带消息与代码的错误", () => {
    let caught: Error | null = null;
    try {
      parseHelperOutput(JSON.stringify({ ok: false, code: "not_authorized", message: "macOS 语音识别权限未开启。" }));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("macOS 语音识别权限未开启。");
    expect((caught as Error & { appleSpeechCode?: string })?.appleSpeechCode).toBe("not_authorized");
  });

  it("空结果按 no_speech 报错（区别于识别失败）", () => {
    let caught: Error | null = null;
    try {
      parseHelperOutput(JSON.stringify({ ok: true, text: "", segments: [] }));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("没有识别到语音内容");
  });

  it("无法解析的输出给出可读错误", () => {
    expect(() => parseHelperOutput("not json at all")).toThrow("无法解析");
  });
});

describe("shouldSeedAppleSpeechProfile（出厂默认）", () => {
  it("仅 macOS 且无任何 stt 档案时预启用", () => {
    expect(shouldSeedAppleSpeechProfile("darwin", 0)).toBe(true);
    expect(shouldSeedAppleSpeechProfile("darwin", 1)).toBe(false);
    expect(shouldSeedAppleSpeechProfile("win32", 0)).toBe(false);
    expect(shouldSeedAppleSpeechProfile("linux", 0)).toBe(false);
  });
});
