/**
 * 音频导入的持久化后台队列（Electron 主进程 / 服务层）。
 * 单 worker 串行处理导入任务：复制归档 →（部分格式）生成播放副本 → 转录 →
 * 说话人分离 → 自动总结。任务状态全部落库（jobs 表），应用重启后可续跑；
 * 缺模型/组件时任务进入 waiting_for_* 可恢复暂停态，不阻塞其他任务、不弹系统对话框；
 * 远程转录遇持续网络/网关波动时进入 waiting_for_network，按退避自动从断点续跑。
 * 主要导出：configureImportQueue、describeImportFiles、enqueueImports、listImportJobs、
 * retryImport、cancelImport、wakeImportQueue、runQueue。
 * 被 main.mjs 的 imports:* 通道与启动流程调用；内部依赖 database、providers、
 * diarization、local-models、secrets。副作用：复制/转码音频、拉起子进程、网络请求、写库。
 */
import { app } from "electron";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  createMeeting,
  deleteJob,
  listJobs,
  listMeetingAudioAssets,
  listModelProfiles,
  listVoiceprintSamples,
  loadJob,
  loadMeeting,
  saveAudioAsset,
  saveJob,
  saveMeeting
} from "../database.mjs";
import { readSecret } from "./secrets.mjs";
import {
  generateVisualSummaryWithOpenAICompatible,
  isVisualSummaryProfileVerified,
  nextTranscriptionResumeDelayMs,
  summarizeLocally,
  summarizeWithOpenAICompatible,
  transcribeRemote,
  transcribeWithPythonWhisper,
  transcribeWithWhisperCpp,
  transcribeWithFasterWhisper,
  transcribeWithMlxWhisper
} from "./providers.mjs";
import { applyDiarization, diarizeWithSherpa } from "./diarization.mjs";
import { transcribeWithAppleSpeech } from "./apple-speech.mjs";
import { importTranscriptionRoute, resolveJobProfile } from "./import-profiles.mjs";
import { managedFfmpegPath, resolveLocalModelProfile } from "./local-models.mjs";
import { simplifyTranscriptResult } from "./chinese.mjs";
import { groupTranscriptSegments, splitTimedTranscriptText } from "./transcript-grouping.mjs";
import { parseSilenceMidpoints, planTranscriptionChunkBoundaries } from "./chunk-planning.mjs";

/** 与 main.mjs 的 transcribeLocally 同构：按 transport 分派本地 Whisper 转录（导入流程不注入术语表）。
 *  Apple Speech 与在线服务不在此列：路由见 import-profiles.mjs 的 importTranscriptionRoute。 */
function transcribeLocal(profile, audio, fileName, language, signal) {
  switch (profile.transport) {
    case "whisper-python":
      return transcribeWithPythonWhisper(profile, audio, fileName, language, [], signal);
    case "faster-whisper":
      return transcribeWithFasterWhisper(profile, audio, fileName, language, [], signal);
    case "mlx-whisper":
      return transcribeWithMlxWhisper(profile, audio, fileName, language, [], signal);
    default:
      return transcribeWithWhisperCpp(profile, audio, fileName, language, [], signal);
  }
}

// 运行中的任务取消器与子进程句柄：cancelImport 借此中止在途转录/转码。
const activeControllers = new Map();
const activeProcesses = new Map();
// 说话人识别的独立中止器：跳过识别只终止这个阶段，不取消整条导入任务。
const activeDiarizationSkips = new Map();
// 单 worker 门闩：同一时刻只有一个 runQueue 循环在消费队列，保证任务串行、互不抢占。
let running = false;
// 任务状态变化回调，由 main.mjs 注入（转发为 imports:job-updated 推送）。
let notify = () => {};
// 会议快照变化回调：每完成一个转录块即推给渲染层，右栏无需轮询。
let notifyMeeting = () => {};

const LEGACY_TRANSCRIPTION_CHUNK_MS = 60_000;
const LEGACY_TRANSCRIPTION_OVERLAP_MS = 1_000;
// v3：切块边界在 10 秒目标网格附近吸附最近静音中点，避免把词切成两半；计划持久化后重启不漂移。
const TRANSCRIPTION_PLAN_VERSION = 3;
const TRANSCRIPTION_CHUNK_MS = 10_000;
const TRANSCRIPTION_OVERLAP_MS = 2_000;
const PARAGRAPHING_VERSION = 2;

const summaryListKeys = ["keyPoints", "decisions", "openQuestions", "risks", "nextSteps"];

/** 主进程后台合并纪要时保留用户锁定的条目与行动项。 */
function mergeSummaryPreservingLocks(current = {}, incoming = {}) {
  const locks = new Set(current.manualLocks ?? []);
  const merged = { ...incoming, manualLocks: [...locks] };
  merged.topics = locks.has("topics") ? (current.topics ?? []) : (incoming.topics ?? []);
  for (const key of summaryListKeys) {
    const next = [...(incoming[key] ?? [])];
    (current[key] ?? []).forEach((value, index) => {
      if (!locks.has(`${key}:${index}`)) return;
      if (index < next.length) next[index] = value;
      else next.push(value);
    });
    merged[key] = next;
  }
  // keyPointTimes / keyPointHeadlines 与 keyPoints 平行重建：锁定的行沿用 current
  // 的附属值，其余取 incoming（与渲染层 lib/summary 的 mirrorKeyPointField 同步）。
  const mirrorField = (source, fallback) => {
    if (!source && !fallback) return undefined;
    const next = (fallback ?? []).map((value) => value ?? null);
    (source ?? []).forEach((value, index) => {
      if (!locks.has(`keyPoints:${index}`)) return;
      if (index < next.length) next[index] = value ?? null;
      else next.push(value ?? null);
    });
    return next;
  };
  const mirroredTimes = mirrorField(current.keyPointTimes, incoming.keyPointTimes);
  if (mirroredTimes) merged.keyPointTimes = mirroredTimes;
  const mirroredHeadlines = mirrorField(current.keyPointHeadlines, incoming.keyPointHeadlines);
  if (mirroredHeadlines) merged.keyPointHeadlines = mirroredHeadlines;
  const lockedActions = (current.actionItems ?? []).filter((item) => locks.has(`action:${item.id}`));
  const lockedById = new Map(lockedActions.map((item) => [item.id, item]));
  merged.actionItems = [
    ...(incoming.actionItems ?? []).map((item) => lockedById.get(item.id) ?? item),
    ...lockedActions.filter((item) => !(incoming.actionItems ?? []).some((other) => other.id === item.id))
  ];
  merged.visualSummary = incoming.visualSummary
    ?? (current.visualSummary ? { ...current.visualSummary, stale: true } : undefined);
  return merged;
}

