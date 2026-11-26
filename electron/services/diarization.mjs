/**
 * 说话人分离服务（Electron 主进程侧门面）：
 * - diarizeWithSherpa：整段离线分离。重推理在独立 utilityProcess
 *   （diarization-worker.mjs）中执行，主进程事件循环不再被长推理阻塞；
 * - extractVoiceprintEmbedding：「给发言人改名后记住」的单人声纹登记，
 *   只喂 ≤30 秒音频，开销小，留在主进程内完成；
 * - applyDiarization / 声纹比对等纯逻辑在 diarization-core.mjs，
 *   与 worker 共用，保证两条路径行为一致。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { managedFfmpegPath } from "./local-models.mjs";
import { computeVoiceprintEmbedding, createVoiceprintExtractor } from "./diarization-core.mjs";
import { splitTimedTranscriptClauses } from "./transcript-grouping.mjs";

export {
  cosineSimilarity,
  mergeDiarizationClusters,
  matchVoiceprint,
  DEFAULT_VOICEPRINT_THRESHOLD,
  DEFAULT_VOICEPRINT_MARGIN
} from "./diarization-core.mjs";

const nodeRequire = createRequire(import.meta.url);

/** 同一个 embedding 模型生成的向量才能互相比对；移动模型文件不影响已保存声纹。 */
export function voiceprintModelKey(profile) {
  const modelPath = profile?.options?.embeddingModelPath;
  return modelPath ? path.basename(modelPath).toLowerCase() : "";
}

/** 拉起子进程并等待退出（windowsHide 防止 Windows 上闪控制台窗口），失败抛出 stderr。 */
function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `音频转换失败，代码 ${code}`));
    });
  });
}

/**
 * 确保输入是 16k 单声道 WAV（分离模型的采样率要求）：
 * 已是 16k 单声道 WAV 才直接复用；其他输入用 FFmpeg 转出临时文件
 * （temporary 标记临时文件需清理）。
 */
async function ensureWave(filePath, sherpaOnnx) {
  if (path.extname(filePath).toLowerCase() === ".wav") {
    try {
      // readWave 默认返回零拷贝外部缓冲数组；Electron 的 V8 禁用外部缓冲区，
      // 必须传 false 让其拷贝进堆（包括本次仅探测采样率的读取）。
      const wave = sherpaOnnx.readWave(filePath, false);
      if (wave.sampleRate === 16_000) return { filePath, temporary: false };
    } catch {
      // 损坏或非标准 WAV 继续交给 FFmpeg，保留其更完整的格式兼容与错误提示。
    }
  }
  const ffmpegPath = await managedFfmpegPath();
  if (!ffmpegPath) throw new Error("应用内置音频组件无法加载，请重新安装 MinuteFlow。");
  const target = path.join(tmpdir(), `${randomUUID()}-diarization.wav`);
  await runProcess(ffmpegPath, [
    "-y", "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", target
  ]);
  return { filePath: target, temporary: true };
}

/**
 * 从已知转录时间区间提取声纹，供“给发言人改名后记住”调用。
 * 音频与向量始终留在 Electron 主进程和本地数据库。
 */
export async function extractVoiceprintEmbedding(profile, audioFilePath, intervals) {
  const embeddingModel = profile?.options?.embeddingModelPath;
  if (!embeddingModel) throw new Error("请先在说话人分离设置中配置 3D-Speaker 模型。");
  let sherpaOnnx;
  try {
    sherpaOnnx = nodeRequire("sherpa-onnx-node");
  } catch {
    throw new Error("未安装 sherpa-onnx-node 运行时，暂时无法记住声纹。");
  }
  const waveAsset = await ensureWave(audioFilePath, sherpaOnnx);
  try {
    const wave = sherpaOnnx.readWave(waveAsset.filePath, false);
    return computeVoiceprintEmbedding(createVoiceprintExtractor(sherpaOnnx, embeddingModel), wave, intervals);
  } finally {
    if (waveAsset.temporary) await unlink(waveAsset.filePath).catch(() => {});
  }
}

/** 兜底上限：1 小时录音的分离实测约 8-10 分钟，给到 30 分钟防 worker 变僵尸进程。 */
const DIARIZATION_WORKER_TIMEOUT_MS = 30 * 60_000;

/**
 * fork diarization-worker 并等待一条结果消息；调用方取消（signal abort）或
 * worker 异常退出/超时都会立即落定 Promise 并回收子进程。
 */
