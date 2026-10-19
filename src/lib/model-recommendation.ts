/**
 * 本地模型按设备推荐：把主进程检测到的芯片/内存映射成「哪款模型最适合这台机器」。
 * - Whisper 目录：每款模型有最低内存档位，超出设备内存的标注「内存不足」。
 * - Ollama：按磁盘体积估算运行占用（量化模型权重 ≈ 文件体积，再加 KV 缓存与系统余量），
 *   体积未知时只给文字建议，不猜具体模型。
 * 纯函数无副作用，测试见 tests/meeting-core.test.ts 的「设备感知模型推荐」。
 */
import type { HardwareInfo } from "../types";

/** Whisper 模型 → 运行所需最低物理内存（GB，含系统与应用余量的保守值）。 */
export const WHISPER_MODEL_MIN_RAM_GB: Record<string, number> = {
  "ggml-tiny": 2,
  "ggml-base": 2,
  "ggml-small": 4,
  "ggml-medium": 8,
  "ggml-medium-q5_0": 6,
  "ggml-medium-q8_0": 10,
  "ggml-large-v3-turbo-q5_0": 8,
  "ggml-large-v3-turbo": 10,
  "ggml-large-v3-turbo-q8_0": 12,
  "ggml-large-v3-q5_0": 12,
  "ggml-large-v3": 16,
  "ggml-tiny.en": 2,
  "ggml-base.en": 2,
  "ggml-small.en": 4,
  "ggml-medium.en": 8
};

/** 按内存档位选出这台设备最适合的 Whisper 模型（中文/多语言优先）。 */
export function recommendWhisperModelId(memoryGB: number): string {
  if (memoryGB >= 24) return "ggml-large-v3";
  if (memoryGB >= 16) return "ggml-large-v3-turbo";
  if (memoryGB >= 9) return "ggml-large-v3-turbo-q5_0";
  if (memoryGB >= 6) return "ggml-small";
  return "ggml-base";
}

/** 单款 Whisper 模型与设备的匹配度：best=这台机器的推荐款；heavy=超出建议内存。 */
export function whisperModelFit(modelId: string, memoryGB: number): "best" | "ok" | "heavy" {
  if (modelId === recommendWhisperModelId(memoryGB)) return "best";
  return (WHISPER_MODEL_MIN_RAM_GB[modelId] ?? 0) <= memoryGB ? "ok" : "heavy";
}

/**
 * Ollama 模型与设备的匹配度：文件体积 × 运行放大系数（KV 缓存等）不超过
 * 可用预算（物理内存的 60%，给系统留余量）才算舒服。
 * best=预算的七成以内；ok=预算内；heavy=超出预算；体积未知返回 unknown。
 */
export function ollamaModelFit(
  sizeBytes: number | undefined,
  memoryBytes: number
): "best" | "ok" | "heavy" | "unknown" {
  if (!sizeBytes || sizeBytes <= 0 || memoryBytes <= 0) return "unknown";
  const budget = memoryBytes * 0.6;
  const runtimeBytes = sizeBytes * 1.4;
  if (runtimeBytes <= budget * 0.7) return "best";
  return runtimeBytes <= budget ? "ok" : "heavy";
}

/** Ollama 内存建议文案：只按内存档位给「选多大」的量化区间，不点名具体模型。 */
export function ollamaGuidance(memoryBytes: number): string {
  const budgetGB = (memoryBytes * 0.6) / 1024 ** 3;
  return `本机可流畅运行 ${formatBytes(budgetGB * 0.7 * 1024 ** 3)}–${formatBytes(budgetGB * 1024 ** 3)} 的模型（更大的会明显变慢或被系统换出）`;
}

/** 「Apple M4 Max · 36 GB 内存」一行设备摘要；芯片未知时只报内存。 */
export function formatHardwareLine(info: HardwareInfo): string {
  const memory = `${Math.round(info.memoryBytes / 1024 ** 3)} GB 内存`;
  return info.chipName ? `${info.chipName} · ${memory}` : memory;
}

/** 模型体积可读化（GB 一位小数 / MB 取整）。 */
export function formatModelBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "未知大小";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