/**
 * 转录过程中按有效内容和墙钟时间节流滚动纪要。首版累计 30 秒即可出现，后续至少新增
 * 45 秒音频且距上次请求 45 秒，避免长文件快速处理时产生密集在线调用。
 */
async function maybeUpdateRollingSummary(job, meeting, profiles, signal) {
  const sourceThroughMs = meeting.transcript.reduce((maximum, segment) => Math.max(maximum, segment.endMs || 0), 0);
  const previousThroughMs = job.lastSummaryThroughMs || 0;
  const lastSummaryAt = job.lastSummaryAt ? Date.parse(job.lastSummaryAt) : 0;
  const firstReady = previousThroughMs === 0 && sourceThroughMs >= 30_000;
  const nextReady = previousThroughMs > 0
    && sourceThroughMs - previousThroughMs >= 45_000
    && Date.now() - lastSummaryAt >= 45_000;
  if (!firstReady && !nextReady) return { job, meeting };

  const input = {
    title: meeting.title,
    goals: meeting.goals,
    notes: meeting.notes,
    transcript: meeting.transcript,
    previousSummary: meeting.summary
  };
  const llmProfile = job.autoSummarize
    ? resolveJobProfile(profiles, "llm", job.llmProfileId)
    : undefined;
  let summary;
  let generationMode = "local";
  if (llmProfile) {
    try {
      summary = await summarizeWithOpenAICompatible(
        llmProfile,
        llmProfile.transport === "ollama" ? "" : readSecret(llmProfile.secretId),
        input,
        false,
        signal
      );
      generationMode = "online";
    } catch (error) {
      if (signal.aborted) throw error;
      // 滚动纪要失败静默降级为本机基础版是设计内的，但必须留下失败原因供诊断。
      console.error(`[import] 会议 ${job.meetingId} 在线滚动纪要失败，改用本机基础纪要：${error instanceof Error ? error.message : error}`);
      summary = summarizeLocally(input);
    }
  } else {
    summary = summarizeLocally(input);
  }
  const latest = loadMeeting(job.meetingId) || meeting;
  const latestThroughMs = latest.transcript.reduce((maximum, segment) => Math.max(maximum, segment.endMs || 0), 0);
  meeting = publishMeeting(saveMeeting({
    ...latest,
    summary: {
      ...mergeSummaryPreservingLocks(latest.summary, summary),
      updatedAt: new Date().toISOString(),
      generationMode,
      sourceThroughMs,
      stale: latestThroughMs > sourceThroughMs
    }
  }));
  job = patchJob(job.id, {
    lastSummaryThroughMs: sourceThroughMs,
    lastSummaryCompletedChunks: job.completedChunks || 0,
    lastSummaryAt: new Date().toISOString(),
    llmProfileId: llmProfile?.id ?? job.llmProfileId
  });
  return { job, meeting };
}

/** 导入支持的扩展名 → MIME 类型映射（描述文件与入库用）。 */
const mimeTypes = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime"
};

/** 启动时由 main.mjs 注入通知回调（把任务状态变化推给渲染层）。 */
export function configureImportQueue(options = {}) {
  notify = options.notify || notify;
  notifyMeeting = options.notifyMeeting || notifyMeeting;
}

/** 落库并广播一条任务状态。 */
function publish(job) {
  notify(job);
  return job;
}

/** 保存后的会议快照广播给渲染层。 */
function publishMeeting(meeting) {
  notifyMeeting(meeting);
  return meeting;
}

/** 读取任务、合并补丁、落库并广播（导入流程推进状态的标准入口）。 */
function patchJob(id, patch) {
  const current = loadJob(id);
  if (!current) return null;
  return publish(saveJob({ ...current, ...patch }));
}

/**
 * 任务是否已被用户取消：AbortController 立即生效，任务表可能稍后才被读取。
 * 长阶段（特别是说话人分离）在每个 await 之后都用它确认，避免取消后继续写库、
 * 甚至把 cancelled 覆盖成 summarizing/complete。
 */
function isJobCancelled(jobId, controller) {
  return controller.signal.aborted || loadJob(jobId)?.status === "cancelled";
}

/** 合并任务取消与“跳过本阶段”两个信号（AbortSignal.any 的兼容兜底）。 */
function combineAbortSignals(...signals) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * 生成导入确认抽屉所需的文件描述（大小、类型、修改时间等），
 * 由 imports:choose / imports:describe-dropped 通道调用。文件不存在会抛错。
 */
export async function describeImportFiles(paths) {
  return Promise.all(paths.map(async (filePath) => {
    const fileStat = await stat(filePath);
    const extension = path.extname(filePath).toLowerCase();
    return {
      sourcePath: filePath,
      name: path.basename(filePath),
      title: path.basename(filePath, extension),
      extension: extension.replace(/^\./, "").toUpperCase(),
      mimeType: mimeTypes[extension] || "application/octet-stream",
      sizeBytes: fileStat.size,
      lastModifiedAt: fileStat.mtime.toISOString()
    };
  }));
}

/**
 * 确认导入：为每个文件创建离线会议 + queued 任务并立即驱动队列（imports:enqueue 调用）。
 * 归档、转录、分离、总结全部发生在后台队列中，本函数立刻返回任务列表（非阻塞设计）。
 * @returns {Promise<Array<object>>} 已入队任务（含 meetingId）
 */
