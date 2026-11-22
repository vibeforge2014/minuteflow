/**
 * 窗口化声纹聚类的纯逻辑测试（diarization-core.mjs）。
 * 背景：「转写永远显示我」的根因之一是 pyannote 在 WebRTC 处理过的直播麦克风
 * 音频上漏检大部分语音；改用转写区间滑窗 + 平均链接聚类后，这里锁定
 * 滑窗切割、聚类与轮次合并的行为契约。
 */
import { describe, expect, it } from "vitest";
import {
  assignWindowsToClusters,
  buildSpeechWindows,
  decodePcm16Wav,
  diarizeAudioWindows,
  mergeDiarizationClusters,
  windowsToTurns
} from "../electron/services/diarization-core.mjs";

/** 造一个归一化的合成向量：base 方向加可控噪声。 */
function syntheticVector(base: number[], jitter: number, seed: number): Float32Array {
  const pseudoRandom = (n: number) => Math.sin((seed + 1) * (n + 1) * 12.9898) * 43758.5453 % 1;
  const values = base.map((value, index) => value + pseudoRandom(index) * jitter);
  const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  return Float32Array.from(values, (value) => value / norm);
}

describe("diarizeAudioWindows", () => {
  it("clips overlapping input and resumes with stable time ranges and speaker IDs", () => {
    const wave = { samples: new Float32Array(81), sampleRate: 10 };
    const completed: Array<{ throughSample: number; turns: Array<{ startMs: number; endMs: number; speakerId: string }> }> = [];
    const sizeByCall: number[] = [];
    const processWindow = (samples: Float32Array) => {
      sizeByCall.push(samples.length);
      return [{ start: 0, end: samples.length / wave.sampleRate, speaker: 0 }];
    };
    const options = { windowMs: 4_000, paddingMs: 1_000 };
    const turns = diarizeAudioWindows(wave, processWindow, { ...options, onWindow: (window) => completed.push(window) });
    expect(sizeByCall).toEqual([50, 51]);
    expect(turns).toEqual([
      { startMs: 0, endMs: 4_000, speakerId: "0:0" },
      { startMs: 4_000, endMs: 8_100, speakerId: "40:0" }
    ]);
    expect(diarizeAudioWindows(wave, processWindow, { ...options, checkpoint: completed[0] })).toEqual(turns);
    expect(sizeByCall).toEqual([50, 51, 51]);
    const sameVoice = new Map(turns.map((turn) => [turn.speakerId, new Float32Array([1, 0])]));
    expect(new Set(mergeDiarizationClusters(turns, sameVoice).map((turn) => turn.speakerId))).toEqual(new Set(["speaker-1"]));
  });
});

describe("buildSpeechWindows", () => {
  it("把长区间切成滑窗、丢弃不足 2 秒的尾巴", () => {
    const windows = buildSpeechWindows([{ startMs: 0, endMs: 10_000 }]);
    expect(windows).toEqual([
      { startMs: 0, endMs: 4_000 },
      { startMs: 2_000, endMs: 6_000 },
      { startMs: 4_000, endMs: 8_000 },
      { startMs: 6_000, endMs: 10_000 }
    ]);
    // 10s 区间推进到 8s 后剩 2s 窗口（≥ minWindowMs 保留），不再多切。
    expect(windows.at(-1)?.endMs).toBe(10_000);
  });

  it("合并重叠区间的重复窗口并按时间排序", () => {
    const windows = buildSpeechWindows([
      { startMs: 6_000, endMs: 12_000 },
      { startMs: 0, endMs: 6_000 }
    ]);
    const starts = windows.map((window) => `${window.startMs}-${window.endMs}`);
    expect(new Set(starts).size).toBe(starts.length);
    // 每个区间滑到「窗口终点触达区间末尾」为止，不再补切短尾巴。
    expect(starts).toEqual(["0-4000", "2000-6000", "6000-10000", "8000-12000"]);
  });

  it("短于最小窗口的区间不产出窗口", () => {
    expect(buildSpeechWindows([{ startMs: 0, endMs: 1_999 }])).toEqual([]);
    expect(buildSpeechWindows([{ startMs: 0, endMs: 4_000 }])).toEqual([{ startMs: 0, endMs: 4_000 }]);
  });
});

