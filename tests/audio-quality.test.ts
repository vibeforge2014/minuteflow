/**
 * 转写音频质量单测：静音门限绝不能把「有人说话」的块丢掉，
 * 增强开关要能被偏好即时切换并影响 FFmpeg 滤镜参数。
 */
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { enhanceTranscriptionAudio } from "../electron/services/transcription-audio.mjs";
import {
  AUDIO_ENHANCEMENT_FILTERS,
  audioEnhancementFilters,
  isAudioEnhancementEnabled,
  isSilenceSkipEnabled,
  isSilentPcmWav,
  measurePcmWav,
  parsePcmWav,
  setAudioQualityPreferences
} from "../electron/services/audio-quality.mjs";

/** 构造标准 44 字节头的 16k 单声道 s16le WAV；amplitude 为满量程比例。 */
function makeWav(samples: number[], sampleRate = 16_000): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), index * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sine = (count: number, amplitude: number) =>
  Array.from({ length: count }, (_, index) => Math.sin((index / 16) * Math.PI * 2) * amplitude);

describe("PCM WAV 解析与能量", () => {
  it("解析 16k 单声道 WAV 的长度与时长", () => {
    const wave = makeWav(sine(16_000, 0.2));
    const parsed = parsePcmWav(wave);
    expect(parsed).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16 });
    expect(measurePcmWav(wave)?.durationMs).toBe(1000);
  });

  it("非 WAV / 压缩格式 / 截断数据都不敢判定", () => {
    expect(parsePcmWav(Buffer.from("not a wave"))).toBeNull();
    const compressed = makeWav(sine(1000, 0));
    compressed.writeUInt16LE(6, 20); // A-law，非 PCM
    expect(parsePcmWav(compressed)).toBeNull();
    expect(isSilentPcmWav(Buffer.alloc(10))).toBe(false);
  });

  it("清晰语音的 RMS 与峰值都明显高于门限", () => {
    const energy = measurePcmWav(makeWav(sine(16_000, 0.2)));
    expect(energy).not.toBeNull();
    expect(energy!.rms).toBeGreaterThan(0.1);
    expect(energy!.peak).toBeGreaterThan(0.15);
    expect(isSilentPcmWav(makeWav(sine(16_000, 0.2)))).toBe(false);
  });
});

describe("静音块跳过", () => {
  it("数字静音与极低底噪判为静音", () => {
    expect(isSilentPcmWav(makeWav(new Array(16_000).fill(0)))).toBe(true);
    expect(isSilentPcmWav(makeWav(sine(16_000, 0.001)))).toBe(true);
  });

  it("在绝对门限以下保留安静的人声起伏", () => {
    const samples = sine(16_000, 0.0001);
    const syllable = sine(2_400, 0.004);
    samples.splice(5_000, syllable.length, ...syllable);
    const wave = makeWav(samples);
    expect(measurePcmWav(wave)?.rms).toBeLessThan(0.004);
    expect(isSilentPcmWav(wave)).toBe(false);
    expect(isSilentPcmWav(wave, { leadingMs: 500 })).toBe(true);
  });

  it("极短的清晰爆破音即使整体 RMS 很低也不能跳过", () => {
    const samples = new Array(16_000).fill(0);
    for (let index = 8_000; index < 8_100; index += 1) samples[index] = 0.3;
    expect(isSilentPcmWav(makeWav(samples))).toBe(false);
  });

  it("过短的块不下结论，避免吞掉语气词", () => {
    expect(isSilentPcmWav(makeWav(new Array(1_600).fill(0)))).toBe(false);
    expect(isSilentPcmWav(makeWav(new Array(16_000).fill(0)), { minDurationMs: 5_000 })).toBe(false);
  });

  it("门限可由调用方覆盖；默认门限下真实语音绝不会被判静音", () => {
    const speech = makeWav(sine(16_000, 0.05));
    expect(isSilentPcmWav(speech)).toBe(false);
    expect(isSilentPcmWav(speech, {
      rmsThreshold: 0.1, peakThreshold: 0.1, activeRatioThreshold: 1
    })).toBe(true);
  });
});

describe("音频质量偏好", () => {
  it("默认开启，关闭后不再输出滤镜链", () => {
    setAudioQualityPreferences({ audioEnhancement: true, silenceSkip: true });
    expect(isAudioEnhancementEnabled()).toBe(true);
    expect(isSilenceSkipEnabled()).toBe(true);
    expect(audioEnhancementFilters()).toEqual(AUDIO_ENHANCEMENT_FILTERS);
    setAudioQualityPreferences({ audioEnhancement: false, silenceSkip: false });
    expect(audioEnhancementFilters()).toEqual([]);
    expect(isAudioEnhancementEnabled()).toBe(false);
    expect(isSilenceSkipEnabled()).toBe(false);
    // 每个用例结束后复位，避免模块级单例污染其他测试文件。
    setAudioQualityPreferences({ audioEnhancement: true, silenceSkip: true });
  });
});

describe("enhanceTranscriptionAudio", () => {
  const wave = makeWav(sine(1_600, 0.1));

  it("增强是独立后处理：开启时带高通 + 响度归一，输出仍是 WAV", async () => {
    setAudioQualityPreferences({ audioEnhancement: true, silenceSkip: true });
    let seenArgs: string[] = [];
    const result = await enhanceTranscriptionAudio(wave, "/managed/ffmpeg", undefined, async (_command, args) => {
      seenArgs = args;
      await writeFile(args.at(-1)!, wave);
    });
    expect(seenArgs).toContain("-af");
    expect(seenArgs[seenArgs.indexOf("-af") + 1]).toContain("highpass");
    expect(seenArgs[seenArgs.indexOf("-af") + 1]).toContain("loudnorm");
    expect(result.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("关闭开关或 FFmpeg 失败时原样返回，绝不弄丢可识别的音频", async () => {
    setAudioQualityPreferences({ audioEnhancement: false, silenceSkip: true });
    let invoked = false;
    expect(await enhanceTranscriptionAudio(wave, "/managed/ffmpeg", undefined, async () => { invoked = true; })).toEqual(wave);
    expect(invoked).toBe(false);

    setAudioQualityPreferences({ audioEnhancement: true, silenceSkip: true });
    expect(await enhanceTranscriptionAudio(wave, "/managed/ffmpeg", undefined, async () => {
      throw new Error("filter unavailable");
    })).toEqual(wave);
  });
});