export async function enqueueImports(items, options = {}) {
  const jobs = [];
  for (const item of items) {
    const created = createMeeting({
      title: item.title || path.basename(item.sourcePath, path.extname(item.sourcePath)),
      mode: "offline",
      participants: ["待识别"],
      goals: ["转录并整理导入的录音"],
      tags: ["导入"]
    });
    const meeting = publishMeeting(saveMeeting({
      ...created,
      notes: [`已导入录音：${path.basename(item.sourcePath)}`],
      notesMarkdown: `已导入录音：${path.basename(item.sourcePath)}`
    }));
    jobs.push(publish(saveJob({
      id: randomUUID(),
      meetingId: meeting.id,
      type: "import",
      status: "queued",
      stage: "copying",
      progress: 0,
      sourcePath: item.sourcePath,
      sourceName: path.basename(item.sourcePath),
      title: meeting.title,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      language: options.language || "auto",
      sttProfileId: options.sttProfileId,
      llmProfileId: options.llmProfileId,
      diarizationEnabled: options.diarizationEnabled !== false,
      autoSummarize: options.autoSummarize !== false,
      chunkingVersion: TRANSCRIPTION_PLAN_VERSION,
      chunkDurationMs: TRANSCRIPTION_CHUNK_MS,
      chunkOverlapMs: TRANSCRIPTION_OVERLAP_MS,
      paragraphingVersion: PARAGRAPHING_VERSION
    })));
  }
  void runQueue();
  return jobs;
}

/** 列出全部导入任务（imports:list 通道调用）。 */
export function listImportJobs() {
  return listJobs("import");
}

/** 处理中/排队中的任务状态：同一会议同时只允许一条，避免两轮转录互相覆盖。 */
const ACTIVE_JOB_STATUSES = ["queued", "copying", "preparing", "transcribing", "diarizing", "summarizing", "waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool", "waiting_for_network"];

/**
 * 重新转录一场已有会议（imports:retranscribe 通道调用）：
 * 复用导入流水线处理该会议已归档的录音——清空旧逐字稿（原文随任务存档），
 * 重新转写 → 说话人识别 → 生成纪要；笔记与手动锁定的纪要内容由既有合并逻辑保留。
 * 典型场景：录音时在线转写不可用/大面积失败，会后换本地 Whisper 重跑整场。
 */
export async function enqueueRetranscription(meetingId, options = {}) {
  const meeting = loadMeeting(meetingId);
  if (!meeting) throw new Error("会议不存在，可能已被删除。");
  if (meeting.status === "recording" || meeting.status === "paused") {
    throw new Error("这场会议正在录音，请先结束录音再重新转录。");
  }
  const busy = listImportJobs().find((job) => job.meetingId === meetingId && ACTIVE_JOB_STATUSES.includes(job.status));
  if (busy) throw new Error("这场会议已有处理中的任务，请等它完成或先暂停。");
  // live 录音按轨归档为 microphone/system，导入产物才是 mixed——优先 mixed，
  // 否则按 轨优先级 回退（与人声纹提取、回放选择同一口径），并确认文件仍可读——
  // 超过保留期被清理的录音会走到明确的「无法重新转录」提示，而不是排进队列后失败。
  const assets = listMeetingAudioAssets(meetingId).filter((candidate) => candidate.track && candidate.path);
  const newest = (left, right) => String(right.createdAt).localeCompare(String(left.createdAt));
  const asset = assets.find((candidate) => candidate.track === "mixed")
    || assets.find((candidate) => candidate.track === "microphone")
    || assets.find((candidate) => candidate.track === "system")
    || [...assets].sort(newest)[0];
  if (!asset) throw new Error("这场会议没有已归档的录音文件，无法重新转录。");
  try {
    await stat(asset.path);
  } catch {
    throw new Error("这场会议的录音文件已不在磁盘上（可能已按保留策略清理），无法重新转录。");
  }
  const now = new Date().toISOString();
  // 旧逐字稿先收进任务里（previousTranscript），失败/重跑都有据可查；会议侧立即清空，
  // 转录块写入时 retained 自然为空，新结果从零重建，不会与旧段落叠加。
  const job = publish(saveJob({
    id: randomUUID(),
    meetingId,
    type: "import",
    status: "queued",
    stage: "transcribing",
    progress: 0.2,
    retranscribe: true,
    archivedPath: asset.path,
    audioAssetId: asset.id,
    playbackPath: asset.playbackPath,
    playbackReady: true,
    sourceType: asset.sourceType || "recording",
    sourceName: asset.originalName || `${meeting.title}（重新转录）`,
    mimeType: asset.mimeType,
    sizeBytes: asset.byteLength,
    durationMs: asset.durationMs,
    title: meeting.title,
    language: options.language || "auto",
    sttProfileId: options.sttProfileId,
    llmProfileId: options.llmProfileId,
    diarizationEnabled: options.diarizationEnabled !== false,
    autoSummarize: options.autoSummarize !== false,
    previousTranscript: meeting.transcript,
    chunkingVersion: TRANSCRIPTION_PLAN_VERSION,
    chunkDurationMs: TRANSCRIPTION_CHUNK_MS,
    chunkOverlapMs: TRANSCRIPTION_OVERLAP_MS,
    paragraphingVersion: PARAGRAPHING_VERSION,
    createdAt: now,
    updatedAt: now
  }));
  publishMeeting(saveMeeting({
    ...meeting,
    transcript: [],
    summary: { ...meeting.summary, stale: true },
    updatedAt: now
  }));
  void runQueue();
  return job;
}

/** 重试失败任务：状态复位为 queued 并重新驱动队列（imports:retry 通道调用）。 */
export function retryImport(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  // 同一会议只允许一条任务在跑：重试历史任务前先确认没有另一条（例如重新转录）已在进行，
  // 否则两条流水线会先后写同一场会议的逐字稿，界面也会在两条任务间跳来跳去。
  const busy = job.meetingId
    ? listImportJobs().find((candidate) => candidate.id !== id
      && candidate.meetingId === job.meetingId
      && ACTIVE_JOB_STATUSES.includes(candidate.status))
    : undefined;
  if (busy) throw new Error("这场会议已有处理中的任务，请等它完成或先暂停。");
  // 重试是干净的一轮：清掉上一轮的网络退避计数与说话人分离进度，
  // 避免 UI 继续显示旧的“已用时间/阶段”。
  const next = patchJob(id, {
    status: "queued",
    // 复位进度：否则排队期间仍显示上一轮失败时的 73%/88%，看起来像卡住。
    progress: 0,
    error: undefined,
    transcriptionRetryAttempts: 0,
    diarizationPhase: undefined,
    diarizationStartedAt: undefined,
    diarizationAudioDurationMs: undefined
  });
  void runQueue();
  return next;
}

