import { describe, expect, it } from "vitest";
import { countOccurrences, replaceOccurrences } from "../src/lib/transcript";

describe("transcript find & replace", () => {
  it("counts every occurrence case-insensitively", () => {
    expect(countOccurrences("Alpha beta ALPHA alpha", "alpha")).toBe(3);
    expect(countOccurrences("识别结果需要时别校对", "时别")).toBe(1);
    expect(countOccurrences("aaa", "aa")).toBe(1);
    expect(countOccurrences("", "x")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });

  it("replaces only the first match when asked", () => {
    const result = replaceOccurrences("时别与时别", "时别", "识别", "first");
    expect(result).toEqual({ text: "识别与时别", count: 1 });
  });

  it("replaces every match and reports how many", () => {
    const result = replaceOccurrences("时别与时别，都是时别。", "时别", "识别", "all");
    expect(result.text).toBe("识别与识别，都是识别。");
    expect(result.count).toBe(3);
  });

  it("treats replacement as a literal, not a regex template", () => {
    const result = replaceOccurrences("金额 100 元", "100", "$& 与 $1", "all");
    expect(result.text).toBe("金额 $& 与 $1 元");
    expect(result.count).toBe(1);
  });

  it("matches latin text regardless of case while keeping the replacement verbatim", () => {
    const result = replaceOccurrences("用 Whisper 和 whisper 转录", "whisper", "SenseVoice", "all");
    expect(result.text).toBe("用 SenseVoice 和 SenseVoice 转录");
    expect(result.count).toBe(2);
  });

  it("returns the original text when nothing matches", () => {
    const result = replaceOccurrences("没有命中", "缺省", "x", "all");
    expect(result.text).toBe("没有命中");
    expect(result.count).toBe(0);
  });
});
