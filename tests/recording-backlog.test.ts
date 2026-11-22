/**
 * 实时转写补转队列测试（vitest）：驱动真实 MeetingRecorder（stub 浏览器采集 API），
 * 验证「转录模型未就绪」时音频块挂起排队、模型就绪后按签发顺序自动补转、
 * 占位段不被提前放行、以及录音中途补配/切换档案即时生效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { processChunk, stopRecording } = vi.hoisted(() => ({ processChunk: vi.fn(), stopRecording: vi.fn(async (_payload: unknown) => ({})) }));

vi.mock("../src/lib/api", () => ({
  api: {
    system: {
      getPermissions: async () => ({ microphone: "granted", screen: "granted", systemAudioRequired: false })
    },
    recordings: {
      start: async () => ({ sessionId: "session-1", startedAt: Date.now() }),
      append: async () => ({ ok: true }),
      stop: stopRecording,
      abort: async () => ({ ok: true }),
      open: async () => ({}),
      assets: async () => []
    },
    transcription: { processChunk }
  }
}));

import { MeetingRecorder } from "../src/services/recording";

/** 假 MediaRecorder：转写块（64k 码率）在 7.5s 后产出一个自包含块；归档录制器静默。 */
class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private captureTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public stream: { active: boolean },
    public options?: { audioBitsPerSecond?: number }
  ) {}

  addEventListener(type: string, listener: (event: unknown) => void) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  start() {
    this.state = "recording";
    if (this.options?.audioBitsPerSecond !== 64_000) return;
    this.captureTimer = setTimeout(() => this.stop(), 7_500);
  }

  stop() {
    if (this.state === "inactive") return;
    clearTimeout(this.captureTimer);
    const blob = new Blob([new ArrayBuffer(256)], { type: this.mimeType });
    this.emit("dataavailable", { data: blob });
    this.state = "inactive";
    this.emit("stop", {});
  }

  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function stubBrowserApis() {
  const fakeStream = { active: true, getTracks: () => [] };
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "AudioContext",
    class {
      fftSize = 512;
      createAnalyser() {
        return { fftSize: 512, getByteTimeDomainData: (values: Uint8Array) => values.fill(128) };
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      close() {
        return Promise.resolve();
      }
    }
  );
  vi.stubGlobal(
    "navigator",
    { mediaDevices: { getUserMedia: async () => fakeStream } }
  );
  return fakeStream;
}

function makeRecorder(profile: { id: string } | undefined) {
  const events = {
    provisional: [] as Array<{ id: string; startMs: number }>,
    transcript: [] as Array<{ startMs: number; text: string }>,
    settled: [] as string[],
    failures: [] as Array<{ message: string; consecutive: number }>,
    recovered: 0,
    queue: [] as number[]
  };
  const meeting = { id: "meeting-1", mode: "offline" } as never;
  const sttProfile = profile
    ? ({ id: profile.id, kind: "stt", name: profile.id } as never)
    : undefined;
  const recorder = new MeetingRecorder(meeting, sttProfile, [], {
    onLevel: () => {},
    onTranscriptionQueue: (size) => events.queue.push(size),
    onWarning: () => {},
    onTranscriptionFailure: (failure) => events.failures.push(failure),
    onTranscriptionRecovered: () => {
      events.recovered += 1;
    },
    onTranscript: (segment) =>
      events.transcript.push({ startMs: segment.startMs, text: segment.text }),
    onProvisional: (segment) =>
      events.provisional.push({ id: segment.id, startMs: segment.startMs }),
    onProvisionalSettled: (id) => events.settled.push(id)
  });
  return { recorder, events };
}

const NOT_READY = new Error("[STT_NOT_READY] 本地模型尚未就绪。请在转录设置中下载模型后重试。");

