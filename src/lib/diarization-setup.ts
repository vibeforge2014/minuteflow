import catalog from "../../shared/diarization-models.json";
import type { DiarizationScanResult, DownloadableModel, ModelProfile } from "../types";

export type DiarizationSlot = "segmentation" | "embedding";
export type DiarizationModelFiles = Partial<Record<DiarizationSlot, { path: string; name: string }>>;

/** One catalog for the desktop downloader and the browser settings preview. */
export const DIARIZATION_SETUP_MODELS: DownloadableModel[] = catalog.map((model) => ({
  ...model, group: "diarization", engine: "diarization", digestAlgorithm: "sha256", installed: false
}));

export const diarizationSlotOf = (modelId: string): DiarizationSlot => modelId.includes("segmentation") ? "segmentation" : "embedding";
export const diarizationPathKey = (slot: DiarizationSlot) => slot === "segmentation" ? "segmentationModelPath" : "embeddingModelPath";

export function findDiarizationFiles(profile: ModelProfile, models: DownloadableModel[], scan: DiarizationScanResult): DiarizationModelFiles {
  const files: DiarizationModelFiles = {};
  for (const slot of ["segmentation", "embedding"] as const) {
    if (profile.options[diarizationPathKey(slot)]) continue;
    const installed = models.find((model) => model.group === "diarization" && model.installed && model.localPath && diarizationSlotOf(model.id) === slot);
    const found = installed?.localPath ? { path: installed.localPath, name: installed.fileName ?? installed.id } : scan[slot][0];
    if (found) files[slot] = found;
  }
  return files;
}

/** Save both detected slots atomically; never fork two incomplete profiles from one draft. */
export function configureDiarizationModels(profile: ModelProfile, files: DiarizationModelFiles, save: (profile: ModelProfile) => Promise<ModelProfile>): Promise<ModelProfile> {
  const options = { ...profile.options };
  for (const slot of ["segmentation", "embedding"] as const) {
    if (files[slot]) options[diarizationPathKey(slot)] = files[slot]!.path;
  }
  return save({ ...profile, kind: "diarization", transport: "sherpa-onnx", name: "本地声纹识别", enabled: true, options });
}
