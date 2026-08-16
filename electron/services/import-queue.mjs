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
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  createMeeting,
  listJobs,
  listModelProfiles,
  loadJob,
  loadMeeting,
  saveAudioAsset,
  saveJob,
  saveMeeting
} from "../database.mjs";
import { readSecret } from "./secrets.mjs";
import {
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
}

/** 落库并广播一条任务状态。 */
function publish(job) {
  notify(job);
  return job;
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
    const meeting = createMeeting({
      title: item.title || path.basename(item.sourcePath, path.extname(item.sourcePath)),
      mode: "offline",
      participants: ["待识别"],
      goals: ["转录并整理导入的录音"],
      tags: ["导入"]
    });
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
      autoSummarize: options.autoSummarize !== false
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
      // FFmpeg 缺失时进入可恢复暂停态，原文件已安全归档，不阻塞导入。
      job = patchJob(job.id, { status: "preparing", stage: "preparing", progress: 0.24 });
      const profiles = listModelProfiles();
      const configuredFfmpeg = profiles.find((profile) => profile.kind === "stt" && profile.enabled)?.options?.ffmpegPath;
      const automaticFfmpeg = await managedFfmpegPath();
      const playbackPath = path.join(path.dirname(job.archivedPath), `playback-${job.id}.m4a`);
      try {
        await runFfmpeg(job.id, configuredFfmpeg || automaticFfmpeg || "ffmpeg", job.archivedPath, playbackPath, controller.signal);
      } catch (error) {
        if (error?.code === "ENOENT" || /ffmpeg/i.test(error?.message || "")) {
          patchJob(job.id, { status: "waiting_for_audio_tool", stage: "preparing", error: "需要 FFmpeg 才能为此格式生成播放副本。原文件已安全归档。" });
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
      // 转录阶段：读取归档音频，本地/远程分派；无分段时至少保留整段文本为一条转录。
      job = patchJob(job.id, { status: "transcribing", stage: "transcribing", progress: 0.35, sttProfileId: sttProfile.id });
      const audio = await readFile(job.archivedPath);
      const language = job.language === "auto" ? "" : job.language;
      const result = LOCAL_TRANSCRIPTION_TRANSPORTS.includes(sttProfile.transport)
        ? await transcribeLocal(sttProfile, audio, job.sourceName, language, controller.signal)
        : await transcribeRemote(sttProfile, readSecret(sttProfile.secretId), audio, job.sourceName, language, [], controller.signal);
      const durationSeconds = Math.max(0, Math.round(result.duration || 0));
      const transcript = result.segments?.length
        ? result.segments.map((segment) => ({
            id: randomUUID(), startMs: segment.startMs, endMs: segment.endMs,
            speakerId: "speaker-1", speakerName: "发言人 1", text: segment.text,
            status: "final", track: "mixed"
          }))
        : result.text?.trim()
          ? [{
              id: randomUUID(), startMs: 0, endMs: durationSeconds ? durationSeconds * 1000 : 1,
              speakerId: "speaker-1", speakerName: "发言人 1", text: result.text.trim(),
              status: "final", track: "mixed"
            }]
          : [];
      meeting = saveMeeting({
        ...meeting,
        durationSeconds,
        status: "draft",
        notes: [`已导入录音：${job.sourceName}`],
        notesMarkdown: `已导入录音：${job.sourceName}`,
        transcript,
        summary: { ...meeting.summary, stale: transcript.length > 0 }
      });
      saveAudioAsset({ id: job.audioAssetId, meetingId: job.meetingId, path: job.archivedPath, playbackPath: job.playbackPath, track: "mixed", sourceType: "import", originalName: job.sourceName, mimeType: job.mimeType, byteLength: job.sizeBytes, durationMs: durationSeconds * 1000 });
      job = patchJob(job.id, { transcriptionComplete: true, stage: "diarizing", progress: 0.68 });
    }
    if (controller.signal.aborted) return;

    if (job.diarizationEnabled && !job.diarizationComplete && meeting.transcript.length) {
      // 说话人分离（可选）：配置了 diarization 档案才执行，按时间中点把轮次套到转录段上。
      const profile = profiles.find((candidate) => candidate.kind === "diarization" && candidate.enabled);
      if (profile) {
        job = patchJob(job.id, { status: "diarizing", stage: "diarizing", progress: 0.73 });
        const turns = await diarizeWithSherpa(profile, job.archivedPath, { expectedSpeakers: -1 });
        meeting = saveMeeting({ ...meeting, transcript: applyDiarization(meeting.transcript, turns) });
      }
      job = patchJob(job.id, { diarizationComplete: true, stage: "summarizing", progress: 0.8 });
    }

    if (job.autoSummarize && !job.summaryComplete) {
      // 自动总结：无可用 LLM 档案时暂停为 waiting_for_summary_model（可恢复），会议先置为 complete。
      const llmProfile = profiles.find((profile) =>
        profile.kind === "llm" && profile.enabled && (!job.llmProfileId || profile.id === job.llmProfileId));
      if (!llmProfile) {
        patchJob(job.id, { status: "waiting_for_summary_model", stage: "summarizing", progress: 0.82 });
        saveMeeting({ ...meeting, status: "complete" });
        return;
      }
      job = patchJob(job.id, { status: "summarizing", stage: "summarizing", progress: 0.88, llmProfileId: llmProfile.id });
      const input = {
        title: meeting.title,
        goals: meeting.goals,
        notes: meeting.notes,
        transcript: meeting.transcript,
        previousSummary: meeting.summary
      };
      const summary = llmProfile.transport === "ollama"
        // ollama 本地服务无需密钥，其余远程 LLM 从密钥库取 key。
        ? await summarizeWithOpenAICompatible(llmProfile, "", input, true, controller.signal)
        : await summarizeWithOpenAICompatible(llmProfile, readSecret(llmProfile.secretId), input, true, controller.signal);
      meeting = saveMeeting({ ...meeting, summary: { ...summary, updatedAt: new Date().toISOString(), stale: false } });
      job = patchJob(job.id, { summaryComplete: true, progress: 0.98 });
    } else if (!job.autoSummarize) {
      const summary = summarizeLocally({
        title: meeting.title, goals: meeting.goals, notes: meeting.notes,
        transcript: meeting.transcript, previousSummary: meeting.summary
      });
      meeting = saveMeeting({ ...meeting, summary: { ...summary, updatedAt: new Date().toISOString(), stale: false } });
    }

    saveMeeting({ ...meeting, status: "complete" });
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
    child.on("close", (code, killedBy) => code === 0 ? resolve() : reject(new Error(signal.aborted || killedBy ? "任务已取消。" : `FFmpeg 转码失败：${details.trim()}`)));
  });
}
