/**
 * 音频导出的文件清单与多轨命名回归测试。
 *
 * 历史问题：录音会议同时有「麦克风」和「系统声音」两条轨，
 * 导出只复制 audioPaths[0]，第二条轨被静默丢掉。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }
}));

const { normalizeAudioFiles, siblingAudioPath } = await import("../electron/services/exports.mjs");

describe("audio export files", () => {
  it("按路径去重，块记录与资产记录指向同一文件时只保留一条", () => {
    const files = normalizeAudioFiles([
      { path: "/audio/mic.webm", label: "麦克风" },
      { path: "/audio/mic.webm", label: "麦克风" },
      { path: "/audio/system.webm", label: "系统声音" }
    ]);

    expect(files.map((file) => file.label)).toEqual(["麦克风", "系统声音"]);
  });

  it("兼容旧的纯路径数组", () => {
    expect(normalizeAudioFiles(["/audio/mic.webm"])).toEqual([{ path: "/audio/mic.webm", label: "" }]);
  });

  it("第二条轨道写到同目录，用轨道名区分文件名", () => {
    const target = siblingAudioPath("/Users/me/Desktop/周会.webm", { path: "/audio/system.webm", label: "系统声音" }, 1);

    expect(target).toBe("/Users/me/Desktop/周会-系统声音.webm");
  });

  it("没有轨道名时退回序号，且沿用各轨自身扩展名", () => {
    const target = siblingAudioPath("/Users/me/Desktop/周会.webm", { path: "/audio/system.m4a", label: "" }, 1);

    expect(target).toBe("/Users/me/Desktop/周会-2.m4a");
  });
});
