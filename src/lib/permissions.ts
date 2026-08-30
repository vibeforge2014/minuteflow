import type { SystemPermissionValue } from "../types";

/** 录音 hook/App 用它把普通采集失败和需要展示权限引导的失败区分开。 */
export const MICROPHONE_PERMISSION_REQUIRED = "[MICROPHONE_PERMISSION_REQUIRED]";

/** 只要状态不是明确 granted 就尝试请求；真实可用性最终仍由 getUserMedia 决定。 */
export function shouldRequestMicrophone(status: SystemPermissionValue) {
  return status !== "granted";
}

/** Chromium 在不同平台/版本上使用的麦克风拒绝错误名。 */
export function isMicrophonePermissionError(error: unknown) {
  return error instanceof Error && ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error.name);
}

export type PermissionSetupAction =
  | "request-microphone"
  | "open-microphone-settings"
  | "open-screen-settings"
  | "verify-system-audio"
  | "complete";

/** 首次授权墙的唯一下一步，避免多个按钮同时暗示不同的操作顺序。 */
export function getPermissionSetupAction(input: {
  microphone: SystemPermissionValue;
  screen: SystemPermissionValue;
  systemAudioRequired: boolean;
  capturePrepared: boolean;
}): PermissionSetupAction {
  if (input.microphone !== "granted") {
    return input.microphone === "denied" || input.microphone === "restricted"
      ? "open-microphone-settings"
      : "request-microphone";
  }
  if (input.systemAudioRequired && input.screen !== "granted") return "open-screen-settings";
  if (input.systemAudioRequired && !input.capturePrepared) return "verify-system-audio";
  return "complete";
}
