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
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  loadAudioAsset,
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
  transcribeWithMlxWhisper,
  transcribeWithQwen3Asr
} from "./providers.mjs";
import { decodeWithSherpaAsr, mapSenseVoiceLanguage } from "./asr-runtime.mjs";
import { applyDiarization, diarizeWithSherpa } from "./diarization.mjs";
import { transcribeWithAppleSpeech } from "./apple-speech.mjs";
import { chunkPlanDefaults, importTranscriptionRoute, isLocalModelGatedRoute, resolveJobProfile } from "./import-profiles.mjs";
import { managedFfmpegPath, resolveLocalModelProfile } from "./local-models.mjs";
import { simplifyTranscriptResult } from "./chinese.mjs";
import { groupTranscriptSegments, splitTimedTranscriptText } from "./transcript-grouping.mjs";
import { parseSilenceMidpoints, planTranscriptionChunkBoundaries } from "./chunk-planning.mjs";
import { normalizeGlossary, transcriptionLanguageForEngine } from "./transcription-prompt.mjs";
import { enhanceTranscriptionAudio } from "./transcription-audio.mjs";
import { isSilenceSkipEnabled, isSilentPcmWav } from "./audio-quality.mjs";
import { withSegmentConfidence } from "./transcript-confidence.mjs";
import { resolveTranscriptionLanguage } from "../../shared/transcription-options.mjs";

/** 与 main.mjs 的 transcribeLocally 同构：按 transport 分派本地 Whisper 转录。
 *  术语表与前文和实时录音链路一致地注入 initial_prompt；此前导入链路传空数组，
 *  同一批专有名词在「录音」和「导入」两条路径下写法会不一致。
 *  Apple Speech / sherpa ASR / Qwen3-ASR 与在线服务不在此列：路由见 import-profiles.mjs 的 importTranscriptionRoute。 */
function transcribeLocal(profile, audio, fileName, language, signal, glossary, previousText) {
  switch (profile.transport) {
    case "whisper-python":
      return transcribeWithPythonWhisper(profile, audio, fileName, language, glossary, signal, previousText);
    case "faster-whisper":
      return transcribeWithFasterWhisper(profile, audio, fileName, language, glossary, signal, previousText);
    case "mlx-whisper":
      return transcribeWithMlxWhisper(profile, audio, fileName, language, glossary, signal, previousText);
    default:
      return transcribeWithWhisperCpp(profile, audio, fileName, language, glossary, signal, previousText);
  }
}

/**
 * sherpa ASR（SenseVoice / Parakeet）的导入块解码：切块本身就是 16k 单声道 WAV
 * （本路由不加 Apple 滤镜），直接把块文件交给常驻 worker，不写临时文件。
 * 无字级时间戳：返回整块文本，交给 normalizeImportChunkSegments 按块出段。
 */
async function transcribeWithSherpaAsrFile(profile, wavPath, language) {
  if (!wavPath) throw new Error("转录块文件缺失，请重试。");
  const result = await decodeWithSherpaAsr(profile, wavPath, {
    language: profile.transport === "sense-voice" ? mapSenseVoiceLanguage(language) : "",
    numThreads: 2
  });
  return { text: String(result?.text ?? ""), segments: [] };
}

/**
 * 转录一个导入切块。apple-speech 是本机引擎（切块已是 16k 单声道 WAV，helper 直接
 * 识别，绝不能落进 transcribeRemote——那会拿空 baseUrl 发 HTTP 请求报「网络错误」），
 * 且本机识别对同一音频存在偶发失败：静默重试一次再交给调用方分类（no_speech 跳过 /
 * 其他错误按原语义处理）。长块（30 秒）把 helper 超时放宽到 100 秒。
 */
async function transcribeImportChunk(route, profile, audio, chunkIndex, language, signal, audioFilePath, glossary = [], previousText = "") {
  const fileName = `chunk-${chunkIndex}.wav`;
  const attempts = route === "apple-speech" ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 400);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal?.aborted) throw lastError;
    }
    try {
      if (route === "apple-speech") {
        // 档案级开关：默认本机离线（音频不出设备）；用户显式开启在线识别后走
        // Apple 服务器模型——对难识别音频（术语密集、口音、压缩噪声）质量差距巨大。
        return await transcribeWithAppleSpeech(profile, audio, fileName, language, glossary, {
          signal,
          timeoutMs: 100_000,
          allowServer: profile.options?.allowServer === true
        });
      }
      if (route === "sherpa") {
        // SenseVoice / Parakeet 无 prompt 通道，语言锁定仍通过 language 参数生效。
        return await transcribeWithSherpaAsrFile(profile, audioFilePath, language);
      }
      if (route === "qwen3-asr") {
        return await transcribeWithQwen3Asr(profile, audio, fileName, language, glossary, signal, previousText);
      }
      if (route === "whisper") {
        return await transcribeLocal(profile, audio, fileName, language, signal, glossary, previousText);
      }
      return await transcribeRemote(profile, readSecret(profile.secretId), audio, fileName, language, glossary, signal, previousText);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError;
}

async function prepareArchivedChunk({ route, bundledFfmpeg, chunkPath, controller, leadingMs = 0 }) {
  const original = await readFile(chunkPath);
  const silent = isSilentPcmWav(original, { leadingMs });
  if (silent && isSilenceSkipEnabled()) return { silent, audio: null };
  const audio = await enhanceTranscriptionAudio(original, bundledFfmpeg, controller.signal);
  if (route === "sherpa" && !audio.equals(original)) await writeFile(chunkPath, audio);
  return { silent, audio };
}

