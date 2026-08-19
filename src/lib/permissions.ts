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