function runDiarizationWorker(request, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = nodeRequire("electron").utilityProcess.fork(
        new URL("./diarization-worker.mjs", import.meta.url).pathname,
        [],
        { serviceName: "minuteflow-diarization", stdio: "ignore" }
      );
    } catch (error) {
      reject(new Error(`无法启动说话人分离进程：${error instanceof Error ? error.message : error}`));
      return;
    }
    let settled = false;
    let unnamedTurns;
    let phase = "startup";
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      signal?.removeEventListener("abort", onAbort);
      try { child.kill(); } catch { /* 已退出 */ }
      settle(value);
    };
    const onAbort = () => finish(reject, new Error("任务已取消。"));
    const guard = setTimeout(() => finish(reject, new Error("说话人分离超时，请稍后重试。")), DIARIZATION_WORKER_TIMEOUT_MS);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("message", (message) => {
      if (settled) return;
      // 进度帧没有 ok 字段：先转给调用方，Promise 仍挂起等待最终结果。
      if (message?.progress) {
        phase = message.progress.phase;
        onProgress?.(message.progress);
        return;
      }
      if (Array.isArray(message?.unnamedTurns)) {
        unnamedTurns = message.unnamedTurns;
        return;
      }
      if (message?.ok) finish(resolve, message.turns);
      else finish(reject, new Error(message?.error || "说话人分离失败。"));
    });
    child.once("exit", (code) => {
      if (settled) return;
      if (unnamedTurns) {
        console.warn(`[diarization] 声纹匹配进程退出（代码 ${code ?? "?"}），已保留分离结果。`);
        finish(resolve, unnamedTurns);
        return;
      }
      console.warn(`[diarization] 进程在 ${phase} 阶段退出（代码 ${code ?? "?"}）。`);
      finish(reject, new Error(`说话人分离进程异常退出（代码 ${code ?? "?"}）。`));
    });
    child.postMessage({ id: 1, ...request });
  });
}

/**
 * 用 sherpa-onnx 做离线说话人分离。副作用：utilityProcess（内部再用 FFmpeg
 * 子进程与临时 WAV）、进程外跑分离模型（CPU 密集但不再阻塞主进程）。
 * @param {object} profile diarization 模型档案（segmentation/embedding 模型路径等）
 * @param {object} options expectedSpeakers 已知人数（-1 自动聚类），threshold 聚类阈值，
 * voiceprints 本地声纹样本（兼容者自动命名），transcriptSpans 转写已知语音区间
 * （直播录音：worker 改用窗口化声纹聚类），signal 取消信号
 * @returns {Promise<Array<{startMs, endMs, speakerId, speakerName?}>>} 说话人轮次列表
 */
export async function diarizeWithSherpa(profile, audioFilePath, options = {}) {
  const segmentationModel = profile.options?.segmentationModelPath;
  const embeddingModel = profile.options?.embeddingModelPath;
  if (!segmentationModel || !embeddingModel) {
    throw new Error("请配置 Pyannote segmentation 与 3D-Speaker embedding 模型路径。");
  }
  const modelKey = voiceprintModelKey(profile);
  // 样本向量序列化成普通数组跨进程传递（仍在同一台设备上，不出本机）。
  const voiceprintSamples = (options.voiceprints ?? [])
    .filter((sample) => sample.modelKey === modelKey)
    .map((sample) => ({ name: sample.name, embedding: Array.from(sample.embedding ?? []) }));
  return runDiarizationWorker({
    audioFilePath,
    ffmpegPath: await managedFfmpegPath(),
    segmentationModel,
    embeddingModel,
    clustering: {
      numClusters: options.expectedSpeakers ?? -1,
      threshold: options.threshold ?? profile.options?.clusteringThreshold ?? 0.5
    },
    // 直播录音传入转写区间：worker 改用「转写当 VAD」的窗口化路径
    // （pyannote 在 WebRTC 处理过的远场音频上会漏检大部分语音，实测塌缩成 1 人）。
    ...(options.transcriptSpans?.length ? { transcriptSpans: options.transcriptSpans } : {}),
    ...(options.diarizationCheckpoint ? { diarizationCheckpoint: options.diarizationCheckpoint } : {}),
    voiceprintSamples,
    voiceprintThreshold: profile.options?.voiceprintThreshold,
    voiceprintMargin: profile.options?.voiceprintMargin
  }, { signal: options.signal, onProgress: options.onProgress });
}

function pickTurnForRange(startMs, endMs, turns) {
  const midpoint = (startMs + endMs) / 2;
  let turn;
  let bestOverlap = 0;
  let nearestGap = Number.POSITIVE_INFINITY;
  for (const item of turns) {
    const overlap = Math.max(0, Math.min(endMs, item.endMs) - Math.max(startMs, item.startMs));
    const gap = Math.max(item.startMs - midpoint, 0, midpoint - item.endMs);
    if (overlap > bestOverlap || (overlap === bestOverlap && gap < nearestGap)) {
      bestOverlap = overlap;
      nearestGap = gap;
      turn = item;
    }
  }
  return { turn, bestOverlap };
}