async function recognizeArchivedChunk(options, prepared) {
  const { profile, route, chunkPath, chunkIndex, language, controller, glossary, previousText } = options;
  const { silent, audio } = prepared ?? await prepareArchivedChunk(options);
  if (!audio) return { silent, result: { text: "", segments: [] } };
  let raw;
  try {
    raw = await transcribeImportChunk(route, profile, audio, chunkIndex, language, controller.signal, chunkPath, glossary, previousText);
  } catch (error) {
    if (error?.appleSpeechCode !== "no_speech") throw error;
    raw = { text: "", segments: [] };
  }
  return { silent, result: withSegmentConfidence(simplifyTranscriptResult(raw)) };
}

// 运行中的任务取消器与子进程句柄：cancelImport 借此中止在途转录/转码。
const activeControllers = new Map();
// jobId → Set<ChildProcess>：一个任务可能同时/先后拉起多个 FFmpeg，取消时要全部终止。
const activeProcesses = new Map();
// 说话人识别的独立中止器：跳过识别只终止这个阶段，不取消整条导入任务。
const activeDiarizationSkips = new Map();
// 单 worker 门闩：同一时刻只有一个 runQueue 循环在消费队列，保证任务串行、互不抢占。
let running = false;
// 任务状态变化回调，由 main.mjs 注入（转发为 imports:job-updated 推送）。
let notify = () => {};
// 会议快照变化回调：每完成一个转录块即推给渲染层，右栏无需轮询。
let notifyMeeting = () => {};
// 偏好里的自定义术语；由 main.mjs 注入，避免服务层反向依赖主进程模块。
let getGlossary = async () => [];

const LEGACY_TRANSCRIPTION_CHUNK_MS = 60_000;
const LEGACY_TRANSCRIPTION_OVERLAP_MS = 1_000;
// v3：切块边界吸附最近静音中点（引擎相关的目标网格见 import-profiles.mjs 的
// chunkPlanDefaults），避免把词切成两半；计划持久化后重启不漂移。
const TRANSCRIPTION_PLAN_VERSION = 4;
const PARAGRAPHING_VERSION = 2;

const summaryListKeys = ["keyPoints", "decisions", "openQuestions", "risks", "nextSteps"];

/**
 * 导入会议识别完发言人后，把逐字稿里的说话人标签回填到参与者字段。
 * 只在参与者仍是占位值时回填，避免覆盖用户在会议头里手写的真实名单。
 */
export function resolveImportedParticipants(meeting, transcript = meeting?.transcript ?? []) {
  const current = Array.isArray(meeting?.participants) ? meeting.participants : [];
  const placeholderOnly = current.length === 0 || current.every((name) => name === "待识别");
  if (!placeholderOnly) return current;
  return [...new Set(transcript
    .map((segment) => segment?.speakerName)
    .filter((name) => typeof name === "string" && name.trim()))];
}

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

