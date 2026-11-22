import type { ModelProfile, TranscriptionModelOptions } from "../types";
import { decodingKeys, transcriptionKeys, transcriptionParamCapabilities } from "../../shared/transcription-options.mjs";

export { transcriptionParamCapabilities, resolveTranscriptionLanguage, parameterRanges } from "../../shared/transcription-options.mjs";

export type TranscriptionPreset = "default" | "accuracy" | "speed";
type Options = ModelProfile["options"];

export function availableTranscriptionPresets(transport: string, options: Options) {
  const supported = transcriptionParamCapabilities(transport, options);
  const presets: { id: TranscriptionPreset; name: string }[] = [];
  if (supported.includes("temperature") || supported.includes("beamSize")) {
    presets.push({ id: "default", name: "引擎默认" });
  }
  if (supported.includes("beamSize")) {
    presets.push({ id: "accuracy", name: "准确优先" }, { id: "speed", name: "速度优先" });
  } else if (supported.includes("temperature")) {
    presets.push({ id: "accuracy", name: "低温解码" });
  }
  return presets;
}

export function applyTranscriptionPreset(options: Options, preset: TranscriptionPreset, transport: string): Options {
  if (!availableTranscriptionPresets(transport, options).some((item) => item.id === preset)) return options;
  const next = { ...options };
  for (const key of decodingKeys) delete next[key];
  const supported = transcriptionParamCapabilities(transport, options);
  if (preset === "accuracy") {
    if (supported.includes("beamSize")) next.beamSize = 5;
    if (supported.includes("temperature")) next.temperature = 0;
  }
  if (preset === "speed") next.beamSize = 1;
  return next;
}

export function identifyTranscriptionPreset(options: Options, transport: string): TranscriptionPreset | "custom" {
  const supported = transcriptionParamCapabilities(transport, options);
  for (const preset of availableTranscriptionPresets(transport, options)) {
    const candidate = applyTranscriptionPreset(options, preset.id, transport);
    if (decodingKeys.every((key) => !supported.includes(key) || options[key] === candidate[key])) return preset.id;
  }
  return "custom";
}

function modelKey(transport: ModelProfile["transport"], model: string, modelPath?: string) {
  const identity = transport === "openai-audio" ? model.trim() : modelPath;
  return identity ? JSON.stringify([transport, identity]) : null;
}

/** 当前模型的值仍写入原有 options 字段，切换时只归档转写参数。 */
export function switchTranscriptionModel(
  profile: ModelProfile,
  selection: Pick<ModelProfile, "transport" | "model">,
  modelPath = profile.options.modelPath
): ModelProfile {
  const previousKey = modelKey(profile.transport, profile.model, profile.options.modelPath);
  const nextKey = modelKey(selection.transport, selection.model, modelPath);
  const next = { ...profile, transport: selection.transport, model: selection.model, options: { ...profile.options, modelPath } };
  if (profile.kind !== "stt" || previousKey === nextKey) return next;

  const byModel = { ...profile.options.transcriptionByModel };
  const previousValues: TranscriptionModelOptions = Object.fromEntries(
    transcriptionKeys.flatMap((key) => profile.options[key] === undefined ? [] : [[key, profile.options[key]]])
  );
  if (previousKey && Object.keys(previousValues).length) byModel[previousKey] = previousValues;
  for (const key of transcriptionKeys) delete next.options[key];

  const restored = nextKey ? byModel[nextKey] : undefined;
  if (nextKey) delete byModel[nextKey];
  next.options = {
    ...next.options,
    ...(!previousKey && !restored ? previousValues : restored),
    transcriptionByModel: Object.keys(byModel).length ? byModel : undefined
  };
  return next;
}