describe("实时转写补转队列", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    stubBrowserApis();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    processChunk.mockReset();
    stopRecording.mockClear();
  });

  it("模型未就绪时块挂起排队，就绪后按序补转且不提前放行后续块", async () => {
    let ready = false;
    processChunk.mockImplementation(async (payload: { startMs: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!ready) throw NOT_READY;
      return {
        segments: [{
          id: `seg-${payload.startMs}`,
          startMs: payload.startMs,
          endMs: payload.startMs + 8_000,
          text: `补转文本-${payload.startMs}`,
          speakerId: "me",
          speakerName: "我",
          status: "final",
          track: "microphone"
        }]
      };
    });

    const { recorder, events } = makeRecorder({ id: "stt-a" });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(16_000);
    // 两块都因未就绪挂起：占位段保留、无正文、失败提示带上自动补转说明。
    // （第三个失败来自 11.5s 的补转重试：排空失败同样刷新提示。）
    expect(events.provisional.length).toBe(2);
    expect(events.transcript.length).toBe(0);
    expect(events.failures.length).toBe(3);
    expect(events.failures[0].message).toContain("自动补转");

    // 中途模型就绪并切换到新档案：补转请求必须用新档案 id。
    ready = true;
    recorder.updateSttProfile({ id: "stt-b", kind: "stt", name: "stt-b" } as never);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.transcript.length).toBeGreaterThanOrEqual(1);
    expect(events.settled.length).toBe(events.transcript.length);
    expect(processChunk.mock.calls.some(([payload]) =>
      (payload as { profileId: string }).profileId === "stt-b"
    )).toBe(true);

    // 继续推进：积压清空、后续块按 startMs 升序完整落进正文。
    await vi.advanceTimersByTimeAsync(20_000);
    const stopping = recorder.stop(50);
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(events.failures.length).toBe(3);
    expect(events.recovered).toBe(1);
    expect(events.queue.at(-1)).toBe(0);
    expect(events.transcript.length).toBe(events.provisional.length + 1);
    const startTimes = events.transcript.map((segment) => segment.startMs);
    expect([...startTimes].sort((a, b) => a - b)).toEqual(startTimes);
    for (const segment of events.transcript) {
      expect(segment.text).toBe(`补转文本-${segment.startMs}`);
    }
  });

  it("录音开始时未配置档案：中途补配档案会补转开场录音", async () => {
    processChunk.mockImplementation(async (payload: { startMs: number }) => ({
      segments: [{
        id: `seg-${payload.startMs}`,
        startMs: payload.startMs,
        endMs: payload.startMs + 8_000,
        text: `文本-${payload.startMs}`,
        speakerId: "me",
        speakerName: "我",
        status: "final",
        track: "microphone"
      }]
    }));

    const { recorder, events } = makeRecorder(undefined);
    await recorder.start();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(processChunk).not.toHaveBeenCalled();

    recorder.updateSttProfile({ id: "stt-late", kind: "stt", name: "stt-late" } as never);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(processChunk).toHaveBeenCalled();
    expect(processChunk.mock.calls.every(([payload]) =>
      (payload as { profileId: string }).profileId === "stt-late"
    )).toBe(true);
    expect(events.transcript.length).toBeGreaterThanOrEqual(1);
    expect(events.transcript[0].startMs).toBe(0);
    await recorder.stop(20);
  });
  it("30 秒静音不挂占位，后续人声恢复占位与正文，模型语言覆盖全局", async () => {
    let speech = false;
    (AudioContext.prototype as unknown as {decodeAudioData: (buffer: ArrayBuffer) => Promise<unknown>}).decodeAudioData = async () => ({
      numberOfChannels: 1, getChannelData: () => new Float32Array(1600).fill(speech ? .1 : 0)
    });
    processChunk.mockImplementation(async (payload: {startMs:number}) => {
      const result = {outcome: speech ? "recognized" : "silent", segments: speech ? [{id:`voice-${payload.startMs}`,startMs:payload.startMs,endMs:payload.startMs+3000,text:'开始讨论',speakerId:'me',speakerName:'我',status:'final',track:'microphone'}] : []};
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result;
    });
    const {recorder,events} = makeRecorder({id:'quiet-stt'});
    recorder.updateSttProfile({id:'quiet-stt',kind:'stt',options:{transcriptionLanguage:'en'}} as never);
    await recorder.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(processChunk.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(events.provisional).toHaveLength(0);
    expect(events.transcript).toHaveLength(0);
    expect(processChunk.mock.calls.every(([payload]) => payload.language === 'en')).toBe(true);
    speech = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(events.provisional.length).toBeGreaterThan(0);
    expect(events.transcript.length).toBeGreaterThan(0);
    const stopping = recorder.stop(38);
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
  });

  it("暂停截断当前块，恢复时沿用录音时间轴，停录时提交最后一段", async () => {
    processChunk.mockResolvedValue({ segments: [], outcome: "silent", language: "zh" });
    const { recorder } = makeRecorder({ id: "stt-auto" });
    recorder.updateSttProfile({ id: "stt-auto", options: { transcriptionLanguage: "auto" } } as never);
    await recorder.start();
    await vi.advanceTimersByTimeAsync(3_000);
    recorder.pause();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(processChunk).toHaveBeenCalledTimes(1);
    recorder.resume();
    await vi.advanceTimersByTimeAsync(2_000);
    await recorder.stop(5);
    expect(processChunk.mock.calls.map(([input]) => [input.startMs, input.endMs, input.language])).toEqual([
      [0, 3_000, "auto"], [3_000, 5_000, "auto"]
    ]);
    expect(stopRecording.mock.calls[0][0]).not.toHaveProperty("transcriptionBackfill");
  });

  it("停录等待超过八秒时，只登记未完成的时段用于会后补转", async () => {
    processChunk.mockResolvedValueOnce({ segments: [], outcome: "silent" })
      .mockImplementationOnce(() => new Promise(() => {}));
    const { recorder } = makeRecorder({ id: "stt-slow" });
    await recorder.start();
    await vi.advanceTimersByTimeAsync(9_000);
    const stopping = recorder.stop(9);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(stopRecording).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopRecording).toHaveBeenCalledWith(expect.objectContaining({
      transcriptionBackfill: expect.objectContaining({
        ranges: [{ track: "microphone", offsetMs: 0, startMs: 7_500, endMs: 9_000 }]
      })
    }));
  });
});