function labelFromTurn(turn) {
  const speakerNumber = turn.speakerId.replace(/\D/g, "") || "1";
  return {
    speakerId: turn.speakerId,
    // 未匹配声纹库的聚类用「发言人N」占位，用户在转写里改名即注册声纹。
    speakerName: turn.speakerName || `发言人${speakerNumber}`
  };
}

/** 判断一个转录段是否实质性跨越了 ≥2 位说话人（排除轮次边缘的轻微溢出）。 */
function hasMultipleSignificantSpeakers(startMs, endMs, turns) {
  const overlapBySpeaker = new Map();
  for (const item of turns) {
    const overlap = Math.max(0, Math.min(endMs, item.endMs) - Math.max(startMs, item.startMs));
    if (overlap <= 0) continue;
    overlapBySpeaker.set(item.speakerId, (overlapBySpeaker.get(item.speakerId) ?? 0) + overlap);
  }
  if (overlapBySpeaker.size < 2) return false;
  const sorted = [...overlapBySpeaker.values()].sort((left, right) => right - left);
  const duration = Math.max(1, endMs - startMs);
  const minSecondaryOverlap = Math.min(800, Math.max(400, Math.round(duration * 0.2)));
  return sorted[1] >= minSecondaryOverlap;
}

const PLACEHOLDER_SPEAKER_NAME = /^(?:我|远端发言人|未分离|发言人\d*(?:\s*·\s*待校准)?)$/;

/** 判断一条段落的发言人名是否是用户手工改名（非系统默认/占位标签）。 */
export function isManualSpeakerName(name) {
  const trimmed = String(name || "").trim();
  return Boolean(trimmed) && !PLACEHOLDER_SPEAKER_NAME.test(trimmed);
}

/**
 * 把分离轮次套回转录段：
 * - 单说话人段：按真实时间重叠量选择说话人；轮次间隙归给时间上最近的轮次。
 * - 跨说话人段（例如直播合并后的插话、或 STT 返回的长段跨两人）：按句子/子句拆开
 *   逐片匹配说话人，相邻同人片段自动合回，确保突然插话能被独立拆出。
 * - preserveManualLabels=true（录音后后台分离回填）：跳过用户已手工改名的段落，
 *   避免后台跑完后把用户刚才改好的「张三」回滚成「发言人2」。
 * @param {Array} transcript 转录段落
 * @param {Array<{startMs,endMs,speakerId}>} turns diarizeWithSherpa 的轮次
 * @returns {Array} 更新说话人标签后的转录段
 */
export function applyDiarization(transcript, turns, { requireOverlap = false, preserveManualLabels = false } = {}) {
  if (!turns.length) return transcript;
  return transcript.flatMap((segment) => {
    if (preserveManualLabels && isManualSpeakerName(segment.speakerName)) {
      return [segment];
    }
    if (segment.status === "final" && hasMultipleSignificantSpeakers(segment.startMs, segment.endMs, turns)) {
      const clauses = splitTimedTranscriptClauses(segment.text, segment.startMs, segment.endMs);
      if (clauses.length > 1) {
        const assigned = clauses.map((clause) => {
          const picked = pickTurnForRange(clause.startMs, clause.endMs, turns);
          if (requireOverlap && !picked.bestOverlap) {
            return { ...clause, speakerId: segment.speakerId, speakerName: segment.speakerName };
          }
          return { ...clause, ...labelFromTurn(picked.turn) };
        });
        const merged = [];
        for (const item of assigned) {
          const previous = merged.at(-1);
          if (previous && previous.speakerId === item.speakerId) {
            const spacer = /[a-z\d]$/i.test(previous.text) && /^[a-z\d]/i.test(item.text) ? " " : "";
            previous.endMs = Math.max(previous.endMs, item.endMs);
            previous.text = `${previous.text}${spacer}${item.text}`;
          } else {
            merged.push({ ...item });
          }
        }
        if (merged.length > 1) {
          return merged.map((piece, index) => ({
            ...segment,
            id: index === 0 ? segment.id : `${segment.id}:turn:${index}`,
            startMs: piece.startMs,
            endMs: piece.endMs,
            text: piece.text,
            speakerId: piece.speakerId,
            speakerName: piece.speakerName
          }));
        }
      }
    }
    const { turn, bestOverlap } = pickTurnForRange(segment.startMs, segment.endMs, turns);
    if (requireOverlap && !bestOverlap) return [segment];
    return [{
      ...segment,
      ...labelFromTurn(turn)
    }];
  });
}
