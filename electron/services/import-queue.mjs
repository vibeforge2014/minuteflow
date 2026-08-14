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
import { discoverLocalModels } from "./local-models.mjs";

const LOCAL_TRANSCRIPTION_TRANSPORTS = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"];
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

const activeControllers = new Map();
const activeProcesses = new Map();
let running = false;
let notify = () => {};

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

export function configureImportQueue(options = {}) {
  notify = options.notify || notify;
}

function publish(job) {
  notify(job);
  return job;
}

function patchJob(id, patch) {
  const current = loadJob(id);
  if (!current) return null;
  return publish(saveJob({ ...current, ...patch }));
}

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

export function listImportJobs() {
  return listJobs("import");
}

export function retryImport(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  const next = patchJob(id, { status: "queued", error: undefined });
  void runQueue();
  return next;
}

export function cancelImport(id) {
  const job = loadJob(id);
  if (!job) throw new Error("导入任务不存在。");
  activeControllers.get(id)?.abort();
  activeProcesses.get(id)?.kill("SIGTERM");
  return patchJob(id, { status: "cancelled", error: undefined });
}

export function wakeImportQueue() {
  for (const job of listImportJobs()) {
    if (["waiting_for_model", "waiting_for_summary_model", "waiting_for_audio_tool"].includes(job.status)) {
      saveJob({ ...job, status: "queued", error: undefined });
    }
  }
  void runQueue();
}

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

async function processJob(initial) {
  const controller = new AbortController();
  activeControllers.set(initial.id, controller);
  try {
    let job = loadJob(initial.id);
    if (!job || job.status === "cancelled") return;

    if (!job.archivedPath) {
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
      job = patchJob(job.id, { status: "preparing", stage: "preparing", progress: 0.24 });
      const profiles = listModelProfiles();
      const configuredFfmpeg = profiles.find((profile) => profile.kind === "stt" && profile.enabled)?.options?.ffmpegPath;
      const playbackPath = path.join(path.dirname(job.archivedPath), `playback-${job.id}.m4a`);
      try {
        await runFfmpeg(job.id, configuredFfmpeg || "ffmpeg", job.archivedPath, playbackPath, controller.signal);
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
    let sttProfile = profiles.find((profile) =>
      profile.kind === "stt" && profile.enabled && (!job.sttProfileId || profile.id === job.sttProfileId));
    if (!sttProfile) {
      patchJob(job.id, { status: "waiting_for_model", stage: "transcribing", progress: 0.2 });
      return;
    }
    if (LOCAL_TRANSCRIPTION_TRANSPORTS.includes(sttProfile.transport)) {
      sttProfile = await resolveLocalProfile(sttProfile);
      const missingModel = !sttProfile.options?.modelPath;
      const missingRuntime = sttProfile.transport === "whisper-cpp"
        ? !sttProfile.options?.executablePath
        : !sttProfile.options?.pythonExecutablePath && !sttProfile.options?.executablePath;
      if (missingModel || missingRuntime) {
        patchJob(job.id, { status: "waiting_for_model", stage: "transcribing", progress: Math.max(job.progress, 0.28), error: "本地 Whisper 组件尚未就绪，请在转录设置中完成自动发现或下载。" });
        return;
      }
    }

    let meeting = loadMeeting(job.meetingId);
    if (!job.transcriptionComplete) {
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
      const profile = profiles.find((candidate) => candidate.kind === "diarization" && candidate.enabled);
      if (profile) {
        job = patchJob(job.id, { status: "diarizing", stage: "diarizing", progress: 0.73 });
        const turns = await diarizeWithSherpa(profile, job.archivedPath, { expectedSpeakers: -1 });
        meeting = saveMeeting({ ...meeting, transcript: applyDiarization(meeting.transcript, turns) });
      }
      job = patchJob(job.id, { diarizationComplete: true, stage: "summarizing", progress: 0.8 });
    }

    if (job.autoSummarize && !job.summaryComplete) {
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

async function resolveLocalProfile(profile) {
  const discovery = await discoverLocalModels({
    modelDirectory: path.join(app.getPath("userData"), "models", "whisper"),
    roots: [app.getPath("downloads"), path.join(homedir(), ".cache", "whisper"), path.join(homedir(), ".cache", "huggingface", "hub")]
  });
  const model = discovery.models.find((candidate) => candidate.engine === profile.transport);
  const isPythonBased = ["whisper-python", "faster-whisper", "mlx-whisper"].includes(profile.transport);
  return {
    ...profile,
    options: {
      ...profile.options,
      ...(!profile.options?.modelPath && model ? { modelPath: model.path } : {}),
      ...(profile.transport === "whisper-cpp" && !profile.options?.executablePath && discovery.runtimes.whisperCpp ? { executablePath: discovery.runtimes.whisperCpp } : {}),
      ...(isPythonBased && !profile.options?.pythonExecutablePath && discovery.runtimes.python ? { pythonExecutablePath: discovery.runtimes.python } : {}),
      ...(!profile.options?.ffmpegPath && discovery.runtimes.ffmpeg ? { ffmpegPath: discovery.runtimes.ffmpeg } : {})
    }
  };
}

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
