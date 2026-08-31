/**
 * 音频导入的持久化后台队列（Electron 主进程 / 服务层）。
 * 单 worker 串行处理导入任务：复制归档 →（部分格式）生成播放副本 → 转录 →
 * 说话人分离 → 自动总结。任务状态全部落库（jobs 表），应用重启后可续跑；
 * 缺模型/组件时任务进入 waiting_for_* 可恢复暂停态，不阻塞其他任务、不弹系统对话框。
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
  listJobs,
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
  summarizeLocally,
  summarizeWithOpenAICompatible,
  transcribeRemote,
  transcribeWithPythonWhisper,
  transcribeWithWhisperCpp,
  transcribeWithFasterWhisper,
  transcribeWithMlxWhisper
} from "./providers.mjs";
import { applyDiarization, diarizeWithSherpa } from "./diarization.mjs";
import { managedFfmpegPath, resolveLocalModelProfile } from "./local-models.mjs";
import { simplifyTranscriptResult } from "./chinese.mjs";
import { groupTranscriptSegments, splitTimedTranscriptText } from "./transcript-grouping.mjs";

const LOCAL_TRANSCRIPTION_TRANSPORTS = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"];
/** 与 main.mjs 的 transcribeLocally 同构：按 transport 分派本地转录（导入流程不注入术语表）。 */
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
// 单 worker 门闩：同一时刻只有一个 runQueue 循环在消费队列，保证任务串行、互不抢占。
let running = false;
// 任务状态变化回调，由 main.mjs 注入（转发为 imports:job-updated 推送）。
let notify = () => {};
// 会议快照变化回调：每完成一个转录块即推给渲染层，右栏无需轮询。
let notifyMeeting = () => {};

const LEGACY_TRANSCRIPTION_CHUNK_MS = 60_000;
const LEGACY_TRANSCRIPTION_OVERLAP_MS = 1_000;
const TRANSCRIPTION_PLAN_VERSION = 2;
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
    ? profiles.find((profile) => profile.kind === "llm" && profile.enabled && (!job.llmProfileId || profile.id === job.llmProfileId))
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

