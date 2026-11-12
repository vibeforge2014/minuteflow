/**
 * 术语纠错建议单测：核心承诺是「只提示、绝不静默改字」，
 * 且不能把写法本来就正确的段落、或普通句子里的常用词误报成错别字。
 */
import { describe, expect, it } from "vitest";
import {
  applyGlossarySuggestion,
  findGlossarySuggestions,
  normalizeGlossaryTerms
} from "../src/lib/glossary-suggestions";

describe("normalizeGlossaryTerms", () => {
  it("去空、去误粘贴长段、按原样去重并限制容量", () => {
    expect(normalizeGlossaryTerms([" MinuteFlow ", "", "Q3 复盘", "Q3 复盘", "x".repeat(41)]))
      .toEqual(["MinuteFlow", "Q3 复盘"]);
    expect(normalizeGlossaryTerms(Array.from({ length: 40 }, (_, index) => `术语${index}`))).toHaveLength(24);
  });
});

describe("findGlossarySuggestions", () => {
  const terms = ["MinuteFlow", "Q3 复盘"];

  it("标准写法原样出现时不给任何建议", () => {
    expect(findGlossarySuggestions("今天用 MinuteFlow 做 Q3 复盘", terms)).toEqual([]);
  });

  it("空格/大小写差异归为 format 建议，并给出可替换的原文区间", () => {
    const text = "今天用 Minute Flow 做记录";
    const found = findGlossarySuggestions(text, terms);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "format", original: "Minute Flow", replacement: "MinuteFlow" });
    expect(text.slice(found[0].start, found[0].end)).toBe("Minute Flow");
  });

  it("拉丁专名差一个字母归为 typo 建议", () => {
    const found = findGlossarySuggestions("会上有 MinuteFlaw 的演示", terms);
    expect(found.some((item) => item.kind === "typo" && item.replacement === "MinuteFlow")).toBe(true);
  });

  it("中文术语错一个字也能给出建议", () => {
    const found = findGlossarySuggestions("我们做了 Q3 复潘", terms);
    expect(found.some((item) => item.replacement === "Q3 复盘")).toBe(true);
  });

  it("短词不做近似匹配，避免普通句子刷屏误报", () => {
    expect(findGlossarySuggestions("这个复盘很及时", ["复盘"])).toEqual([]);
    expect(findGlossarySuggestions("好的，我知道了", terms)).toEqual([]);
  });

  it("建议互不重叠且遵守 limit", () => {
    const found = findGlossarySuggestions("Minute Flow 和 MinuteFlaw 都在 Q3 复潘里", terms, 2);
    expect(found).toHaveLength(2);
    for (let index = 1; index < found.length; index += 1) {
      expect(found[index].start).toBeGreaterThanOrEqual(found[index - 1].end);
    }
  });

  it("超长文本与空术语表直接跳过，不阻塞渲染", () => {
    expect(findGlossarySuggestions("很长的段落".repeat(200), terms)).toEqual([]);
    expect(findGlossarySuggestions("Minute Flow", [])).toEqual([]);
  });
});

describe("applyGlossarySuggestion", () => {
  it("只在原文片段仍然一致时替换，且不动其他文字", () => {
    const text = "今天用 Minute Flow 做记录";
    const [suggestion] = findGlossarySuggestions(text, ["MinuteFlow"]);
    expect(applyGlossarySuggestion(text, suggestion)).toBe("今天用 MinuteFlow 做记录");
  });

  it("用户已手动编辑过该段时拒绝替换（避免覆盖人工修改）", () => {
    const [suggestion] = findGlossarySuggestions("今天用 Minute Flow 做记录", ["MinuteFlow"]);
    const edited = "今天用别的工具做记录";
    expect(applyGlossarySuggestion(edited, suggestion)).toBe(edited);
  });
});
