import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureDiarizationModels, DIARIZATION_SETUP_MODELS, findDiarizationFiles } from "../src/lib/diarization-setup";
import type { MeetingAPI, ModelProfile } from "../src/types";

const draft: ModelProfile = { name: "本地声纹识别", kind: "diarization", transport: "sherpa-onnx", baseUrl: "", model: "Pyannote + 3D-Speaker", enabled: true, options: { clusteringThreshold: 0.55 } };
const files = { segmentation: { path: "/models/model.int8.onnx", name: "model.int8.onnx" }, embedding: { path: "/models/speaker.onnx", name: "speaker.onnx" } };

describe("diarization setup persistence", () => {
  it("saves both detected slots as one complete profile", async () => {
    const save = vi.fn(async (profile: ModelProfile) => ({ ...profile, id: "one-profile" }));
    const saved = await configureDiarizationModels(draft, files, save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saved.options).toEqual({ clusteringThreshold: 0.55, segmentationModelPath: files.segmentation.path, embeddingModelPath: files.embedding.path });
  });
  it("reuses the first saved id and model slot across sequential downloads", async () => {
    const rows = new Map<string, ModelProfile>();
    const save = async (profile: ModelProfile) => { const saved = { ...profile, id: profile.id || `profile-${rows.size + 1}` }; rows.set(saved.id, saved); return saved; };
    const first = await configureDiarizationModels(draft, { segmentation: files.segmentation }, save);
    const second = await configureDiarizationModels(first, { embedding: files.embedding }, save);
    expect(rows.size).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.options.segmentationModelPath).toBe(files.segmentation.path);
    expect(second.options.embeddingModelPath).toBe(files.embedding.path);
  });
  it("prefers managed installed models and preserves an already configured slot", () => {
    const models = DIARIZATION_SETUP_MODELS.map((model) => ({ ...model, installed: true, localPath: `/managed/${model.fileName}` }));
    const detected = findDiarizationFiles({ ...draft, options: { segmentationModelPath: "/existing/seg.onnx" } }, models, { segmentation: [files.segmentation], embedding: [files.embedding] });
    expect(detected.segmentation).toBeUndefined();
    expect(detected.embedding?.path).toMatch(/^\/managed\//);
    const both = findDiarizationFiles(draft, [], { segmentation: [files.segmentation], embedding: [files.embedding] });
    expect(both).toEqual(files);
  });
  it("uses the selected slot for generic model filenames instead of guessing from the name", async () => {
    const saved = await configureDiarizationModels(draft, { segmentation: { path: "/models/model.onnx", name: "model.onnx" } }, async (profile) => profile);
    expect(saved.options.segmentationModelPath).toBe("/models/model.onnx");
    expect(saved.options.embeddingModelPath).toBeUndefined();
  });
});

describe("browser setup capability feedback", () => {
  let api: MeetingAPI;
  beforeAll(async () => { vi.stubGlobal("window", {}); api = (await import("../src/lib/api")).api; });
  afterAll(() => vi.unstubAllGlobals());
  it("includes both ONNX slots in the browser catalog", async () => {
    const models = (await api.models.catalog()).filter((model) => model.group === "diarization");
    expect(models).toHaveLength(2);
    expect(models.map((model) => model.id)).toEqual(DIARIZATION_SETUP_MODELS.map((model) => model.id));
    expect(models.every((model) => model.format === "ONNX" && model.digestAlgorithm === "sha256" && model.digest?.length === 64)).toBe(true);
  });
  it("renders both model slots and setup actions before the asynchronous catalog arrives", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DiarizationSetup } = await import("../src/components/settings/DiarizationSetup");
    const html = renderToStaticMarkup(createElement(DiarizationSetup, { profile: draft, onChange: () => {} }));
    expect(html).toContain("说话人分离模型（Pyannote）");
    expect(html).toContain("声纹识别模型（3D-Speaker 中文）");
    expect(html).toContain("下载并配置两个模型");
    expect(html).toContain('aria-label="选择分离模型文件"');
    expect(html).toContain('aria-label="选择声纹模型文件"');
    expect(html).toContain("当前是浏览器预览");
  });
  it("explains native-only file and scan actions instead of returning silent empty results", async () => {
    await expect(api.models.chooseLocal("diarization")).rejects.toThrow("桌面版");
    await expect(api.models.scanDiarization()).rejects.toThrow("桌面版");
  });
});