/** 取消任务（imports:cancel 通道调用）：中止 AbortController、SIGTERM 子进程并标记 cancelled。 */
export function cancelImport(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  activeControllers.get(id)?.abort();
  activeProcesses.get(id)?.kill("SIGTERM");
  return patchJob(id, { status: "cancelled", error: undefined });
}

/**
 * 跳过说话人识别（imports:skip-diarization）：保留已完成转写与现有发言人占位，
 * 直接进入纪要阶段。只中止分离 worker，不影响整条任务的断点。
 */
export function skipImportDiarization(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  if (job.diarizationComplete || job.diarizationSkipped) return job;
  if (job.status !== "diarizing") {
    // 尚未进入该阶段（排队/转录中）：记下意图，流水线走到这里时直接跳过。
    return patchJob(id, { diarizationSkipped: true });
  }
  const next = patchJob(id, { diarizationSkipped: true, diarizationPhase: "skipping" });
  activeDiarizationSkips.get(id)?.abort();
  return next;
}

/** 可删除状态：终态 + 可恢复等待态；进行中（含排队）任务必须先取消，避免与 worker 竞争。 */
const REMOVABLE_JOB_STATUSES = ["complete", "cancelled", "failed", "waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool", "waiting_for_network"];

/**
 * 从任务队列移除一条任务记录（imports:remove 通道调用）。
 * 只删队列展示记录，不动已创建的会议与归档音频——那些由会议库的删除/最近删除流程管理。
 */
export function removeImportJob(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  if (!REMOVABLE_JOB_STATUSES.includes(job.status)) {
    throw new Error("任务正在处理中，请先取消再删除。");
  }
  deleteJob(id);
  return { removed: true };
}

/**
 * 唤醒队列（应用启动、保存模型档案后由 main.mjs 调用）：
 * 把因缺模型/组件暂停（waiting_for_*）的任务复位为 queued 并驱动队列，
 * 让"先导入、后配置模型"的顺序也能自动续跑。waiting_for_network 同属可恢复
 * 等待态（网络/网关波动），保留 transcriptionRetryAttempts 使退避节奏跨次递增。
 */
export function wakeImportQueue() {
  for (const job of listImportJobs()) {
    if (["waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool", "waiting_for_network"].includes(job.status)) {
      saveJob({ ...job, status: "queued", error: undefined });
    }
  }
  void runQueue();
}

// 网络波动断点续跑的唤醒定时器：退避结束才驱动队列，平时不空转。
// unref 保证它不阻止应用退出；任务状态已落库，重启后由启动流程的 wakeImportQueue 接管。
let autoResumeTimer;
function scheduleQueueAutoResume(delayMs) {
  clearTimeout(autoResumeTimer);
  autoResumeTimer = setTimeout(() => {
    autoResumeTimer = null;
    wakeImportQueue();
  }, delayMs);
  autoResumeTimer.unref?.();
}

/**
 * 队列主循环（单 worker）：按创建时间逐个取出 queued 任务执行，
 * 直至没有待处理任务。running 门闩保证并发调用只跑一个循环，多余调用直接返回。
 */
export async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const next = listImportJobs()
        .filter((job) => job.status === "queued")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!next) break;
      await processJob(next);
    }
  } finally {
    running = false;
  }
}

/**
 * 执行单个导入任务的完整流水线（副作用：复制文件、转码、转录子进程/网络、写库）。
 * 各阶段用任务字段（archivedPath / playbackReady / transcriptionComplete /
 * diarizationComplete / summaryComplete）记录断点，崩溃重启后从未完成处续跑。
 * 缺模型/FFmpeg 时置为 waiting_for_* 暂停并返回（可恢复）；远程转录的持续网络
 * 波动置为 waiting_for_network 并按退避自动续跑，其余异常标记 failed。
 */
