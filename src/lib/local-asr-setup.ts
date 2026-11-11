import catalog from "../../shared/local-asr-models.json";
import type { DownloadableModel } from "../types";

/**
 * SenseVoice / Parakeet / Qwen3-ASR 的目录映射（与 Electron local-models.mjs
 * 共用 shared/local-asr-models.json，保证桌面下载器与浏览器预览展示同一份清单）。
 * 浏览器预览只展示：下载/扫描/启用等本机动作由 Electron 主进程执行。
 */
export const LOCAL_ASR_SETUP_MODELS: DownloadableModel[] = catalog.map((model) => ({
  ...model,
  engine: model.engine as DownloadableModel["engine"],
  group: model.group as DownloadableModel["group"],
  digestAlgorithm: "sha256",
  installed: false
}));
