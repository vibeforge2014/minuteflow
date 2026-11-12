/**
 * 置信度归一单测：异构 ASR 信号要折成可比较的 0–1，且「没给信号」不能凭空打低分。
 */
import { describe, expect, it } from "vitest";
import {
  LOW_CONFIDENCE_THRESHOLD,
  deriveConfidence,
  isLowConfidence,
  withSegmentConfidence
} from "../electron/services/transcript-confidence.mjs";

describe("deriveConfidence", () => {
  it("把 Whisper 的 avg_logprob 折算成近似 token 概率", () => {
    expect(deriveConfidence({ avg_logprob: -0.2 })).toBeCloseTo(Math.exp(-0.2), 2);
    expect(deriveConfidence({ avgLogprob: -1 })).toBeCloseTo(Math.exp(-1), 2);
    expect(deriveConfidence({ avg_logprob: 0 })).toBe(1);
  });

  it("引擎直接给 confidence 时原样采用", () => {
    expect(deriveConfidence({ confidence: 0.42 })).toBe(0.42);
    expect(deriveConfidence({ confidence: 1.8 })).toBeUndefined();
  });

  it("no_speech_prob / 幻觉压缩比 / 未定稿结果都会降权", () => {
    const base = deriveConfidence({ avg_logprob: -0.2 })!;
    expect(deriveConfidence({ avg_logprob: -0.2, no_speech_prob: 0.5 })).toBeCloseTo(base * 0.5, 2);
    expect(deriveConfidence({ avg_logprob: -0.2, compression_ratio: 3.1 })).toBeCloseTo(base * 0.6, 2);
    expect(deriveConfidence({ confidence: 0.9, partial: true })).toBeCloseTo(0.54, 2);
  });

  it("没有任何信号时返回 undefined（不臆造低分）", () => {
    expect(deriveConfidence({ text: "今天讨论 Q3 复盘" })).toBeUndefined();
    expect(deriveConfidence({ avg_logprob: null, no_speech_prob: "bad" })).toBeUndefined();
    expect(deriveConfidence(undefined)).toBeUndefined();
  });
});

describe("withSegmentConfidence", () => {
  it("给每个原子段补 confidence，整块取最低的一段", () => {
    const result = withSegmentConfidence({
      text: "第一段 第二段",
      segments: [
        { startMs: 0, endMs: 1000, text: "第一段", avg_logprob: -0.1 },
        { startMs: 1000, endMs: 2000, text: "第二段", avg_logprob: -1.4 }
      ]
    });
    expect(result.segments[0].confidence).toBeCloseTo(Math.exp(-0.1), 2);
    expect(result.segments[1].confidence).toBeCloseTo(Math.exp(-1.4), 2);
    expect(result.confidence).toBe(result.segments[1].confidence);
    expect(result.text).toBe("第一段 第二段");
  });

  it("无 segments 时用整块信号；无信号时不写 confidence", () => {
    expect(withSegmentConfidence({ text: "整块", avg_logprob: -0.5 }).confidence).toBeCloseTo(Math.exp(-0.5), 2);
    expect(withSegmentConfidence({ text: "整块" })).toEqual({ text: "整块", segments: [] });
  });

  it("保留引擎返回的 language 字段供 auto 模式锁定", () => {
    expect(withSegmentConfidence({ text: "hello", language: "en", segments: [] }).language).toBe("en");
  });
});

describe("isLowConfidence", () => {
  it("只在明确低于阈值时标记", () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.55);
    expect(isLowConfidence(0.2)).toBe(true);
    expect(isLowConfidence(0.55)).toBe(false);
    expect(isLowConfidence(undefined)).toBe(false);
    expect(isLowConfidence(Number.NaN)).toBe(false);
  });
});