async function processJob(initial) {
  const controller = new AbortController();
  activeControllers.set(initial.id, controller);
  try {
    let job = loadJob(initial.id);
    if (!job || job.status === "cancelled") return;

    if (!job.archivedPath) {
      // 第一步：立即把源文件复制归档进应用数据目录并登记资产，
      // 之后即使源文件被移动/删除，任务仍可继续处理。
      job = patchJob(job.id, { status: "copying", stage: "copying", progress: 0.08 });
      const extension = path.extname(job.sourceName).toLowerCase();
      const directory = path.join(app.getPath("userData"), "meetings", job.meetingId, "audio");
      await mkdir(directory, { recursive: true });
      const archivedPath = path.join(directory, `import-${job.id}${extension}`);
      await copyFile(job.sourcePath, archivedPath);
      // 取消可能发生在复制期间：不要再用 queued 覆盖 cancelled 状态。
      if (isJobCancelled(job.id, controller)) return;
      const fileStat = await stat(archivedPath);
      const asset = saveAudioAsset({
        meetingId: job.meetingId,
        track: "mixed",
        sourceType: "import",
        originalName: job.sourceName,
        mimeType: job.mimeType,
        path: archivedPath,
        byteLength: fileStat.size
      });
      job = patchJob(job.id, {
        archivedPath,
        audioAssetId: asset.id,
        sourcePath: undefined,
        status: "queued",
        stage: "transcribing",
        progress: 0.2
      });
    }
    if (controller.signal.aborted || job.status === "cancelled") return;

    if (!job.playbackReady && [".flac", ".mov"].includes(path.extname(job.archivedPath).toLowerCase())) {
      // FLAC/MOV 浏览器无法直接播放：先用 FFmpeg 生成 m4a 播放副本；
      // 统一使用随应用打包的 FFmpeg；组件缺失时保留已归档原文件并提示重装。
      job = patchJob(job.id, { status: "preparing", stage: "preparing", progress: 0.24 });
      const bundledFfmpeg = await managedFfmpegPath();
      const playbackPath = path.join(path.dirname(job.archivedPath), `playback-${job.id}.m4a`);
      try {
        if (!bundledFfmpeg) throw new Error("应用内置 FFmpeg 缺失。");
        await runFfmpeg(job.id, bundledFfmpeg, job.archivedPath, playbackPath, controller.signal);
      } catch (error) {
        if (error?.code === "ENOENT" || /ffmpeg/i.test(error?.message || "")) {
          patchJob(job.id, { status: "waiting_for_audio_tool", stage: "preparing", error: "应用内置音频组件无法加载，请重新安装 MinuteFlow。原文件已安全归档。" });
          return;
        }
        throw error;
      }
      if (isJobCancelled(job.id, controller)) return;
      saveAudioAsset({ id: job.audioAssetId, meetingId: job.meetingId, path: job.archivedPath, playbackPath, track: "mixed", sourceType: "import", originalName: job.sourceName, mimeType: "audio/mp4", byteLength: job.sizeBytes });
      job = patchJob(job.id, { playbackPath, playbackReady: true, status: "queued", stage: "transcribing", progress: 0.28 });
    }

    const profiles = listModelProfiles();
    // 任务显式钉住的档案优先（导入抽屉可选未启用的已保存档案）；未钉住或档案
    // 已被删除时回落当前启用的档案。尚无任何可用档案：暂停为可恢复的等待态，
    // 待用户配置后由 wakeImportQueue 续跑。
    let sttProfile = resolveJobProfile(profiles, "stt", job.sttProfileId);
    if (!sttProfile) {
      patchJob(job.id, { status: "waiting_for_model", stage: "transcribing", progress: 0.2 });
      return;
    }
    if (importTranscriptionRoute(sttProfile.transport) === "whisper") {
      const resolution = await resolveLocalProfile(sttProfile);
      if (isJobCancelled(job.id, controller)) return;
      sttProfile = resolution.profile;
      if (resolution.readiness.status !== "ready") {
        patchJob(job.id, { status: "waiting_for_model", stage: "transcribing", progress: Math.max(job.progress, 0.28), error: `${resolution.readiness.message}请在转录设置中下载模型后重试。` });
        return;
      }
    }

    let meeting = loadMeeting(job.meetingId);
    if (!job.transcriptionComplete) {
      // 渐进式转录：新任务用应用内 FFmpeg 生成约 10 秒 WAV 块并带短重叠；
      // 每块完成后立刻换算全局时间戳、落库并广播，右侧转录栏可持续追加内容。
      const bundledFfmpeg = await managedFfmpegPath();
      if (!bundledFfmpeg) {
        patchJob(job.id, { status: "waiting_for_audio_tool", stage: "preparing", error: "应用内置音频组件无法加载，请重新安装 MinuteFlow。原文件已安全归档。" });
        return;
      }
      const durationMs = job.durationMs || await probeAudioDuration(job.id, bundledFfmpeg, job.archivedPath, controller.signal);
      // 已经产生过转录的旧任务继续沿用 60 秒计划；未开始和新任务升级到 10 秒，
      // 防止改变断点后重切已有内容。计划参数持久化，重启后不会漂移。
      const legacyInProgress = !job.chunkingVersion && (job.completedChunks || 0) > 0;
      const chunkDurationMs = job.chunkDurationMs
        || (legacyInProgress ? LEGACY_TRANSCRIPTION_CHUNK_MS : TRANSCRIPTION_CHUNK_MS);
      const chunkOverlapMs = job.chunkOverlapMs
        || (legacyInProgress ? LEGACY_TRANSCRIPTION_OVERLAP_MS : TRANSCRIPTION_OVERLAP_MS);
      const chunkingVersion = job.chunkingVersion || (legacyInProgress ? 1 : TRANSCRIPTION_PLAN_VERSION);
      // v3 起，先对整段录音做一次静音扫描，把切块边界吸附到目标网格附近的自然停顿。
      // 边界计划随任务落库：崩溃重启后沿用同一份切点，已完成块的 id 与时间轴保持稳定。
      // 已开工却没有边界计划的任务（理论不可达）、扫描失败或没有可用静音时回落固定网格。
      let chunkBoundaries = Array.isArray(job.chunkBoundaries) && job.chunkBoundaries.length
        ? job.chunkBoundaries
        : null;
      if (!chunkBoundaries && chunkingVersion >= 3 && !(job.completedChunks > 0)) {
        const silenceMidpoints = await detectSilenceMidpoints(job.id, bundledFfmpeg, job.archivedPath, controller.signal, durationMs);
        if (isJobCancelled(job.id, controller)) return;
        chunkBoundaries = planTranscriptionChunkBoundaries(durationMs, silenceMidpoints);
      }
      if (isJobCancelled(job.id, controller)) return;
      const useAdaptiveBoundaries = Boolean(chunkBoundaries);
      const totalChunks = useAdaptiveBoundaries
        ? chunkBoundaries.length
        : Math.max(1, Math.ceil(durationMs / chunkDurationMs));
      let completedChunks = Math.min(job.completedChunks || 0, totalChunks);
      const chunkDirectory = path.join(path.dirname(job.archivedPath), `transcription-${job.id}`);
      await mkdir(chunkDirectory, { recursive: true });
      job = patchJob(job.id, {
        status: "transcribing", stage: "transcribing", progress: 0.35,
        sttProfileId: sttProfile.id, durationMs, totalChunks, completedChunks,
        chunkingVersion, chunkDurationMs, chunkOverlapMs,
        chunkBoundaries: useAdaptiveBoundaries ? chunkBoundaries : undefined,
        paragraphingVersion: job.paragraphingVersion || PARAGRAPHING_VERSION
      });
      const language = job.language === "auto" ? "" : job.language;
      for (let chunkIndex = completedChunks; chunkIndex < totalChunks; chunkIndex += 1) {
        if (controller.signal.aborted || loadJob(job.id)?.status === "cancelled") return;
        const nominalStartMs = useAdaptiveBoundaries ? chunkBoundaries[chunkIndex] : chunkIndex * chunkDurationMs;
        const extractionStartMs = Math.max(0, nominalStartMs - (chunkIndex ? chunkOverlapMs : 0));
        const chunkEndMs = useAdaptiveBoundaries
          ? (chunkIndex + 1 < chunkBoundaries.length ? chunkBoundaries[chunkIndex + 1] : durationMs)
          : Math.min(durationMs, nominalStartMs + chunkDurationMs);
        const chunkPath = path.join(chunkDirectory, `chunk-${String(chunkIndex).padStart(5, "0")}.wav`);
        job = patchJob(job.id, {
          status: "transcribing",
          currentChunkStartMs: nominalStartMs,
          currentChunkEndMs: chunkEndMs,
          progress: 0.35 + (0.33 * chunkIndex / totalChunks)
        });
        await extractTranscriptionChunk(
          job.id, bundledFfmpeg, job.archivedPath, chunkPath,
          extractionStartMs, chunkEndMs - extractionStartMs, controller.signal
        );
        const audio = await readFile(chunkPath);
        const transcriptionRoute = importTranscriptionRoute(sttProfile.transport);
        let rawResult;
        try {
          // apple-speech 是本机引擎（切块已是 16k 单声道 WAV，helper 直接识别），
          // 绝不能落进 transcribeRemote——那会拿空 baseUrl 发 HTTP 请求报「网络错误」。
          rawResult = transcriptionRoute === "apple-speech"
            ? await transcribeWithAppleSpeech(sttProfile, audio, `chunk-${chunkIndex}.wav`, language, [], { signal: controller.signal })
            : transcriptionRoute === "whisper"
              ? await transcribeLocal(sttProfile, audio, `chunk-${chunkIndex}.wav`, language, controller.signal)
              : await transcribeRemote(sttProfile, readSecret(sttProfile.secretId), audio, `chunk-${chunkIndex}.wav`, language, [], controller.signal);
        } catch (error) {
          // 静音块识别不到语音是正常输入，不是失败：按空结果继续，任务不中断。
          if (error?.appleSpeechCode === "no_speech") {
            rawResult = { text: "", segments: [] };
          } else {
            if (controller.signal.aborted || !error?.retryable) throw error;
            // 网关/网络持续波动（请求级重试已耗尽）：进入可恢复等待态，按退避自动从
            // 当前块续跑。断点 = 已完成块数 + 持久化切块计划，崩溃/重启也不会重切重算。
            const attempt = (job.transcriptionRetryAttempts || 0) + 1;
            const delayMs = nextTranscriptionResumeDelayMs(attempt);
            patchJob(job.id, {
              status: "waiting_for_network",
              stage: "transcribing",
              transcriptionRetryAttempts: attempt,
              error: `${error instanceof Error ? error.message : "转录模型请求失败"}（第 ${attempt} 次等待，${Math.round(delayMs / 1000)} 秒后自动从断点继续）`
            });
            scheduleQueueAutoResume(delayMs);
            return;
          }
        }
        const result = simplifyTranscriptResult(rawResult);
        // 用户可能在转录期间编辑标题/笔记/已出现的文本；每块落盘前重读最新会议，
        // 只把本块结果合进去，避免后台快照覆盖前台编辑。
        meeting = loadMeeting(job.meetingId) || meeting;
        const prefix = `${job.id}:chunk:${chunkIndex}:`;
        const previousChunkSegments = new Map(
          meeting.transcript.filter((segment) => segment.id.startsWith(prefix)).map((segment) => [segment.id, segment])
        );
        const retained = meeting.transcript.filter((segment) => !segment.id.startsWith(prefix));
        const chunkSegments = normalizeImportChunkSegments(
          result, extractionStartMs, nominalStartMs, chunkEndMs, prefix, retained
        ).map((segment) => {
          const existing = previousChunkSegments.get(segment.id);
          return existing ? { ...segment, text: existing.text } : segment;
        });
        meeting = publishMeeting(saveMeeting({
          ...meeting,
          durationSeconds: Math.max(0, Math.round(durationMs / 1000)),
          // 重新转录的会议已是会后状态：保持 complete，不要把它打回草稿。
          ...(job.retranscribe ? {} : { status: "draft" }),
          transcript: groupTranscriptSegments([...retained, ...chunkSegments]),
          summary: { ...meeting.summary, stale: retained.length + chunkSegments.length > 0 }
        }));
        completedChunks = chunkIndex + 1;
        job = patchJob(job.id, {
          completedChunks,
          progress: 0.35 + (0.33 * completedChunks / totalChunks),
          // 服务恢复后清零等待计数，下次波动重新从最短退避起步。
          ...(job.transcriptionRetryAttempts ? { transcriptionRetryAttempts: 0 } : {})
        });
        ({ job, meeting } = await maybeUpdateRollingSummary(job, meeting, profiles, controller.signal));
        await rm(chunkPath, { force: true }).catch(() => {});
      }
      if (isJobCancelled(job.id, controller)) return;
      saveAudioAsset({
        id: job.audioAssetId, meetingId: job.meetingId, path: job.archivedPath,
        playbackPath: job.playbackPath, track: "mixed",
        // 重新转录沿用录音资产原本的类型与文件名，不能把它改标成导入产物。
        sourceType: job.retranscribe ? (job.sourceType || "recording") : "import",
        originalName: job.sourceName, mimeType: job.mimeType,
        byteLength: job.sizeBytes, durationMs
      });
      await rm(chunkDirectory, { recursive: true, force: true }).catch(() => {});
      job = patchJob(job.id, {
        transcriptionComplete: true, stage: "diarizing", progress: 0.68,
        completedChunks: totalChunks, currentChunkStartMs: undefined, currentChunkEndMs: undefined
      });
    }
    if (isJobCancelled(job.id, controller)) return;

    if (job.diarizationEnabled && !job.diarizationComplete && !job.diarizationSkipped && meeting.transcript.length) {
      meeting = loadMeeting(job.meetingId) || meeting;
      // 说话人分离（可选）：配置了 diarization 档案才执行，按时间中点把轮次套到转录段上。
      const profile = profiles.find((candidate) => candidate.kind === "diarization" && candidate.enabled);
      let skipped = false;
      if (profile) {
        job = patchJob(job.id, {
          status: "diarizing",
          stage: "diarizing",
          progress: 0.73,
          // 长推理没有细粒度百分比；记录开始时间与阶段，界面显示真实已用时间。
          diarizationStartedAt: new Date().toISOString(),
          diarizationPhase: "preparing",
          diarizationAudioDurationMs: job.durationMs,
          error: undefined
        });
        // 跳过识别有独立信号：只终止分离 worker，转录断点与任务本身继续。
        const skipController = new AbortController();
        activeDiarizationSkips.set(job.id, skipController);
        try {
          const turns = await diarizeWithSherpa(profile, job.archivedPath, {
            expectedSpeakers: -1,
            voiceprints: listVoiceprintSamples(),
            // 取消必须能终止 worker：否则 34 分钟音频的分离会继续跑几分钟。
            signal: combineAbortSignals(controller.signal, skipController.signal),
            onProgress: (progress) => {
              if (!progress?.phase || isJobCancelled(job.id, controller)) return;
              const current = loadJob(job.id);
              if (!current || current.status !== "diarizing" || current.diarizationSkipped) return;
              const patch = {};
              if (current.diarizationPhase !== progress.phase) patch.diarizationPhase = progress.phase;
              if (progress.audioDurationMs && current.diarizationAudioDurationMs !== progress.audioDurationMs) {
                patch.diarizationAudioDurationMs = progress.audioDurationMs;
              }
              if (Object.keys(patch).length) patchJob(job.id, patch);
            }
          });
          if (isJobCancelled(job.id, controller)) return;
          meeting = publishMeeting(saveMeeting({
            ...meeting,
            transcript: groupTranscriptSegments(applyDiarization(meeting.transcript, turns))
          }));
        } catch (error) {
          // 只有“空闲跳过”信号被触发时才降级为跳过；任务级取消仍按取消处理。
          if (!skipController.signal.aborted || controller.signal.aborted) throw error;
          skipped = true;
        } finally {
          activeDiarizationSkips.delete(job.id);
        }
      }
      if (isJobCancelled(job.id, controller)) return;
      job = patchJob(job.id, {
        diarizationComplete: true,
        // 用户主动跳过时打标，避免界面把“未识别”误读为识别失败。
        ...(skipped || job.diarizationSkipped ? { diarizationSkipped: true } : {}),
        diarizationPhase: undefined,
        diarizationStartedAt: undefined,
        diarizationAudioDurationMs: undefined,
        stage: "summarizing",
        progress: 0.8
      });
    } else if (job.diarizationSkipped && !job.diarizationComplete) {
      // 跳过发生在排队/转录阶段：流水线走到这里时直接结项，不再进入分离。
      job = patchJob(job.id, {
        diarizationComplete: true,
        diarizationPhase: undefined,
        diarizationStartedAt: undefined,
        diarizationAudioDurationMs: undefined
      });
    }

    if (job.autoSummarize && !job.summaryComplete) {
      if (isJobCancelled(job.id, controller)) return;
      meeting = loadMeeting(job.meetingId) || meeting;
      // 最终总结：有 LLM 时生成在线终稿；未配置或调用失败时使用本机基础纪要，
      // 不让已经完成的转录因缺少总结服务停在等待态。
      const llmProfile = resolveJobProfile(profiles, "llm", job.llmProfileId);
      job = patchJob(job.id, { status: "summarizing", stage: "summarizing", progress: 0.88, llmProfileId: llmProfile?.id ?? job.llmProfileId });
      const input = {
        title: meeting.title,
        goals: meeting.goals,
        notes: meeting.notes,
        transcript: meeting.transcript,
        previousSummary: meeting.summary
      };
      let summary;
      let generationMode = "local";
      if (llmProfile) {
        try {
          summary = await summarizeWithOpenAICompatible(
            llmProfile,
            llmProfile.transport === "ollama" ? "" : readSecret(llmProfile.secretId),
            input,
            true,
            controller.signal
          );
          generationMode = "online";
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // 终稿失败降级为「本机基础纪要」是设计内行为（界面会标注），此处记录原因供诊断。
          console.error(`[import] 会议 ${job.meetingId} 在线终稿纪要失败，改用本机基础纪要：${error instanceof Error ? error.message : error}`);
          summary = summarizeLocally(input);
        }
      } else {
        summary = summarizeLocally(input);
      }
      if (isJobCancelled(job.id, controller)) return;
      const sourceThroughMs = meeting.transcript.reduce((maximum, segment) => Math.max(maximum, segment.endMs || 0), 0);
      const updatedAt = new Date().toISOString();
      const ordinarySummary = {
        ...mergeSummaryPreservingLocks(meeting.summary, summary),
        updatedAt,
        generationMode,
        sourceThroughMs,
        stale: false
      };
      if (generationMode === "online" && llmProfile && isVisualSummaryProfileVerified(llmProfile)) {
        try {
          ordinarySummary.visualSummary = await generateVisualSummaryWithOpenAICompatible(
            llmProfile,
            llmProfile.transport === "ollama" ? "" : readSecret(llmProfile.secretId),
            {
              title: meeting.title,
              participants: meeting.participants,
              summary: ordinarySummary
            },
            controller.signal
          );
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // 视觉阶段是增强能力；失败不得把已完成的普通纪要或导入任务标记为失败。
        }
      }
      if (isJobCancelled(job.id, controller)) return;
      meeting = publishMeeting(saveMeeting({
        ...meeting,
        summary: ordinarySummary
      }));
      job = patchJob(job.id, { summaryComplete: true, progress: 0.98 });
    } else if (!job.autoSummarize) {
      if (isJobCancelled(job.id, controller)) return;
      const summary = summarizeLocally({
        title: meeting.title, goals: meeting.goals, notes: meeting.notes,
        transcript: meeting.transcript, previousSummary: meeting.summary
      });
      const sourceThroughMs = meeting.transcript.reduce((maximum, segment) => Math.max(maximum, segment.endMs || 0), 0);
      meeting = publishMeeting(saveMeeting({
        ...meeting,
        summary: {
          ...mergeSummaryPreservingLocks(meeting.summary, summary),
          updatedAt: new Date().toISOString(), generationMode: "local", sourceThroughMs, stale: false
        }
      }));
    }

    // 取消可能发生在最后一步之后：绝不能把用户已取消的任务重新标成 complete。
    if (isJobCancelled(job.id, controller)) return;
    meeting = loadMeeting(job.meetingId) || meeting;
    publishMeeting(saveMeeting({ ...meeting, status: "complete" }));
    patchJob(job.id, { status: "complete", stage: "complete", progress: 1, error: undefined });
  } catch (error) {
    const current = loadJob(initial.id);
    // AbortController 已取消时，即使状态刚被重试改回 queued，也不能把旧一轮的
    // 取消异常写成 failed。
    if (!controller.signal.aborted && current?.status !== "cancelled") {
      patchJob(initial.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "导入处理失败。"
      });
    }
  } finally {
    activeControllers.delete(initial.id);
    activeProcesses.delete(initial.id);
    activeDiarizationSkips.delete(initial.id);
  }
}

