/** 首次模型向导的纯就绪判断；与 UI 分离，便于测试且不影响 React Fast Refresh。 */
import type { ModelProfile } from "../types";

export const LOCAL_WHISPER_TRANSPORTS = new Set([
  "whisper-cpp",
  "whisper-python",
  "faster-whisper",
  "mlx-whisper"
]);

/** 档案是否足以让向导把 Whisper 标记为已配置。 */
export function isOnboardingTranscriptionReady(profile: ModelProfile) {
  if (!profile.enabled || profile.kind !== "stt") return false;
  if (LOCAL_WHISPER_TRANSPORTS.has(profile.transport)) return Boolean(profile.options.modelPath);
  return Boolean(profile.baseUrl.trim() && profile.model.trim());
}

/** 档案是否是用户已配置的在线/本地大模型，而不是规则式基础纪要。 */
export function isOnboardingSummaryReady(profile: ModelProfile) {
  if (!profile.enabled || profile.kind !== "llm" || profile.transport === "local-summary") return false;
  return Boolean(profile.baseUrl.trim() && profile.model.trim());
}