describe("assignWindowsToClusters", () => {
  it("两个方向明显不同的向量组各自成簇，簇号按时间顺序分配", () => {
    const speakerA = [1, 0, 0.05];
    const speakerB = [0.05, 1, 0];
    const embeddings = [
      syntheticVector(speakerA, 0.01, 1),
      syntheticVector(speakerB, 0.01, 2),
      syntheticVector(speakerA, 0.01, 3),
      syntheticVector(speakerB, 0.01, 4)
    ];
    const labels = assignWindowsToClusters(embeddings, { threshold: 0.62 });
    expect(labels[0]).toBe(labels[2]);
    expect(labels[1]).toBe(labels[3]);
    expect(labels[0]).not.toBe(labels[1]);
    // 首窗（时间最早）拿 0 号簇。
    expect(labels[0]).toBe(0);
  });

  it("同一个人的全部窗口聚成一簇", () => {
    const embeddings = Array.from({ length: 6 }, (_, index) => syntheticVector([1, 0.2, 0.1], 0.02, index));
    const labels = assignWindowsToClusters(embeddings, { threshold: 0.62 });
    expect(new Set(labels).size).toBe(1);
  });

  it("无效向量标记为 -1，不参与聚类", () => {
    const labels = assignWindowsToClusters([syntheticVector([1, 0, 0], 0, 1), null], { threshold: 0.62 });
    expect(labels[1]).toBe(-1);
    expect(labels[0]).toBe(0);
  });
});

describe("windowsToTurns", () => {
  it("时间相邻且同簇的窗口合并成一个轮次，异簇切分", () => {
    const windows = [
      { startMs: 0, endMs: 4_000 },
      { startMs: 2_000, endMs: 6_000 },
      { startMs: 4_000, endMs: 8_000 },
      { startMs: 6_000, endMs: 10_000 }
    ];
    const turns = windowsToTurns(windows, [0, 0, 1, 1]);
    expect(turns).toEqual([
      { startMs: 0, endMs: 6_000, speakerId: "speaker-1" },
      { startMs: 4_000, endMs: 10_000, speakerId: "speaker-2" }
    ]);
  });

  it("同簇但时间不连续的窗口保持独立轮次；无效标签被丢弃", () => {
    const turns = windowsToTurns(
      [
        { startMs: 0, endMs: 4_000 },
        { startMs: 10_000, endMs: 14_000 }
      ],
      [0, 0]
    );
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.speakerId === "speaker-1")).toBe(true);
    expect(windowsToTurns([{ startMs: 0, endMs: 4_000 }], [-1])).toEqual([]);
  });
});

describe("decodePcm16Wav", () => {
  it("解出 16-bit PCM 采样并归一化到 [-1, 1]", () => {
    const samples = Int16Array.from([0, 16384, -16384, 32767]);
    const dataSize = samples.byteLength;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(16_000, 24);
    buffer.writeUInt32LE(32_000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(dataSize, 40);
    Buffer.from(samples.buffer, samples.byteOffset, dataSize).copy(buffer, 44);
    const wave = decodePcm16Wav(buffer);
    expect(wave?.sampleRate).toBe(16_000);
    const decoded = Array.from(wave?.samples ?? []);
    expect(decoded[0]).toBe(0);
    expect(decoded[1]).toBeCloseTo(0.5, 5);
    expect(decoded[2]).toBeCloseTo(-0.5, 5);
    expect(decoded[3]).toBeCloseTo(1, 4);
  });

  it("损坏/非 PCM 输入返回 null", () => {
    expect(decodePcm16Wav(Buffer.from("not a wav at all"))).toBeNull();
    expect(decodePcm16Wav(Buffer.alloc(0))).toBeNull();
  });
});