/**
 * 把单个转录块的相对时间换算到整段录音，并过滤 1 秒重叠区内已经落盘的内容。
 * 作为纯函数导出，便于覆盖时间偏移、排序与重试去重测试。
 */
export function normalizeImportChunkSegments(result, extractionStartMs, nominalStartMs, chunkEndMs, idPrefix, existing = []) {
  const sourceSegments = result.segments?.length
    ? result.segments
    : result.text?.trim()
      ? [{ startMs: 0, endMs: Math.max(1, chunkEndMs - extractionStartMs), text: result.text.trim() }]
      : [];
  const source = sourceSegments.flatMap((segment) => {
    const startMs = Math.max(0, Number(segment.startMs) || 0);
    const endMs = Math.max(startMs + 1, Number(segment.endMs) || Math.max(1, chunkEndMs - extractionStartMs));
    return splitTimedTranscriptText(segment.text, startMs, endMs).map((fragment) => ({
      ...segment,
      ...fragment
    }));
  });
  const recentTexts = existing.slice(-4).map((segment) => normalizeTranscriptText(segment.text));
  return source.flatMap((segment, index) => {
    const text = String(segment.text || "").trim();
    if (!text) return [];
    const rawStartMs = extractionStartMs + Math.max(0, Number(segment.startMs) || 0);
    const rawEndMs = extractionStartMs + Math.max(Number(segment.endMs) || 0, Number(segment.startMs) || 0);
    if (nominalStartMs > 0 && rawEndMs <= nominalStartMs) return [];
    const normalized = normalizeTranscriptText(text);
    if (recentTexts.some((value) => value === normalized || value.includes(normalized))) return [];
    const startMs = Math.max(nominalStartMs, rawStartMs);
    const endMs = Math.max(startMs + 1, Math.min(chunkEndMs, rawEndMs || chunkEndMs));
    return [{
      id: `${idPrefix}${index}`,
      startMs,
      endMs,
      speakerId: "speaker-1",
      speakerName: "发言人1",
      text,
      status: "final",
      track: "mixed"
    }];
  });
}

