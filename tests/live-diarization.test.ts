/**
 * 直播逐块说话人标注（live-diarization.mjs）的会话状态机测试。
 * 用合成向量注入 classifyLiveEmbedding：首簇固定「我」（单人会议零回归）、
 * 差异足够大的块开「发言人 N」、相似块归簇、reset 清空会话；
 * labelLiveChunk 的守卫（语音不足 2 秒 / 无模型路径 / 坏 WAV）回退 null。
 */
import { describe, expect, it } from "vitest";
import {
  classifyLiveEmbedding,
  labelLiveChunk,
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
  });
});
