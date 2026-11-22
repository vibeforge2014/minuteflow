import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWhisper } from "@fugood/whisper.node";
import { transcribeWithFasterWhisper, transcribeWithWhisperCpp, transcribeWithPythonWhisper } from "../electron/services/providers.mjs";
import { transcriptionComputeMode, transcriptionGpuBackend } from "../shared/transcription-options.mjs";

vi.mock("@fugood/whisper.node", () => ({
  loadWhisperModule: vi.fn(),
  initWhisper: vi.fn(async () => ({
    transcribeFile: vi.fn(() => ({ promise: Promise.resolve({ result: "测试" }) }))
  }))
}));

describe("local transcription compute device", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("only offers GPU for a supported platform and engine", () => {
    const whisper = { transport: "whisper-cpp" };
    expect(transcriptionGpuBackend(whisper, "darwin", "arm64")).toBe("metal");
    expect(transcriptionGpuBackend(whisper, "darwin", "x64")).toBeUndefined();
    expect(transcriptionGpuBackend(whisper, "win32", "x64")).toBe("vulkan");
    expect(transcriptionGpuBackend(whisper, "win32", "arm64")).toBe("vulkan");
    expect(transcriptionGpuBackend({ ...whisper, options: { executablePath: "/opt/whisper" } }, "linux", "x64")).toBe("external");
    expect(transcriptionGpuBackend({ transport: "faster-whisper" }, "darwin", "arm64")).toBeUndefined();
    expect(transcriptionGpuBackend({ transport: "faster-whisper" }, "win32", "x64")).toBe("cuda");
    expect(transcriptionGpuBackend({ transport: "whisper-python" }, "linux", "x64")).toBe("cuda");
    expect(transcriptionGpuBackend({ transport: "mlx-whisper" }, "darwin", "arm64")).toBe("metal");
    expect(transcriptionGpuBackend({ transport: "mlx-whisper" }, "darwin", "x64")).toBeUndefined();
    expect(transcriptionGpuBackend({ transport: "sense-voice" }, "win32", "x64")).toBeUndefined();
    // 归一化本身是纯函数：未知值回落 auto，显式值原样保留。
    expect(transcriptionComputeMode(undefined)).toBe("auto");
    expect(transcriptionComputeMode("bogus")).toBe("auto");
    expect(transcriptionComputeMode("cpu")).toBe("cpu");
    expect(transcriptionComputeMode("gpu")).toBe("gpu");
  });

  it("switches the same managed model between CPU and Metal without reusing the wrong context", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mf-compute-"));
    vi.stubGlobal("process", Object.create(process, {
      platform: { value: "darwin" },
      arch: { value: "arm64" }
    }));
    try {
      const modelPath = path.join(dir, "model.bin");
      await writeFile(modelPath, "fixture");
      for (const computeMode of ["cpu", "gpu", "cpu", "auto"]) {
        const result = await transcribeWithWhisperCpp({ transport: "whisper-cpp", options: { modelPath, computeMode, cpuThreads: 2, bestOf: 3 } }, Buffer.alloc(20), "test.wav");
        expect(result.text).toBe("测试");
      }
      expect(vi.mocked(initWhisper).mock.calls).toEqual([
        [{ filePath: modelPath, useGpu: false, useFlashAttn: true }],
        [{ filePath: modelPath, useGpu: true, useFlashAttn: true }]
      ]);
      for (const call of vi.mocked(initWhisper).mock.results) {
        const context = await call.value!;
        expect(context.transcribeFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxThreads: 2, bestOf: 3 }));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes computeMode and passes it to Python runtimes as the device argument", async () => {
    // 设备字符串（cuda/cpu/auto）的映射写在内嵌 Python 脚本里，JS 侧只负责
    // 把归一化后的 computeMode 放进最后一个 argv。此前用 PYTHONPATH 假模块
    // 模拟 torch/whisper 来「验证」映射，其实只测了假模块、掩盖了真实脚本的
    // 兼容性问题；这里改用一个回显 argv 的假可执行脚本，走真实的 spawn +
    // runProcess 路径，只断言 JS 侧确实把归一化后的值传了下去。
    const dir = await mkdtemp(path.join(tmpdir(), "mf-compute-python-"));
    const fakePython = path.join(dir, "fake-python");
    await writeFile(fakePython,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ text: process.argv.slice(2).at(-1) || '', segments: [] }));\n",
      { mode: 0o755 });
    try {
      for (const [transport, run] of [
        ["whisper-python", transcribeWithPythonWhisper],
        ["faster-whisper", transcribeWithFasterWhisper]
      ] as const) {
        for (const [input, expected] of [["cpu", "cpu"], ["auto", "auto"], ["bogus", "auto"]]) {
          const result = await run(
            { transport, options: { modelPath: path.join(dir, "model.pt"), pythonExecutablePath: fakePython, computeMode: input } },
            Buffer.alloc(20), "test.wav"
          );
          expect(result.text).toBe(expected);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
