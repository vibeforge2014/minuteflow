/**
 * 导入任务的状态文案与可操作性判断（纯函数）。
 * 导入抽屉、会后文档顶部与转写视图共用同一套口径，避免三处对“处理中/可重试”
 * 理解不一致。
 *
 * 所属层：渲染层纯工具函数。
 * 主要导出：describeImportProcessing、describeImportProgressDetail、
 * describeDiarizationPhase、isActiveImportJob、isRetryableImportJob、
 * mergeImportJob、mergeImportJobs、selectMeetingImportJob。
 */
import type { ImportJob } from "../types";
import { formatDuration } from "./format";

/** 仍在后台推进、尚未进入终态或等待态的任务。 */
const ACTIVE_IMPORT_STATUSES: ImportJob["status"][] = [
  "queued", "copying", "preparing", "transcribing", "diarizing", "summarizing"
];

/** 失败/取消/网络等待：可以直接重新排队，从持久化断点继续。 */
const RETRYABLE_IMPORT_STATUSES: ImportJob["status"][] = [
  "failed", "cancelled", "waiting_for_network"
];

export function isActiveImportJob(job?: ImportJob) {
  return Boolean(job && ACTIVE_IMPORT_STATUSES.includes(job.status));
}

export function isRetryableImportJob(job?: ImportJob) {
  return Boolean(job && RETRYABLE_IMPORT_STATUSES.includes(job.status));
}

function jobTimestamp(job: ImportJob) {
  return job.updatedAt || job.createdAt || "";
}

/** 合并单个任务快照：同 id 保留更新时间较新的那份，其余按更新时间倒序。 */
export function mergeImportJob(current: ImportJob[], job: ImportJob) {
  const existing = current.find((item) => item.id === job.id);
  const next = existing && jobTimestamp(existing) > jobTimestamp(job)
    ? current
    : [job, ...current.filter((item) => item.id !== job.id)];
  return [...next].sort((left, right) => jobTimestamp(right).localeCompare(jobTimestamp(left)));
}

/**
 * 合并一批任务快照（如启动时回填的列表）：逐条按 id 合并。
 * 直接替换整个列表会丢掉刚经推送到达、尚未写进这批快照的新状态。
 */
export function mergeImportJobs(current: ImportJob[], incoming: ImportJob[]) {
  return incoming.reduce((jobs, job) => mergeImportJob(jobs, job), current);
}

/**
 * 选出「当前会议真正需要展示」的任务。
 * 同一会议可能同时存在历史完成任务和正在进行的重新转录：已完成的旧任务
 * 一旦按时间排到前面（或列表短暂滞后），界面会误判为「没有在处理」，
 * 让「重新转录」按钮在处理过程中闪回。进行中的任务必须永远优先。
 */
export function selectMeetingImportJob(jobs: ImportJob[], meetingId?: string) {
  if (!meetingId) return undefined;
  const candidates = jobs
    .filter((job) => job.meetingId === meetingId)
    .sort((left, right) => jobTimestamp(right).localeCompare(jobTimestamp(left)));
  return candidates.find(isActiveImportJob) ?? candidates[0];
}

/** 说话人分离子阶段 → 用户能理解的“正在做什么”。 */
export function describeDiarizationPhase(phase: ImportJob["diarizationPhase"]) {
  switch (phase) {
    case "preparing": return "准备音频";
    case "loading": return "加载本地模型";
    case "analyzing": return "分析音频";
    case "refining": return "校准说话人";
    case "naming": return "匹配声纹";
    case "skipping": return "正在跳过识别";
    default: return "分析音频";
  }
}

/** 从 ISO 开始时间算出已用秒数（供每秒刷新的组件调用）。 */
export function importElapsedSeconds(startedAt: string | undefined, now = Date.now()) {
  if (!startedAt) return undefined;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return undefined;
  return Math.max(0, Math.floor((now - started) / 1000));
}

/** 任务主标题（用于文档顶部与转写状态行）。 */
export function describeImportProcessing(job: ImportJob | undefined) {
  if (!job || job.status === "complete") return undefined;
  if (job.status === "cancelled") return "处理已暂停，可继续未完成的阶段";
  if (job.status === "failed") return "录音处理已暂停，可直接重试";
  if (job.status === "waiting_for_model") return "录音已归档，等待配置转写模型";
  if (job.status === "waiting_for_summary_model") return "录音已归档，等待配置总结模型";
  if (job.status === "waiting_for_audio_tool") return "录音已归档，等待音频组件恢复";
  if (job.status === "waiting_for_network") return "转写服务暂时不可达，等待网络恢复";
  if (job.status === "transcribing" || job.stage === "transcribing") {
    return job.totalChunks
      ? `正在转写第 ${Math.min((job.completedChunks || 0) + 1, job.totalChunks)}/${job.totalChunks} 段`
      : "正在生成第一段转写";
  }
  if (job.status === "diarizing") {
    return job.diarizationSkipped ? "已跳过识别，正在用现有转写生成纪要" : "转写完成，正在识别发言人";
  }
  if (job.status === "summarizing") return "转写完成，正在整理会议纪要";
  if (job.status === "copying" || job.stage === "copying") return "正在安全归档录音";
  return "录音已加入处理队列";
}

/**
 * 任务副标题：说话人分离显示阶段、音频规模与真实已用时间；
 * 转写显示分块进度；失败/等待态显示具体原因。
 */
export function describeImportProgressDetail(job: ImportJob | undefined, now = Date.now()) {
  if (!job) return undefined;
  if (job.status === "diarizing") {
    const elapsed = importElapsedSeconds(job.diarizationStartedAt, now);
    const parts = [describeDiarizationPhase(job.diarizationPhase)];
    if (job.diarizationAudioDurationMs) {
      parts.push(`音频 ${formatDuration(job.diarizationAudioDurationMs / 1000)}`);
    }
    if (elapsed !== undefined) parts.push(`已用 ${formatDuration(elapsed)}`);
    parts.push("本地处理，不上传音频");
    return parts.join(" · ");
  }
  if (job.status === "transcribing" || job.stage === "transcribing") {
    if (!job.totalChunks) return "音频会按自然停顿切段，首段文本很快出现";
    return `已完成 ${Math.min(job.completedChunks || 0, job.totalChunks)}/${job.totalChunks} 段`;
  }
  if (job.status === "summarizing") return undefined;
  if (job.status === "cancelled") {
    return job.transcriptionComplete
      ? "转写已完成；重试会从说话人识别或纪要阶段继续"
      : "已完成的转写与录音都会保留，重试会从断点继续";
  }
  if (job.status === "failed") return job.error || "处理中断，可从已完成的阶段继续";
  if (job.status === "waiting_for_network") return job.error || "网络恢复后会自动从断点继续";
  if (job.status === "waiting_for_model" || job.status === "waiting_for_summary_model") {
    return job.error || "配置好模型后会自动继续，已归档音频不会丢失";
  }
  if (job.status === "waiting_for_audio_tool") return job.error || "恢复应用内置音频组件后继续";
  return undefined;
}

/** 进度条宽度（0-1）；仅用于展示，真实阶段仍以状态文案为准。 */
export function importProgressFraction(job: ImportJob | undefined) {
  if (!job) return 0;
  return Math.min(1, Math.max(0, job.progress || 0));
}