/** 导入中的纪要是本地预览，最终在线请求在转写和说话人分离完成后执行。 */
function maybeUpdateRollingSummary(job, meeting) {
  const sourceThroughMs = meeting.transcript.at(-1)?.endMs ?? 0;
  const previousThroughMs = job.lastSummaryThroughMs || 0;
  const lastSummaryAt = job.lastSummaryAt ? Date.parse(job.lastSummaryAt) : 0;
  const firstReady = previousThroughMs === 0 && sourceThroughMs >= 30_000;
  const nextReady = previousThroughMs > 0
    && sourceThroughMs - previousThroughMs >= 45_000
    && Date.now() - lastSummaryAt >= 45_000;
  if (!firstReady && !nextReady) return { job, meeting };

  const summary = summarizeLocally({
    title: meeting.title, goals: meeting.goals, notes: meeting.notes, transcript: meeting.transcript
  });
  meeting = publishMeeting(saveMeeting({
    ...meeting,
    summary: {
      ...mergeSummaryPreservingLocks(meeting.summary, summary),
      updatedAt: new Date().toISOString(), generationMode: "local", sourceThroughMs, stale: false
    }
  }));
  job = patchJob(job.id, {
    lastSummaryThroughMs: sourceThroughMs,
    lastSummaryCompletedChunks: job.completedChunks || 0,
    lastSummaryAt: new Date().toISOString()
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

/** 启动时由 main.mjs 注入通知回调与偏好读取（把任务状态变化推给渲染层）。 */
export function configureImportQueue(options = {}) {
  notify = options.notify || notify;
  notifyMeeting = options.notifyMeeting || notifyMeeting;
  if (typeof options.getGlossary === "function") getGlossary = options.getGlossary;
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
      explicitLanguage: options.language || undefined,
      defaultLanguage: options.defaultLanguage,
      transcriptionTerms: normalizeGlossary(options.transcriptionTerms).slice(0, 12),
      language: resolveTranscriptionLanguage(options.language, resolveJobProfile(listModelProfiles(), "stt", options.sttProfileId)?.options, options.defaultLanguage),
      sttProfileId: options.sttProfileId,
      llmProfileId: options.llmProfileId,
      diarizationEnabled: options.diarizationEnabled !== false,
      autoSummarize: options.autoSummarize !== false,
      chunkingVersion: TRANSCRIPTION_PLAN_VERSION,
      // 切块时长不预填：开工时按所选引擎取策略（Apple Speech 30 秒长窗），再随
      // 边界计划一起落库绑定，保证断点续跑稳定。
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
  const previousImport = listImportJobs().find((job) => job.meetingId === meetingId && !job.recordingBackfill);
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
    language: resolveTranscriptionLanguage(options.language, resolveJobProfile(listModelProfiles(), "stt", options.sttProfileId)?.options, options.defaultLanguage),
    explicitLanguage: options.language || undefined,
    defaultLanguage: options.defaultLanguage,
    transcriptionTerms: previousImport?.transcriptionTerms,
    sttProfileId: options.sttProfileId,
    llmProfileId: options.llmProfileId,
    diarizationEnabled: options.diarizationEnabled !== false,
    autoSummarize: options.autoSummarize !== false,
    previousTranscript: meeting.transcript,
    chunkingVersion: TRANSCRIPTION_PLAN_VERSION,
    // 切块时长不预填（与 enqueueImports 同理）：开工时按引擎定并落库绑定。
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

/** 录音落盘后，复用持久化队列补转未提交的音频区间。 */
export function enqueueRecordingBackfill(meetingId, sessionId, { ranges, sttProfileId, language }, archivedTracks) {
  const now = new Date().toISOString();
  const recordingRanges = ranges.flatMap((range) => {
    const { track, startMs, endMs, offsetMs } = range ?? {};
    if (!["microphone", "system"].includes(track) || !archivedTracks[track]
      || ![startMs, endMs, offsetMs].every(Number.isSafeInteger)
      || offsetMs < 0 || startMs < offsetMs || endMs <= startMs) return [];
    return [{ track, startMs, endMs, offsetMs, audioAssetId: `${sessionId}:${track}` }];
  });
  if (!recordingRanges.length) return;
  publish(saveJob({
    id: randomUUID(), meetingId, type: "import", title: loadMeeting(meetingId).title,
    sourceName: "现场录音", status: "queued", stage: "transcribing", progress: 0,
    language, sttProfileId, recordingBackfill: true, recordingRanges,
    transcriptionGaps: recordingRanges.map(({ startMs, endMs }) => ({ startMs, endMs })),
    createdAt: now, updatedAt: now
  }));
  void runQueue();
}

/** 重试失败任务：状态复位为 queued 并重新驱动队列（imports:retry 通道调用）。 */
export function retryImport(id, sttProfileId, preferences = {}) {
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
  const hasGaps = Boolean(job.transcriptionGaps?.length);
  if (job.status === "complete" && !hasGaps) return job;
  const profile = sttProfileId && listModelProfiles().find((item) => item.id === sttProfileId && item.kind === "stt");
  if (sttProfileId && !profile) throw new Error("所选转录模型已删除，请重新选择。");
  const retryingTranscriptionGaps = !job.recordingBackfill
    && hasGaps && (job.retryingTranscriptionGaps || job.completedChunks >= job.totalChunks);
  // 重试是干净的一轮：清掉上一轮的网络退避计数与说话人分离进度，
  // 避免 UI 继续显示旧的“已用时间/阶段”。
  const next = patchJob(id, {
    ...(retryingTranscriptionGaps ? {
      retryingTranscriptionGaps: true,
      retryingCompletedTranscription: job.retryingCompletedTranscription || job.status === "complete",
      transcriptionComplete: false,
      stage: "transcribing"
    } : {}),
    ...(profile ? {
      sttProfileId: profile.id,
      language: resolveTranscriptionLanguage(job.explicitLanguage, profile.options, preferences.transcriptionLanguage)
    } : {}),
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
  for (const child of activeProcesses.get(id) ?? []) {
    try { child.kill("SIGTERM"); } catch { /* 子进程已退出 */ }
  }
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
  const next = patchJob(id, {
    diarizationSkipped: true, diarizationOutcome: "skipped",
    ...(job.status === "diarizing" ? { diarizationPhase: "skipping" } : {})
  });
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

/** 在转写同时分析发言人。最终阶段复用分析结果，取消或暂停任务会终止 worker。 */
function startImportDiarization(job, profiles, controller) {
  if (!job.diarizationEnabled || job.diarizationSkipped || job.diarizationComplete || job.retryingCompletedTranscription) return;
  const profile = resolveJobProfile(profiles, "diarization");
  if (!profile?.options?.segmentationModelPath || !profile?.options?.embeddingModelPath) {
    patchJob(job.id, { diarizationOutcome: "unavailable" });
    return;
  }
  const skipController = new AbortController();
  activeDiarizationSkips.set(job.id, skipController);
  const signal = combineAbortSignals(controller.signal, skipController.signal);
  patchJob(job.id, {
    diarizationStartedAt: new Date().toISOString(), diarizationPhase: "preparing", diarizationOutcome: "pending"
  });
  const analysis = { turns: undefined };
  analysis.done = diarizeWithSherpa(profile, job.archivedPath, {
    voiceprints: listVoiceprintSamples(),
    diarizationCheckpoint: job.diarizationCheckpoint?.profileId === profile.id ? job.diarizationCheckpoint : undefined,
    signal,
    onProgress: ({ phase, audioDurationMs, window }) => {
      if (!phase || signal.aborted || isJobCancelled(job.id, controller)) return;
      const current = loadJob(job.id);
      if (!current) return;
      const checkpoint = current.diarizationCheckpoint?.profileId === profile.id ? current.diarizationCheckpoint : undefined;
      const patch = {};
      if (phase !== current.diarizationPhase) patch.diarizationPhase = phase;
      if (audioDurationMs && audioDurationMs !== current.diarizationAudioDurationMs) patch.diarizationAudioDurationMs = audioDurationMs;
      if (window && window.throughSample > (checkpoint?.throughSample ?? 0)) {
        patch.diarizationProcessedMs = window.processedMs;
        patch.diarizationCheckpoint = {
          profileId: profile.id, throughSample: window.throughSample, turns: [...(checkpoint?.turns ?? []), ...window.turns]
        };
      }
      if (Object.keys(patch).length) patchJob(job.id, patch);
    }
  }).then((turns) => {
    if (!signal.aborted) analysis.turns = turns;
  }).catch((error) => {
    if (!signal.aborted) analysis.error = error;
  });
  return analysis;
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
  // 提升到函数作用域，finally 才能在取消/失败/等待网络等所有提前 return 的路径
  // 上清理切块目录（此前只有转录全部成功才删，异常任务会留下成百上千个 WAV）。
  let chunkDirectory;
  let nextPreparedChunk;
  try {
    let job = loadJob(initial.id);
    if (!job || job.status === "cancelled") return;

    if (!job.recordingBackfill && !job.archivedPath) {
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

    if (!job.recordingBackfill && !job.playbackReady && [".flac", ".mov"].includes(path.extname(job.archivedPath).toLowerCase())) {
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
    if (isLocalModelGatedRoute(sttProfile.transport)) {
      const resolution = await resolveLocalProfile(sttProfile);
      if (isJobCancelled(job.id, controller)) return;
      sttProfile = resolution.profile;
      if (resolution.readiness.status !== "ready") {
        patchJob(job.id, { status: "waiting_for_model", stage: "transcribing", progress: Math.max(job.progress, 0.28), error: `${resolution.readiness.message}请在转录设置中下载模型后重试。` });
        return;
      }
    }
    if (job.sttProfileId !== sttProfile.id) {
      job = patchJob(job.id, {
        sttProfileId: sttProfile.id,
        language: resolveTranscriptionLanguage(job.explicitLanguage, sttProfile.options, job.defaultLanguage ?? job.language)
      });
    }

    if (job.recordingBackfill) {
      chunkDirectory = path.join(app.getPath("temp"), `minuteflow-backfill-${job.id}`);
      await processRecordingBackfill(job, sttProfile, controller, chunkDirectory);
      return;
    }

    let meeting = loadMeeting(job.meetingId);
    const speakerAnalysis = startImportDiarization(job, profiles, controller);
    let subtitleLabelsApplied = false;
    if (!job.transcriptionComplete) {
      // 渐进式转录：新任务用应用内 FFmpeg 生成约 10 秒 WAV 块并带短重叠；
      // 每块完成后立刻换算全局时间戳、落库并广播，右侧转录栏可持续追加内容。
      const bundledFfmpeg = await managedFfmpegPath();
      if (!bundledFfmpeg) {
        patchJob(job.id, { status: "waiting_for_audio_tool", stage: "preparing", error: "应用内置音频组件无法加载，请重新安装 MinuteFlow。原文件已安全归档。" });
        return;
      }
      const durationMs = job.durationMs || await probeAudioDuration(job.id, bundledFfmpeg, job.archivedPath, controller.signal);
      // 已经产生过转录的旧任务继续沿用 60 秒计划；未开始和新任务按引擎取切块策略
      // （Apple Speech 用 30 秒长窗保上下文，Whisper/远程维持 10 秒），防止改变断点
      // 后重切已有内容。计划参数持久化，重启后不会漂移。
      const legacyInProgress = !job.chunkingVersion && (job.completedChunks || 0) > 0;
      const enginePlan = chunkPlanDefaults(sttProfile.transport);
      // 已开工任务的切块计划视为绑定（断点续跑不漂移）；未开工时按引擎策略计算，
      // 随边界计划一起落库。入队不再预填时长，避免旧默认压掉 Apple Speech 长窗。
      const planBound = Boolean(job.chunkDurationMs)
        && ((job.completedChunks || 0) > 0 || (Array.isArray(job.chunkBoundaries) && job.chunkBoundaries.length > 0));
      const chunkDurationMs = planBound && job.chunkDurationMs
        ? job.chunkDurationMs
        : (legacyInProgress ? LEGACY_TRANSCRIPTION_CHUNK_MS : enginePlan.chunkMs);
      const chunkOverlapMs = planBound && job.chunkOverlapMs
        ? job.chunkOverlapMs
        : (legacyInProgress ? LEGACY_TRANSCRIPTION_OVERLAP_MS : enginePlan.overlapMs);
      let chunkingVersion = job.chunkingVersion || (legacyInProgress ? 1 : TRANSCRIPTION_PLAN_VERSION);
      // v3 起，先对整段录音做一次静音扫描，把切块边界吸附到目标网格附近的自然停顿。
      // 边界计划随任务落库：崩溃重启后沿用同一份切点，已完成块的 id 与时间轴保持稳定。
      // 已开工却没有边界计划的任务（理论不可达）、扫描失败或没有可用静音时回落固定网格。
      let chunkBoundaries = Array.isArray(job.chunkBoundaries) && job.chunkBoundaries.length
        ? job.chunkBoundaries
        : null;
      if (!chunkBoundaries && chunkingVersion >= 3 && !(job.completedChunks > 0)) {
        const silenceMidpoints = await detectSilenceMidpoints(job.id, bundledFfmpeg, job.archivedPath, controller.signal, durationMs);
        if (isJobCancelled(job.id, controller)) return;
        chunkBoundaries = planTranscriptionChunkBoundaries(durationMs, silenceMidpoints, enginePlan.planning);
      }
      if (chunkBoundaries && chunkingVersion === 3 && importTranscriptionRoute(sttProfile.transport) === "whisper") {
        const completed = job.completedChunks || 0;
        const remainingFrom = chunkBoundaries[completed];
        if (remainingFrom !== undefined && !job.retryingTranscriptionGaps && durationMs > remainingFrom) {
          const suffix = planTranscriptionChunkBoundaries(durationMs - remainingFrom, [], enginePlan.planning);
          chunkBoundaries = [...chunkBoundaries.slice(0, completed), ...suffix.map((time) => time + remainingFrom)];
        }
        chunkingVersion = TRANSCRIPTION_PLAN_VERSION;
      }
      if (isJobCancelled(job.id, controller)) return;
      const useAdaptiveBoundaries = Boolean(chunkBoundaries);
      const totalChunks = useAdaptiveBoundaries
        ? chunkBoundaries.length
        : Math.max(1, Math.ceil(durationMs / chunkDurationMs));
      let completedChunks = Math.min(job.completedChunks || 0, totalChunks);
      chunkDirectory = path.join(path.dirname(job.archivedPath), `transcription-${job.id}`);
      await mkdir(chunkDirectory, { recursive: true });
      job = patchJob(job.id, {
        status: "transcribing", stage: "transcribing", progress: 0.35,
        sttProfileId: sttProfile.id, durationMs, totalChunks, completedChunks,
        chunkingVersion, chunkDurationMs, chunkOverlapMs,
        chunkBoundaries: useAdaptiveBoundaries ? chunkBoundaries : undefined,
        paragraphingVersion: job.paragraphingVersion || PARAGRAPHING_VERSION
      });
      // 术语表在任务开始时读一次：用户在转录途中编辑术语不会让同一份逐字稿前后
      // 用词不一致。每块把最近定稿段落作为前文送进 prompt，保持专名与断句风格连续。
      const glossary = normalizeGlossary([...(job.transcriptionTerms ?? []), ...await getGlossary().catch(() => [])]);
      const configuredLanguage = transcriptionLanguageForEngine(job.language);
      const retryingGaps = job.retryingTranscriptionGaps === true;
      let gaps = job.transcriptionGaps ?? [];
      const targets = retryingGaps
        ? gaps.map((gap) => gap.chunkIndex)
        : Array.from({ length: totalChunks - completedChunks }, (_, index) => completedChunks + index);
      const transcriptionRoute = importTranscriptionRoute(sttProfile.transport);
      const boundsFor = (chunkIndex) => {
        const nominalStartMs = useAdaptiveBoundaries ? chunkBoundaries[chunkIndex] : chunkIndex * chunkDurationMs;
        const extractionStartMs = Math.max(0, nominalStartMs - (chunkIndex ? chunkOverlapMs : 0));
        const chunkEndMs = useAdaptiveBoundaries
          ? (chunkBoundaries[chunkIndex + 1] ?? durationMs)
          : Math.min(durationMs, nominalStartMs + chunkDurationMs);
        const chunkPath = path.join(chunkDirectory, `chunk-${String(chunkIndex).padStart(5, "0")}.wav`);
        return { nominalStartMs, extractionStartMs, chunkEndMs, chunkPath };
      };
      const prepareChunk = async ({ extractionStartMs, nominalStartMs, chunkEndMs, chunkPath }) => {
        // 静音检测使用原始音量；FFmpeg 增强后的 PCM 可以直接交给本地 Whisper。
        await extractTranscriptionChunk(job.id, bundledFfmpeg, job.archivedPath, chunkPath,
          extractionStartMs, chunkEndMs - extractionStartMs, controller.signal);
        return prepareArchivedChunk({
          route: transcriptionRoute, bundledFfmpeg, chunkPath, controller,
          leadingMs: nominalStartMs - extractionStartMs
        });
      };
      for (const [targetIndex, chunkIndex] of targets.entries()) {
        if (isJobCancelled(job.id, controller)) return;
        const bounds = boundsFor(chunkIndex);
        const { nominalStartMs, extractionStartMs, chunkEndMs, chunkPath } = bounds;
        const previousText = (meeting?.transcript ?? [])
          .filter((segment) => segment.endMs <= nominalStartMs)
          .slice(-3).map((segment) => segment.text).join("");
        job = patchJob(job.id, {
          status: "transcribing",
          currentChunkStartMs: nominalStartMs,
          currentChunkEndMs: chunkEndMs,
          progress: 0.35 + 0.33 * targetIndex / Math.max(1, targets.length)
        });
        const prepared = await (nextPreparedChunk ?? prepareChunk(bounds));
        nextPreparedChunk = undefined;
        if (isJobCancelled(job.id, controller)) return;
        const nextChunkIndex = targets[targetIndex + 1];
        if (transcriptionRoute === "whisper" && nextChunkIndex !== undefined) {
          // 一次只预取一块，取音与增强用 CPU，与当前 GPU 推理重叠。逐块按序落盘。
          nextPreparedChunk = prepareChunk(boundsFor(nextChunkIndex));
          void nextPreparedChunk.catch(() => {});
        }
        const { result, silent } = await recognizeArchivedChunk({
          profile: sttProfile, route: transcriptionRoute, bundledFfmpeg, chunkPath,
          chunkIndex, language: configuredLanguage, controller, glossary, previousText
        }, prepared);
        if (isJobCancelled(job.id, controller)) return;
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
        if (chunkSegments.length || !retryingGaps) {
          const turns = speakerAnalysis?.turns;
          const labeledChunks = turns?.length ? applyDiarization(chunkSegments, turns) : chunkSegments;
          const labeledExisting = turns?.length && !subtitleLabelsApplied && !retryingGaps
            ? applyDiarization(retained, turns)
            : retained;
          if (turns?.length && !retryingGaps && !subtitleLabelsApplied) {
            subtitleLabelsApplied = true;
            job = patchJob(job.id, { diarizationOutcome: "identified" });
          }
          const combined = [...labeledExisting, ...labeledChunks].sort((left, right) => left.startMs - right.startMs);
          // Keep atomic recognition timestamps until the separate model knows who spoke.
          const transcript = retryingGaps || (speakerAnalysis && !turns?.length)
            ? combined
            : groupTranscriptSegments(combined);
          meeting = publishMeeting(saveMeeting({
            ...meeting,
            durationSeconds: Math.max(0, Math.round(durationMs / 1000)),
            ...(job.retranscribe || retryingGaps ? {} : { status: "draft" }),
            transcript,
            summary: { ...meeting.summary, stale: chunkSegments.length > 0 || meeting.summary.stale }
          }));
        }
        gaps = gaps.filter((gap) => gap.chunkIndex !== chunkIndex);
        if (!silent && !chunkSegments.length) gaps.push({ chunkIndex, startMs: nominalStartMs, endMs: chunkEndMs });
        completedChunks = Math.max(completedChunks, chunkIndex + 1);
        job = patchJob(job.id, {
          completedChunks,
          transcriptionGaps: gaps.sort((left, right) => left.startMs - right.startMs),
          progress: 0.35 + 0.33 * (targetIndex + 1) / Math.max(1, targets.length),
          ...(job.transcriptionRetryAttempts ? { transcriptionRetryAttempts: 0 } : {})
        });
        if (!retryingGaps) ({ job, meeting } = maybeUpdateRollingSummary(job, meeting));
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
      if (!meeting.transcript.length || job.retryingCompletedTranscription) {
        meeting = loadMeeting(job.meetingId) || meeting;
        const noSpeech = !meeting.transcript.length && !gaps.length;
        const noResult = !meeting.transcript.length && gaps.length > 0;
        publishMeeting(saveMeeting({ ...meeting, status: "complete" }));
        patchJob(job.id, {
          status: noResult ? "failed" : "complete",
          stage: "complete", progress: 1, transcriptionComplete: !noResult,
          transcriptionNoSpeech: noSpeech, retryingTranscriptionGaps: false,
          retryingCompletedTranscription: undefined,
          currentChunkStartMs: undefined, currentChunkEndMs: undefined,
          error: noResult ? "模型未返回转写。可更换模型，仅重试待补转时段。" : undefined
        });
        return;
      }
      // 转写成稿即会议结束：后续说话人识别与纪要生成属于会后加工，会议状态
      // 不该等到整条任务跑完才从 draft 变成 complete。
      meeting = publishMeeting(saveMeeting({ ...meeting, status: "complete" }));
      job = patchJob(job.id, {
        transcriptionComplete: true, transcriptionNoSpeech: false, retryingTranscriptionGaps: false, stage: "diarizing", progress: 0.68,
        completedChunks: totalChunks, currentChunkStartMs: undefined, currentChunkEndMs: undefined
      });
    }
    if (isJobCancelled(job.id, controller)) return;

    if (job.diarizationEnabled && !job.diarizationComplete) {
      if (speakerAnalysis) {
        job = patchJob(job.id, { status: "diarizing", stage: "diarizing", progress: 0.73 });
        await speakerAnalysis.done;
        if (isJobCancelled(job.id, controller)) return;
      }
      job = loadJob(job.id);
      if (!job) return;
      if (speakerAnalysis?.error && !job.diarizationSkipped) throw speakerAnalysis.error;
      const turns = speakerAnalysis?.turns;
      if (turns?.length && !subtitleLabelsApplied && !job.diarizationSkipped) {
        meeting = loadMeeting(job.meetingId) || meeting;
        meeting = publishMeeting(saveMeeting({
          ...meeting, transcript: groupTranscriptSegments(applyDiarization(meeting.transcript, turns))
        }));
      }
      const diarizationOutcome = job.diarizationSkipped ? "skipped"
        : turns?.length ? "identified" : speakerAnalysis ? "unresolved" : "unavailable";
      if (!turns?.length && speakerAnalysis) {
        meeting = loadMeeting(job.meetingId) || meeting;
        meeting = publishMeeting(saveMeeting({ ...meeting, transcript: groupTranscriptSegments(meeting.transcript) }));
      }
      const participants = resolveImportedParticipants(meeting);
      if (participants.length) {
        meeting = publishMeeting(saveMeeting({ ...meeting, participants }));
      }
      job = patchJob(job.id, {
        diarizationComplete: true, diarizationOutcome,
        diarizationPhase: undefined, diarizationStartedAt: undefined, diarizationAudioDurationMs: undefined,
        diarizationCheckpoint: undefined, diarizationProcessedMs: undefined,
        stage: "summarizing", progress: 0.8
      });
    }
    if (isJobCancelled(job.id, controller)) return;

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
      if (llmProfile && llmProfile.transport !== "local-summary") {
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
      meeting = loadMeeting(job.meetingId) || meeting;
      meeting = publishMeeting(saveMeeting({
        ...meeting,
        summary: {
          ...mergeSummaryPreservingLocks(meeting.summary, ordinarySummary),
          stale: meeting.title !== input.title
        }
      }));
      job = patchJob(job.id, { summaryComplete: true, progress: 0.98 });
    } else if (!job.autoSummarize) {
      if (isJobCancelled(job.id, controller)) return;
      meeting = loadMeeting(job.meetingId) || meeting;
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
    patchJob(job.id, {
      status: "complete", stage: "complete", progress: 1,
      error: undefined
    });
  } catch (error) {
    const current = loadJob(initial.id);
    // AbortController 已取消时，即使状态刚被重试改回 queued，也不能把旧一轮的
    // 取消异常写成 failed。
    if (!controller.signal.aborted && current?.status !== "cancelled") {
      if (error?.retryable && current?.stage === "transcribing") {
        const attempt = (current.transcriptionRetryAttempts || 0) + 1;
        const delayMs = nextTranscriptionResumeDelayMs(attempt);
        patchJob(initial.id, {
          status: "waiting_for_network",
          transcriptionRetryAttempts: attempt,
          error: `${error.message}（${Math.round(delayMs / 1000)} 秒后自动从断点继续）`
        });
        scheduleQueueAutoResume(delayMs);
      } else {
        patchJob(initial.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "导入处理失败。"
        });
      }
    }
  } finally {
    if (nextPreparedChunk) {
      controller.abort();
      await nextPreparedChunk.catch(() => {});
    }
    activeControllers.delete(initial.id);
    activeProcesses.delete(initial.id);
    activeDiarizationSkips.get(initial.id)?.abort();
    activeDiarizationSkips.delete(initial.id);
    if (chunkDirectory) {
      await rm(chunkDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function processRecordingBackfill(job, profile, controller, directory) {
  const bundledFfmpeg = await managedFfmpegPath();
  if (isJobCancelled(job.id, controller)) return;
  if (!bundledFfmpeg) {
    patchJob(job.id, { status: "waiting_for_audio_tool", error: "内置音频组件无法加载，请重新安装 MinuteFlow。" });
    return;
  }
  await mkdir(directory, { recursive: true });
  const glossary = normalizeGlossary(await getGlossary().catch(() => []));
  const language = transcriptionLanguageForEngine(job.language);
  const route = importTranscriptionRoute(profile.transport);
  const ranges = job.recordingRanges;
  let remaining = [...ranges];
  let completedChunks = 0;
  for (const [index, range] of ranges.entries()) {
    if (isJobCancelled(job.id, controller)) return;
    const asset = loadAudioAsset(range.audioAssetId);
    if (!asset || asset.meetingId !== job.meetingId) throw new Error("未找到归档录音，无法补转。");
    patchJob(job.id, {
      status: "transcribing", totalChunks: ranges.length, completedChunks,
      currentChunkStartMs: range.startMs, currentChunkEndMs: range.endMs
    });
    const chunkPath = path.join(directory, "chunk.wav");
    await extractTranscriptionChunk(job.id, bundledFfmpeg, asset.path, chunkPath,
      range.startMs - range.offsetMs, range.endMs - range.startMs, controller.signal);
    const previousText = (loadMeeting(job.meetingId)?.transcript ?? [])
      .filter((segment) => segment.track === range.track && segment.endMs <= range.startMs)
      .slice(-3).map((segment) => segment.text).join("");
    const { result, silent } = await recognizeArchivedChunk({
      profile, route, bundledFfmpeg, chunkPath, chunkIndex: index, language, controller, glossary, previousText
    });
    if (isJobCancelled(job.id, controller)) return;
    const meeting = loadMeeting(job.meetingId);
    if (!meeting) return;
    const prefix = `${job.id}:live:${range.track}:${range.startMs}:`;
    const alreadySaved = meeting.transcript.some((segment) => segment.id.startsWith(prefix));
    const sameTrack = meeting.transcript.filter((segment) => segment.track === range.track);
    const overlapping = sameTrack.filter((segment) => segment.startMs < range.endMs && segment.endMs > range.startMs);
    const source = alreadySaved ? [] : normalizeImportChunkSegments(result, range.startMs, range.startMs, range.endMs, prefix, overlapping);
    if (source.length) {
      const systemTrack = range.track === "system";
      const segments = groupTranscriptSegments(source.map((segment) => ({
        ...segment, track: range.track,
        speakerId: systemTrack ? "remote" : "me",
        speakerName: systemTrack ? "远端发言人" : "我"
      })));
      publishMeeting(saveMeeting({
        ...meeting,
        transcript: [...meeting.transcript, ...segments].sort((left, right) => left.startMs - right.startMs),
        summary: { ...meeting.summary, stale: true }
      }));
    }
    if (alreadySaved || silent || source.length) {
      remaining = remaining.filter((entry) => entry !== range);
    }
    completedChunks += 1;
    patchJob(job.id, {
      recordingRanges: remaining,
      transcriptionGaps: remaining.map(({ startMs, endMs }) => ({ startMs, endMs })),
      completedChunks, progress: completedChunks / ranges.length, transcriptionRetryAttempts: 0
    });
  }
  patchJob(job.id, {
    status: "complete", stage: "complete", progress: 1,
    currentChunkStartMs: undefined, currentChunkEndMs: undefined
  });
}

/**
 * 把单个转录块的相对时间换算到整段录音，并过滤 1 秒重叠区内已经落盘的内容。
 * 作为纯函数导出，便于覆盖时间偏移、排序与重试去重测试。
 */
export function normalizeImportChunkSegments(result, extractionStartMs, nominalStartMs, chunkEndMs, idPrefix, existing = []) {
  const sourceSegments = result.segments?.length
    ? result.segments
    : result.text?.trim()
      ? [{ startMs: 0, endMs: Math.max(1, chunkEndMs - extractionStartMs), text: result.text.trim(), confidence: result.confidence }]
      : [];
  const source = sourceSegments.flatMap((segment) => {
    const startMs = Math.max(0, Number(segment.startMs) || 0);
    const endMs = Math.max(startMs + 1, Number(segment.endMs) || Math.max(1, chunkEndMs - extractionStartMs));
    return splitTimedTranscriptText(segment.text, startMs, endMs).map((fragment) => ({
      ...segment,
      ...fragment
    }));
  });
  const overlappingSegments = existing.filter((segment) => segment.endMs > extractionStartMs && segment.startMs < chunkEndMs);
  return source.flatMap((segment, index) => {
    const text = String(segment.text || "").trim();
    if (!text) return [];
    const rawStartMs = extractionStartMs + Math.max(0, Number(segment.startMs) || 0);
    const rawEndMs = extractionStartMs + Math.max(Number(segment.endMs) || 0, Number(segment.startMs) || 0);
    if (rawEndMs <= nominalStartMs || rawStartMs >= chunkEndMs) return [];
    const normalized = normalizeTranscriptText(text);
    // 同一句可能在录音里反复说。只在时间确实相交时匹配预滚重复。
    if (overlappingSegments.some((prior) => {
      const overlap = Math.min(rawEndMs, prior.endMs) - Math.max(rawStartMs, prior.startMs);
      if (overlap <= 0) return false;
      const priorText = normalizeTranscriptText(prior.text);
      return normalized === priorText || (normalized.length >= 6 && overlap >= (rawEndMs - rawStartMs) * 0.8 && priorText.includes(normalized));
    })) return [];
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
      track: "mixed",
      ...(segment.confidence === undefined ? {} : { confidence: segment.confidence })
    }];
  });
}

function normalizeTranscriptText(value) {
  return String(value || "").toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");
}

/** 单个 FFmpeg 子进程最长允许运行 10 分钟；超时后 SIGTERM，3 秒不退再 SIGKILL。 */
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 托管一个 FFmpeg 子进程。此前每个 job 只登记最后一个子进程句柄（单值 Map），
 * 取消时杀不到其他仍在跑的进程；且没有任何超时，损坏文件能让单 worker 队列
 * 永久挂起。这里统一处理：按 job 分组登记全部句柄、超时升级、取消联动，
 * stderr 用数组累积（长录音 silencedetect 输出下避免每 chunk 拷贝 1MB 字符串）。
 */
function spawnFfmpeg(jobId, executable, args, signal, { timeoutMs = FFMPEG_TIMEOUT_MS, keepDetails = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let handles = activeProcesses.get(jobId);
    if (!handles) { handles = new Set(); activeProcesses.set(jobId, handles); }
    handles.add(child);
    const stderrChunks = [];
    let stderrLength = 0;
    let settled = false;
    let timer;
    let killTimer;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const set = activeProcesses.get(jobId);
      set?.delete(child);
      if (set && set.size === 0) activeProcesses.delete(jobId);
    };
    const terminate = (escalate) => {
      try { child.kill(escalate ? "SIGKILL" : "SIGTERM"); } catch { /* 已退出 */ }
      if (!escalate && !killTimer) {
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        }, 3000);
      }
    };
    const onAbort = () => terminate(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => terminate(false), timeoutMs);
    if (signal?.aborted) terminate(false);
    child.stderr?.on("data", (chunk) => {
      if (stderrLength >= keepDetails) return;
      const text = String(chunk);
      stderrChunks.push(text);
      stderrLength += text.length;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code, killedBy) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, killedBy, details: stderrChunks.join("").slice(-keepDetails) });
    });
  });
}

/** 用 FFmpeg 只读媒体头获取总时长，不依赖系统 ffprobe。 */
async function probeAudioDuration(jobId, executable, input, signal) {
  const { details } = await spawnFfmpeg(
    jobId, executable, ["-hide_banner", "-i", input], signal, { keepDetails: 12_000 }
  );
  if (signal.aborted) throw new Error("任务已取消。");
  const match = details.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) throw new Error("无法读取录音时长，请确认文件可以正常播放。");
  const durationMs = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
  if (!(durationMs > 0)) throw new Error("录音时长为空，无法转录。");
  return durationMs;
}

/**
 * 截取并规范化一个 16kHz 单声道 WAV 转录块。
 *
 * 这里刻意只做格式转换、不套音质滤镜：静音门限必须基于原始 PCM，而音质增强
 * 已上移到 runTranscription 的独立步骤（enhanceTranscriptionAudio），由用户偏好
 * 统一控制并覆盖所有引擎。filters 参数保留为空数组的兼容通道：万一将来需要在
 * 切块时加滤镜，失败仍会自动回退一次裸切，保证导入不被滤镜兼容性问题中断。
 */
async function extractTranscriptionChunk(jobId, executable, input, output, startMs, durationMs, signal, filters = []) {
  const run = async (withFilters) => {
    const args = ["-y", "-ss", (startMs / 1000).toFixed(3), "-i", input,
      "-t", (durationMs / 1000).toFixed(3), "-vn", "-ac", "1", "-ar", "16000"];
    if (withFilters.length) args.push("-af", withFilters.join(","));
    args.push("-c:a", "pcm_s16le", output);
    const { code, killedBy, details } = await spawnFfmpeg(jobId, executable, args, signal);
    if (code === 0) return;
    throw new Error(signal.aborted || killedBy ? "任务已取消。" : `准备转录分段失败：${details.trim()}`);
  };
  try {
    await run(filters);
  } catch (error) {
    if (signal.aborted || !filters.length) throw error;
    await run([]);
  }
}

/**
 * 对整段录音做一次静音扫描（ffmpeg silencedetect），返回各静音段中点（毫秒，升序），
 * 供切块边界吸附。尽力而为：启动失败、被取消或解析不到静音都返回空数组，
 * 调用方回落固定网格，静音扫描本身绝不阻断导入。
 */
async function detectSilenceMidpoints(jobId, executable, input, signal, durationMs) {
  try {
    const { details } = await spawnFfmpeg(jobId, executable, [
      "-hide_banner", "-i", input,
      "-af", "silencedetect=noise=-35dB:d=0.3", "-vn", "-f", "null", "-"
    ], signal, {
      // 全程扫描比切块慢，按录音时长放宽但仍封顶；失败一律回落到固定网格切块。
      timeoutMs: Math.min(Math.max(FFMPEG_TIMEOUT_MS, durationMs * 2), 30 * 60 * 1000),
      keepDetails: 1_000_000
    });
    return signal.aborted ? [] : parseSilenceMidpoints(details, durationMs);
  } catch {
    return [];
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
async function runFfmpeg(jobId, executable, input, output, signal) {
  const { code, killedBy, details } = await spawnFfmpeg(
    jobId, executable,
    ["-y", "-i", input, "-vn", "-c:a", "aac", "-b:a", "128k", output],
    signal
  );
  if (code !== 0) {
    throw new Error(signal.aborted || killedBy ? "任务已取消。" : `FFmpeg 转码失败：${details.trim()}`);
  }
}
