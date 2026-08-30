import type { MeetingPreferences, SystemPermissionValue } from "../types";

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

export type PermissionSetupPhase =
  | "microphone"
  | "screen-settings"
  | "restart"
  | "verify"
  | "success";

export const PERMISSION_SETUP_VERSION = 2;

/** 是否需要打开权限向导；恢复标记优先于旧流程的完成状态。 */
export function shouldOpenPermissionSetup(input: Pick<MeetingPreferences,
  "permissionSetupResume" | "systemPermissionsCompleted" | "permissionsVersion"
>) {
  return input.permissionSetupResume
    || !input.systemPermissionsCompleted
    || input.permissionsVersion < PERMISSION_SETUP_VERSION;
}

/** 完成和跳过共用同一收尾，确保恢复标记不会让流程再次弹出。 */
export function finishPermissionSetup(preferences: MeetingPreferences): MeetingPreferences {
  return {
    ...preferences,
    systemPermissionsCompleted: true,
    permissionsVersion: PERMISSION_SETUP_VERSION,
    permissionSetupResume: false
  };
}

/** 屏幕/系统音频权限失败：改为可恢复的系统设置/重启引导，不直接展示浏览器底层错误。 */
export function isScreenPermissionError(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(String(error.name));
}

/** 首次授权墙的单一阶段状态机；界面文案和主操作全部由它派生。 */
export function derivePermissionSetupPhase(input: {
  microphone: SystemPermissionValue;
  screen: SystemPermissionValue;
  systemAudioRequired: boolean;
  capturePrepared: boolean;
  returnedFromScreenSettings?: boolean;
  restartRequired?: boolean;
}): PermissionSetupPhase {
  if (input.microphone !== "granted") return "microphone";
  if (!input.systemAudioRequired) return "success";
  if (input.restartRequired) return "restart";
  if (input.screen !== "granted") {
    return input.returnedFromScreenSettings ? "restart" : "screen-settings";
  }
  return input.capturePrepared ? "success" : "verify";
}
