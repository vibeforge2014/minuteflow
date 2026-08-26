/**
 * 桌面工作区的阶段模型。
 *
 * 会议数据只保存业务状态；界面阶段由持久化状态与当前渲染进程里的录音 phase
 * 共同推导，避免为了 UI 再新增数据库字段。
 */
import type {
  MeetingMode,
  MeetingStatus,
  SystemPermissionValue
} from "../types";

export type RecorderPhase = "idle" | "starting" | "recording" | "paused" | "stopping";
export type WorkspaceStage = "prepare" | "live" | "review";

export interface RecordingReadinessItem {
  id: "capture" | "microphone" | "transcription";
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "attention" | "neutral";
}

export interface RecordingReadiness {
  items: RecordingReadinessItem[];
  hasTranscription: boolean;
  microphoneNeedsAttention: boolean;
}

/**
 * 阶段切换时是否自动打开右栏：会前保持专注；会中始终显示实时转写；
 * 会后只有确有逐字稿或后台处理状态时才打开，避免空白侧栏挤压纪要正文。
 */
export function shouldAutoOpenRightPanel(input: {
  stage: WorkspaceStage;
  transcriptCount: number;
  hasProcessingStatus?: boolean;
}) {
  if (input.stage === "prepare") return false;
  if (input.stage === "live") return true;
  return input.transcriptCount > 0 || Boolean(input.hasProcessingStatus);
}

/**
 * starting/stopping 属于会中：此时必须持续显示录音状态与取消/保存反馈。
 * renderer 刚恢复时 meeting 可能仍是 recording/paused，短暂归入 live，随后录音
 * hook 会将不可恢复的会话标记为 interrupted 并自然回到 prepare。
 */
export function deriveWorkspaceStage(
  meetingStatus: MeetingStatus,
  recorderPhase: RecorderPhase
): WorkspaceStage {
  if (recorderPhase !== "idle" || meetingStatus === "recording" || meetingStatus === "paused") {
    return "live";
  }
  if (meetingStatus === "complete") return "review";
  return "prepare";
}

/**
 * 把已有权限/模型信息整理成会前可读状态。这里只读系统状态，不触发权限申请。
 */
export function buildRecordingReadiness(input: {
  mode: MeetingMode;
  microphone: SystemPermissionValue | null;
  transcriptionProfileName?: string;
}): RecordingReadiness {
  const microphone = describeMicrophone(input.microphone);
  const transcriptionReady = Boolean(input.transcriptionProfileName);

  return {
    hasTranscription: transcriptionReady,
    microphoneNeedsAttention: microphone.tone === "attention",
    items: [
      {
        id: "capture",
        label: "录音范围",
        value: input.mode === "online" ? "麦克风 + 系统音频" : "仅麦克风",
        detail: input.mode === "online"
          ? "适合线上会议，分别记录你的声音与会议声音。"
          : "适合线下交流，并保留现场发言内容。",
        tone: "ready"
      },
      {
        id: "microphone",
        label: "麦克风权限",
        value: microphone.value,
        detail: microphone.detail,
        tone: microphone.tone
      },
      {
        id: "transcription",
        label: "实时转写",
        value: input.transcriptionProfileName || "尚未配置",
        detail: transcriptionReady
          ? "录音开始后会持续生成转写内容。"
          : "仍可安全录音，但本次不会产生实时转写。",
        tone: transcriptionReady ? "ready" : "attention"
      }
    ]
  };
}

function describeMicrophone(value: SystemPermissionValue | null): Pick<RecordingReadinessItem, "value" | "detail" | "tone"> {
  if (value === "granted") {
    return { value: "已允许", detail: "开始录音时仍会验证真实输入设备。", tone: "ready" };
  }
  if (value === "denied" || value === "restricted") {
    return { value: "需要处理", detail: "系统已阻止访问，请前往系统设置允许麦克风。", tone: "attention" };
  }
  if (value === "not-determined") {
    return { value: "开始时确认", detail: "点击开始录音后，系统会请求麦克风权限。", tone: "neutral" };
  }
  return { value: "正在检查", detail: "开始录音时会再次确认真实麦克风输入。", tone: "neutral" };
}