/** 重试失败任务：状态复位为 queued 并重新驱动队列（imports:retry 通道调用）。 */
export function retryImport(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  const next = patchJob(id, { status: "queued", error: undefined });
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
 * 唤醒队列（应用启动、保存模型档案后由 main.mjs 调用）：
 * 把因缺模型/组件暂停（waiting_for_*）的任务复位为 queued 并驱动队列，
 * 让"先导入、后配置模型"的顺序也能自动续跑。
 */
export function wakeImportQueue() {
  for (const job of listImportJobs()) {
    if (["waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool"].includes(job.status)) {
      saveJob({ ...job, status: "queued", error: undefined });
    }
  }
  void runQueue();
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
 * 缺模型/FFmpeg 时置为 waiting_for_* 暂停并返回（可恢复），其余异常标记 failed。
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
      saveAudioAsset({ id: job.audioAssetId, meetingId: job.meetingId, path: job.archivedPath, playbackPath, track: "mixed", sourceType: "import", originalName: job.sourceName, mimeType: "audio/mp4", byteLength: job.sizeBytes });
      job = patchJob(job.id, { playbackPath, playbackReady: true, status: "queued", stage: "transcribing", progress: 0.28 });
    }

    const profiles = listModelProfiles();
    // 尚无可用的转录模型：暂停为可恢复状态，待用户配置后由 wakeImportQueue 续跑。
    let sttProfile = profiles.find((profile) =>
      profile.kind === "stt" && profile.enabled && (!job.sttProfileId || profile.id === job.sttProfileId));
    if (!sttProfile) {
      patchJob(job.id, { status: "waiting_for_model", stage: "transcribing", progress: 0.2 });
      return;
    }
    if (LOCAL_TRANSCRIPTION_TRANSPORTS.includes(sttProfile.transport)) {
      const resolution = await resolveLocalProfile(sttProfile);
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
      const totalChunks = Math.max(1, Math.ceil(durationMs / chunkDurationMs));
      let completedChunks = Math.min(job.completedChunks || 0, totalChunks);
      const chunkDirectory = path.join(path.dirname(job.archivedPath), `transcription-${job.id}`);
      await mkdir(chunkDirectory, { recursive: true });
      job = patchJob(job.id, {
        status: "transcribing", stage: "transcribing", progress: 0.35,
        sttProfileId: sttProfile.id, durationMs, totalChunks, completedChunks,
        chunkingVersion, chunkDurationMs, chunkOverlapMs,
        paragraphingVersion: job.paragraphingVersion || PARAGRAPHING_VERSION
      });
      const language = job.language === "auto" ? "" : job.language;
      for (let chunkIndex = completedChunks; chunkIndex < totalChunks; chunkIndex += 1) {
        if (controller.signal.aborted || loadJob(job.id)?.status === "cancelled") return;
        const nominalStartMs = chunkIndex * chunkDurationMs;
        const extractionStartMs = Math.max(0, nominalStartMs - (chunkIndex ? chunkOverlapMs : 0));
        const chunkEndMs = Math.min(durationMs, nominalStartMs + chunkDurationMs);
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
        const rawResult = LOCAL_TRANSCRIPTION_TRANSPORTS.includes(sttProfile.transport)
          ? await transcribeLocal(sttProfile, audio, `chunk-${chunkIndex}.wav`, language, controller.signal)
          : await transcribeRemote(sttProfile, readSecret(sttProfile.secretId), audio, `chunk-${chunkIndex}.wav`, language, [], controller.signal);
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
          status: "draft",
          transcript: groupTranscriptSegments([...retained, ...chunkSegments]),
          summary: { ...meeting.summary, stale: retained.length + chunkSegments.length > 0 }
        }));
        completedChunks = chunkIndex + 1;
        job = patchJob(job.id, {
          completedChunks,
          progress: 0.35 + (0.33 * completedChunks / totalChunks)
        });
        ({ job, meeting } = await maybeUpdateRollingSummary(job, meeting, profiles, controller.signal));
        await rm(chunkPath, { force: true }).catch(() => {});
      }
      saveAudioAsset({
        id: job.audioAssetId, meetingId: job.meetingId, path: job.archivedPath,
        playbackPath: job.playbackPath, track: "mixed", sourceType: "import",
        originalName: job.sourceName, mimeType: job.mimeType,
        byteLength: job.sizeBytes, durationMs
      });
      await rm(chunkDirectory, { recursive: true, force: true }).catch(() => {});
      job = patchJob(job.id, {
        transcriptionComplete: true, stage: "diarizing", progress: 0.68,
        completedChunks: totalChunks, currentChunkStartMs: undefined, currentChunkEndMs: undefined
      });
    }
    if (controller.signal.aborted) return;

    if (job.diarizationEnabled && !job.diarizationComplete && meeting.transcript.length) {
      meeting = loadMeeting(job.meetingId) || meeting;
      // 说话人分离（可选）：配置了 diarization 档案才执行，按时间中点把轮次套到转录段上。
      const profile = profiles.find((candidate) => candidate.kind === "diarization" && candidate.enabled);
      if (profile) {
        job = patchJob(job.id, { status: "diarizing", stage: "diarizing", progress: 0.73 });
        const turns = await diarizeWithSherpa(profile, job.archivedPath, {
          expectedSpeakers: -1,
          voiceprints: listVoiceprintSamples()
        });
        meeting = publishMeeting(saveMeeting({
          ...meeting,
          transcript: groupTranscriptSegments(applyDiarization(meeting.transcript, turns))
        }));
      }
      job = patchJob(job.id, { diarizationComplete: true, stage: "summarizing", progress: 0.8 });
    }

    if (job.autoSummarize && !job.summaryComplete) {
      meeting = loadMeeting(job.meetingId) || meeting;
      // 最终总结：有 LLM 时生成在线终稿；未配置或调用失败时使用本机基础纪要，
      // 不让已经完成的转录因缺少总结服务停在等待态。
      const llmProfile = profiles.find((profile) =>
        profile.kind === "llm" && profile.enabled && (!job.llmProfileId || profile.id === job.llmProfileId));
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
          summary = summarizeLocally(input);
        }
      } else {
        summary = summarizeLocally(input);
      }
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
      meeting = publishMeeting(saveMeeting({
        ...meeting,
        summary: ordinarySummary
      }));
      job = patchJob(job.id, { summaryComplete: true, progress: 0.98 });
    } else if (!job.autoSummarize) {
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

    meeting = loadMeeting(job.meetingId) || meeting;
    publishMeeting(saveMeeting({ ...meeting, status: "complete" }));
    patchJob(job.id, { status: "complete", stage: "complete", progress: 1, error: undefined });
  } catch (error) {
    const current = loadJob(initial.id);
    if (current?.status !== "cancelled") {
      patchJob(initial.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "导入处理失败。"
      });
    }
  } finally {
    activeControllers.delete(initial.id);
    activeProcesses.delete(initial.id);
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
      speakerName: "发言人 1",
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
