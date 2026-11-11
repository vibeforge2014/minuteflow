/**
 * 本地 ASR bundle（SenseVoice / Parakeet / Qwen3-ASR）的目录、多文件下载与扫描测试。
 * 与 meeting-core.test.ts 的模型下载测试同一套 mock 策略：electron.app 与托管
 * whisper 运行时替换为可加载替身，fetch 打桩控制下载源行为。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => `/tmp/minuteflow-asr-test-${process.pid}` }
}));
vi.mock("@fugood/whisper.node", () => ({
  loadWhisperModule: async () => ({ WhisperContext: class WhisperContext {} }),
  initWhisper: async () => ({})
}));

import {
  discoverLocalModels,
  downloadModel,
  listDownloadableModels,
  localAsrModelDirectory,
  resolveLocalModelProfile
} from "../electron/services/local-models.mjs";
import { importTranscriptionRoute } from "../electron/services/import-profiles.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("本地 ASR bundle 目录", () => {
  it("SenseVoice / Parakeet / Qwen3-ASR 的 bundle 在 shared/local-asr-models.json 中逐文件带 sha256", async () => {
    const catalog = await listDownloadableModels("/nonexistent/asr-catalog");
    const engines = catalog.map((model) => model.engine);
    expect(engines).toContain("sense-voice");
    expect(engines).toContain("parakeet-tdt");
    expect(engines).toContain("qwen3-asr");
    for (const model of catalog.filter((item) => item.files?.length)) {
      expect(model.files?.every((file) => file.remoteFileName && file.fileName && file.sizeBytes > 0 && /^[0-9a-f]{64}$/.test(file.digest))).toBe(true);
    }
  });

  it("多文件 bundle 安装在 models/asr/<id>/，全部文件就位才算已安装", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "minuteflow-asr-install-"));
    const whisperDirectory = path.join(root, "whisper");
    const catalog = await listDownloadableModels(whisperDirectory);
    const senseVoice = catalog.find((model) => model.id === "sense-voice-2024-07-17-int8")!;
    expect(senseVoice.installed).toBe(false);

    const bundleDirectory = path.join(localAsrModelDirectory(whisperDirectory), senseVoice.id);
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(path.join(bundleDirectory, "model.int8.onnx"), "x");
    // 只有一个文件：还不算安装完成。
    expect((await listDownloadableModels(whisperDirectory)).find((model) => model.id === senseVoice.id)?.installed).toBe(false);
    await writeFile(path.join(bundleDirectory, "tokens.txt"), "y");
    const installed = (await listDownloadableModels(whisperDirectory)).find((model) => model.id === senseVoice.id)!;
    expect(installed.installed).toBe(true);
    expect(installed.localPath).toBe(bundleDirectory);
    await rm(root, { recursive: true, force: true });
  });

  it("扫描目录时按 bundle 特征识别 SenseVoice / Parakeet / Qwen3-ASR", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "minuteflow-asr-scan-"));
    const senseDirectory = path.join(root, "sherpa-onnx-sense-voice");
    await mkdir(senseDirectory, { recursive: true });
    await writeFile(path.join(senseDirectory, "model.int8.onnx"), "x");
    await writeFile(path.join(senseDirectory, "tokens.txt"), "y");

    const parakeetDirectory = path.join(root, "sherpa-onnx-parakeet-tdt");
    await mkdir(parakeetDirectory, { recursive: true });
    for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
      await writeFile(path.join(parakeetDirectory, name), "x");
    }

    const qwenDirectory = path.join(root, "Qwen3-ASR-0.6B");
    await mkdir(qwenDirectory, { recursive: true });
    await writeFile(path.join(qwenDirectory, "config.json"), JSON.stringify({ model_type: "qwen3_asr", architectures: ["Qwen3ASRForConditionalGeneration"] }));
    await writeFile(path.join(qwenDirectory, "model.safetensors"), "x");

    // 无关目录不能被误判。
    const unrelated = path.join(root, "some-llm-model");
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, "config.json"), JSON.stringify({ model_type: "qwen2" }));
    await writeFile(path.join(unrelated, "model.safetensors"), "x");

    const { models } = await discoverLocalModels({ roots: [root], modelDirectory: path.join(root, "managed") });
    const byPath = new Map(models.map((model) => [model.path, model]));
    expect(byPath.get(senseDirectory)?.engine).toBe("sense-voice");
    expect(byPath.get(parakeetDirectory)?.engine).toBe("parakeet-tdt");
    expect(byPath.get(qwenDirectory)?.engine).toBe("qwen3-asr");
    expect(byPath.get(unrelated)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("下载失败时按官方→镜像换源、逐文件重试并清理半截目录", { timeout: 30_000 }, async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const root = await mkdtemp(path.join(tmpdir(), "minuteflow-asr-download-"));
    const whisperDirectory = path.join(root, "whisper");
    await expect(downloadModel("sense-voice-2024-07-17-int8", whisperDirectory)).rejects.toThrow("模型下载失败");
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // 第一个文件（model.int8.onnx）在两个源上都失败后整体换源，不会继续下 tokens.txt。
    expect(urls).toEqual([
      "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx?download=true",
      "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx?download=true"
    ]);
    await expect(readdir(localAsrModelDirectory(whisperDirectory))).resolves.toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("导入路由把 SenseVoice / Parakeet 钉在 sherpa 路径", () => {
    expect(importTranscriptionRoute("sense-voice")).toBe("sherpa");
    expect(importTranscriptionRoute("parakeet-tdt")).toBe("sherpa");
    expect(importTranscriptionRoute("qwen3-asr")).toBe("qwen3-asr");
  });

  it("SenseVoice 档案在 bundle 就位后即视为就绪", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "minuteflow-asr-ready-"));
    const whisperDirectory = path.join(root, "whisper");
    const bundleDirectory = path.join(localAsrModelDirectory(whisperDirectory), "sense-voice-2024-07-17-int8");
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(path.join(bundleDirectory, "model.int8.onnx"), "x");
    await writeFile(path.join(bundleDirectory, "tokens.txt"), "y");
    const profile = {
      name: "SenseVoice 本地",
      kind: "stt",
      transport: "sense-voice",
      baseUrl: "",
      model: "sense-voice-2024-07-17-int8",
      options: {},
      enabled: true
    };
    const resolution = await resolveLocalModelProfile(profile, { roots: [], modelDirectory: whisperDirectory });
    // vitest 环境能加载内置 sherpa-onnx 运行时，FFmpeg 为应用内置组件 → 应完全就绪。
    expect(resolution.readiness.status).toBe("ready");
    expect(resolution.profile.options.modelPath).toBe(bundleDirectory);
    await rm(root, { recursive: true, force: true });
  });
});
