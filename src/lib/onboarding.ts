/** 首次模型向导的纯就绪判断；与 UI 分离，便于测试且不影响 React Fast Refresh。 */
import type { ModelProfile } from "../types";

export const LOCAL_WHISPER_TRANSPORTS = new Set([
  "whisper-cpp",
  "whisper-python",
  "faster-whisper",
  "mlx-whisper"
]);

/** 档案是否足以让向导把转录标记为已配置。Apple 语音识别零配置（无 baseUrl/model）即就绪。
 *  智谱式多可用语义：配置即就绪（enabled 缺省视为 true），与是否默认档无关。 */
export function isOnboardingTranscriptionReady(profile: ModelProfile) {
  if (profile.enabled === false || profile.kind !== "stt") return false;
  if (profile.transport === "apple-speech") return true;
  if (LOCAL_WHISPER_TRANSPORTS.has(profile.transport)) return Boolean(profile.options.modelPath);
  return Boolean(profile.baseUrl.trim() && profile.model.trim());
}

/** 档案是否是用户已配置的在线/本地大模型，而不是规则式基础纪要（配置即就绪）。 */
export function isOnboardingSummaryReady(profile: ModelProfile) {
  if (profile.enabled === false || profile.kind !== "llm" || profile.transport === "local-summary") return false;
  return Boolean(profile.baseUrl.trim() && profile.model.trim());
}
