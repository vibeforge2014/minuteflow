import { describe, expect, it, vi } from "vitest";
import {
  classifyPendingEntries,
  detectAudioExtension,
  parsePartialFileName,
  recoverInterruptedRecordings
} from "../electron/services/recording-recovery.mjs";

const sessionId = "11111111-2222-3333-4444-555555555555";
const source = `/tmp/meetings/m1/audio/${sessionId}-microphone.partial`;

const makeDeps = (overrides = {}) => ({
  listPending: async () => [{ sessionId, track: "microphone", path: source, meetingId: "m1" }],
  statFile: vi.fn(async (filePath: string) => (
    filePath === source ? { size: 2048 } : filePath.endsWith(".recover.tmp") ? { size: 2048 } : null
  )),
  readHeader: async () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
  renameFile: vi.fn(async () => {}),
  removeFile: vi.fn(async () => {}),
  runFfmpeg: vi.fn(async () => {}),
  finalizeAudioPath: vi.fn(),
  saveAudioAsset: vi.fn(),
  loadMeeting: async () => ({ id: "m1" }),
  notify: vi.fn(async () => {}),
  log: { log: vi.fn() },
  ...overrides
});

describe("录音块文件名与容器识别", () => {
  it("解析标准 .partial 文件名", () => {
    expect(parsePartialFileName(`${sessionId}-microphone.partial`)).toEqual({ sessionId, track: "microphone" });
    expect(parsePartialFileName(`${sessionId}-SYSTEM.partial`)).toEqual({ sessionId, track: "system" });
  });

  it("拒绝非录音块文件", () => {
    for (const name of ["notes.partial", `${sessionId}-speaker.partial`, "x.webm", ""]) {
      expect(parsePartialFileName(name)).toBeNull();
    }
  });

  it("按文件头识别 WebM / MP4，未知按 WebM", () => {
    expect(detectAudioExtension([0x1a, 0x45, 0xdf, 0xa3])).toBe(".webm");
    expect(detectAudioExtension([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])).toBe(".m4a");
    expect(detectAudioExtension([])).toBe(".webm");
  });

  it("空文件与格式不符的条目跳过", () => {
    const entries = [
      { path: source, meetingId: "m1" },
      { path: "/tmp/notes.partial", meetingId: "m1" }
    ];
    const stats = new Map([[source, { size: 0 }], ["/tmp/notes.partial", { size: 100 }]]);
    const result = classifyPendingEntries(entries, stats);
    expect(result.map((item) => item.action)).toEqual(["skip", "skip"]);
  });
});

describe("异常退出录音恢复", () => {
  it("remux 成功后落库并登记可回放资产", async () => {
    const deps = makeDeps();
    const result = await recoverInterruptedRecordings(deps);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(deps.runFfmpeg).toHaveBeenCalledOnce();
    expect(deps.finalizeAudioPath).toHaveBeenCalledWith(sessionId, "microphone", expect.stringMatching(/\.webm$/));
    expect(deps.saveAudioAsset).toHaveBeenCalledWith(expect.objectContaining({
      id: `${sessionId}:microphone`,
      meetingId: "m1",
      track: "microphone",
      sourceType: "recording"
    }));
    expect(deps.removeFile).toHaveBeenCalledWith(source);
    expect(deps.notify).toHaveBeenCalledWith(1);
  });

  it("FFmpeg 失败时原样改名保住字节", async () => {
    const deps = makeDeps({ runFfmpeg: vi.fn(async () => { throw new Error("invalid webm"); }) });
    const result = await recoverInterruptedRecordings(deps);
    expect(result.recovered).toBe(1);
    expect(deps.renameFile).toHaveBeenCalledWith(source, expect.stringMatching(/\.webm$/));
    expect(deps.removeFile).not.toHaveBeenCalledWith(source);
  });

  it("已有最终文件时只补落库，不重复转码", async () => {
    const deps = makeDeps({
      statFile: vi.fn(async (filePath: string) => filePath === source || filePath.endsWith(".webm") ? { size: 2048 } : null)
    });
    const result = await recoverInterruptedRecordings(deps);
    expect(result.recovered).toBe(1);
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
    expect(deps.saveAudioAsset).toHaveBeenCalledOnce();
  });

  it("会议已删除时跳过", async () => {
    const deps = makeDeps({ loadMeeting: async () => null });
    const result = await recoverInterruptedRecordings(deps);
    expect(result.skipped).toBe(1);
    expect(deps.saveAudioAsset).not.toHaveBeenCalled();
  });

  it("落库失败时保留原文件并计入失败", async () => {
    const deps = makeDeps({ finalizeAudioPath: vi.fn(() => { throw new Error("db locked"); }) });
    const result = await recoverInterruptedRecordings(deps);
    expect(result.failed).toBe(1);
    expect(result.details.join(" ")).toContain("原文件已保留");
  });

  it("无待恢复条目时不触发通知", async () => {
    const deps = makeDeps({ listPending: async () => [] });
    const result = await recoverInterruptedRecordings(deps);
    expect(result).toMatchObject({ recovered: 0, skipped: 0, failed: 0 });
    expect(deps.notify).not.toHaveBeenCalled();
  });
});