function normalizeTranscriptText(value) {
  return String(value || "").toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");
}

/** 用 FFmpeg 只读媒体头获取总时长，不依赖系统 ffprobe。 */
function probeAudioDuration(jobId, executable, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-hide_banner", "-i", input], { stdio: ["ignore", "ignore", "pipe"] });
    activeProcesses.set(jobId, child);
    let details = "";
    child.stderr.on("data", (chunk) => { details = `${details}${chunk}`.slice(-12_000); });
    child.on("error", reject);
    child.on("close", () => {
      if (activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      if (signal.aborted) return reject(new Error("任务已取消。"));
      const match = details.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (!match) return reject(new Error("无法读取录音时长，请确认文件可以正常播放。"));
      const durationMs = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
      return durationMs > 0 ? resolve(durationMs) : reject(new Error("录音时长为空，无法转录。"));
    });
  });
}

/** 截取并规范化一个 16kHz 单声道 WAV 转录块。 */
function extractTranscriptionChunk(jobId, executable, input, output, startMs, durationMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      "-y", "-ss", (startMs / 1000).toFixed(3), "-i", input,
      "-t", (durationMs / 1000).toFixed(3), "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le", output
    ], { stdio: ["ignore", "ignore", "pipe"] });
    activeProcesses.set(jobId, child);
    let details = "";
    child.stderr.on("data", (chunk) => { details = `${details}${chunk}`.slice(-2_000); });
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      if (activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      if (code === 0) return resolve();
      reject(new Error(signal.aborted || killedBy ? "任务已取消。" : `准备转录分段失败：${details.trim()}`));
    });
  });
}

