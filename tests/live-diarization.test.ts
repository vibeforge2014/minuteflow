/**
 * 直播逐块说话人标注（live-diarization.mjs）的会话状态机测试。
 * 用合成向量注入 classifyLiveEmbedding：首簇固定「我」（单人会议零回归）、
 * 差异足够大的块开「发言人 N」、相似块归簇、reset 清空会话；
 * labelLiveChunk 的守卫（语音不足 2 秒 / 无模型路径 / 坏 WAV）回退 null。
 */
import { describe, expect, it } from "vitest";
import {
  classifyLiveChunkWindows,
  classifyLiveEmbedding,
  labelLiveChunk,
  labelLiveSegments,
  liveSessionClusterCount,
  resetLiveSession
} from "../electron/services/live-diarization.mjs";

function unitVector(base: number[], jitter: number, seed: number): Float32Array {
  const pseudoRandom = (n: number) => Math.sin((seed + 1) * (n + 1) * 12.9898) * 43758.5453 % 1;
  const values = base.map((value, index) => value + pseudoRandom(index) * jitter);
  const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  return Float32Array.from(values, (value) => value / norm);
}

const meVoice = [1, 0.1, 0];
const otherVoice = [0, 0.95, 0.1];

describe("classifyLiveEmbedding 会话在线聚类", () => {
  it("首块建簇并标「我」；相似块归同一簇", () => {
    resetLiveSession("m1");
    expect(classifyLiveEmbedding("m1", unitVector(meVoice, 0.01, 1))).toEqual({ speakerId: "me", speakerName: "我" });
    expect(classifyLiveEmbedding("m1", unitVector(meVoice, 0.01, 2))).toEqual({ speakerId: "me", speakerName: "我" });
    expect(liveSessionClusterCount("m1")).toBe(1);
  });

  it("差异足够大的块开新簇「发言人 2」", () => {
    resetLiveSession("m2");
    classifyLiveEmbedding("m2", unitVector(meVoice, 0.01, 1));
    expect(classifyLiveEmbedding("m2", unitVector(otherVoice, 0.01, 2)))
      .toEqual({ speakerId: "live-speaker-2", speakerName: "发言人2" });
    expect(liveSessionClusterCount("m2")).toBe(2);
    // 第三个声音再开簇，序号继续递增。
    expect(classifyLiveEmbedding("m2", unitVector([0.1, 0, 1], 0.01, 3)))
      .toEqual({ speakerId: "live-speaker-3", speakerName: "发言人3" });
  });

  it("会话之间互不干扰，reset 后重新从「我」开始", () => {
    resetLiveSession("a");
    resetLiveSession("b");
    classifyLiveEmbedding("a", unitVector(meVoice, 0.01, 1));
    expect(classifyLiveEmbedding("b", unitVector(otherVoice, 0.01, 2)).speakerId).toBe("me");
    expect(liveSessionClusterCount("a")).toBe(1);
    resetLiveSession("b");
    expect(liveSessionClusterCount("b")).toBe(0);
    expect(classifyLiveEmbedding("b", unitVector(meVoice, 0.01, 4)).speakerName).toBe("我");
  });
});

describe("labelLiveChunk 守卫", () => {
  it("语音区间不足 2 秒直接回退 null（不加载模型）", () => {
    resetLiveSession("guard");
    expect(labelLiveChunk("guard", Buffer.alloc(64), [{ startMs: 0, endMs: 1_500 }])).toBeNull();
    expect(liveSessionClusterCount("guard")).toBe(0);
  });

  it("没有 embedding 模型路径时回退 null", () => {
    resetLiveSession("guard2");
    expect(labelLiveChunk("guard2", Buffer.alloc(64), [{ startMs: 0, endMs: 4_000 }], {})).toBeNull();
  });

  it("空区间列表回退 null", () => {
    expect(labelLiveChunk("guard3", Buffer.alloc(64), [])).toBeNull();
    expect(labelLiveChunk("guard3", Buffer.alloc(64), [{ startMs: 10, endMs: 10 }])).toBeNull();
    expect(labelLiveSegments("guard4", Buffer.alloc(64), [])).toBeNull();
    expect(labelLiveSegments("guard4", Buffer.alloc(64), [{ startMs: 0, endMs: 1_000, text: "嗯" }])).toBeNull();
  });
});

describe("classifyLiveChunkWindows 块内突然插话检测", () => {
  it("一致单人块沿用整块高置信聚类，不会误拆成多人", () => {
    resetLiveSession("single-chunk");
    const turns = classifyLiveChunkWindows("single-chunk", unitVector(meVoice, 0.01, 1), [
      { startMs: 0, endMs: 2_200, embedding: unitVector(meVoice, 0.03, 2) },
      { startMs: 2_200, endMs: 4_400, embedding: unitVector(meVoice, 0.03, 3) },
      { startMs: 4_400, endMs: 6_600, embedding: unitVector(meVoice, 0.03, 4) }
    ]);
    expect(turns).toHaveLength(1);
    expect(turns?.[0]).toMatchObject({ speakerId: "me", speakerName: "我" });
    expect(liveSessionClusterCount("single-chunk")).toBe(1);
  });

  it("同一 8 秒块内有人突然插话时，切分出独立发言人且不污染原质心", () => {
    resetLiveSession("interrupt-chunk");
    // 第一块建立「我」的质心
    classifyLiveEmbedding("interrupt-chunk", unitVector(meVoice, 0.01, 1));
    // 第二块前半段是「我」、后半段突然被另一个人插话，整块混合声纹偏向「我」
    const mixedFull = unitVector([0.85, 0.45, 0.05], 0.01, 2);
    const turns = classifyLiveChunkWindows("interrupt-chunk", mixedFull, [
      { startMs: 0, endMs: 2_200, embedding: unitVector(meVoice, 0.01, 3) },
      { startMs: 2_200, endMs: 4_400, embedding: unitVector(meVoice, 0.01, 4) },
      { startMs: 4_400, endMs: 6_600, embedding: unitVector(otherVoice, 0.01, 5) },
      { startMs: 5_500, endMs: 7_700, embedding: unitVector(otherVoice, 0.01, 6) }
    ]);
    expect(turns).toHaveLength(2);
    expect(turns?.[0]).toMatchObject({ speakerId: "me", speakerName: "我" });
    expect(turns?.[1]).toMatchObject({ speakerId: "live-speaker-2", speakerName: "发言人2" });
    expect(turns?.[0].endMs).toBeLessThanOrEqual(turns?.[1].startMs ?? 0);
    expect(liveSessionClusterCount("interrupt-chunk")).toBe(2);
  });

  it("已有第二位说话人再次在块内插话时，复用既有发言人2 而不是新建发言人3", () => {
    resetLiveSession("returning-interrupter");
    classifyLiveEmbedding("returning-interrupter", unitVector(meVoice, 0.01, 1));
    classifyLiveEmbedding("returning-interrupter", unitVector(otherVoice, 0.01, 2));
    const turns = classifyLiveChunkWindows("returning-interrupter", unitVector([0.85, 0.45, 0.05], 0.01, 3), [
      { startMs: 0, endMs: 2_500, embedding: unitVector(meVoice, 0.02, 4) },
      { startMs: 2_500, endMs: 5_000, embedding: unitVector(otherVoice, 0.02, 5) }
    ]);
    expect(turns?.map((turn) => turn.speakerId)).toEqual(["me", "live-speaker-2"]);
    expect(liveSessionClusterCount("returning-interrupter")).toBe(2);
  });
});