/**
 * 对整段录音做一次静音扫描（ffmpeg silencedetect），返回各静音段中点（毫秒，升序），
 * 供切块边界吸附。尽力而为：启动失败、被取消或解析不到静音都返回空数组，
 * 调用方回落固定网格，静音扫描本身绝不阻断导入。
 */
function detectSilenceMidpoints(jobId, executable, input, signal, durationMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, [
      "-hide_banner", "-i", input,
      "-af", "silencedetect=noise=-35dB:d=0.3", "-vn", "-f", "null", "-"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    activeProcesses.set(jobId, child);
    let details = "";
    child.stderr.on("data", (chunk) => { details = `${details}${chunk}`.slice(-1_000_000); });
    child.on("error", () => {
      if (activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      resolve([]);
    });
    child.on("close", () => {
      if (activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      resolve(signal.aborted ? [] : parseSilenceMidpoints(details, durationMs));
    });
  });
}

/** 与 main.mjs 相同的根目录集合解析本地模型档案（应用托管目录 + 下载/缓存目录）。 */
async function resolveLocalProfile(profile) {
  return resolveLocalModelProfile(profile, {
    modelDirectory: path.join(app.getPath("userData"), "models", "whisper"),
    roots: [app.getPath("downloads"), path.join(homedir(), ".cache", "whisper"), path.join(homedir(), ".cache", "huggingface", "hub")]
  });
}

/** 拉起 FFmpeg 转码为 128k AAC 播放副本；句柄登记进 activeProcesses 以支持取消。 */
function runFfmpeg(jobId, executable, input, output, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-y", "-i", input, "-vn", "-c:a", "aac", "-b:a", "128k", output], { stdio: ["ignore", "ignore", "pipe"] });
    activeProcesses.set(jobId, child);
    let details = "";
    child.stderr.on("data", (chunk) => { details = `${details}${chunk}`.slice(-2000); });
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      if (activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      code === 0 ? resolve() : reject(new Error(signal.aborted || killedBy ? "任务已取消。" : `FFmpeg 转码失败：${details.trim()}`));
    });
  });
}
