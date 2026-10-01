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
import { computeVoiceprintEmbedding } from "./diarization-core.mjs";

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
    return computeVoiceprintEmbedding(sherpaOnnx, embeddingModel, wave, intervals);
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
function runDiarizationWorker(request, signal) {
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
      if (message?.ok) finish(resolve, message.turns);
      else finish(reject, new Error(message?.error || "说话人分离失败。"));
    });
    child.once("exit", (code) => {
      if (!settled) finish(reject, new Error(`说话人分离进程异常退出（代码 ${code ?? "?"}）。`));
    });
    child.postMessage({ id: 1, ...request });
  });
}

/**
 * 用 sherpa-onnx 做离线说话人分离。副作用：utilityProcess（内部再用 FFmpeg
 * 子进程与临时 WAV）、进程外跑分离模型（CPU 密集但不再阻塞主进程）。
 * @param {object} profile diarization 模型档案（segmentation/embedding 模型路径等）
 * @param {object} options expectedSpeakers 已知人数（-1 自动聚类），threshold 聚类阈值，
 * voiceprints 本地声纹样本（兼容者自动命名），signal 取消信号
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
    voiceprintSamples,
    voiceprintThreshold: profile.options?.voiceprintThreshold,
    voiceprintMargin: profile.options?.voiceprintMargin
  }, options.signal);
}

/**
 * 把分离轮次套回转录段：取每段的时间中点落在哪个轮次内即标记为该说话人；
 * 轮次之间总有间隙，命不中任何轮次的段落归给时间上最近的轮次——沿用旧标签
 * 会与分离结果的 speaker-N 撞 id，同一个人分裂成两个名字。
 * @param {Array} transcript 转录段落
 * @param {Array<{startMs,endMs,speakerId}>} turns diarizeWithSherpa 的轮次
 * @returns {Array} 更新说话人标签后的转录段
 */
export function applyDiarization(transcript, turns) {
  if (!turns.length) return transcript;
  return transcript.map((segment) => {
    const midpoint = (segment.startMs + segment.endMs) / 2;
    let turn = turns.find((item) => midpoint >= item.startMs && midpoint <= item.endMs);
    if (!turn) {
      let nearestGap = Number.POSITIVE_INFINITY;
      for (const item of turns) {
        const gap = Math.max(item.startMs - midpoint, 0, midpoint - item.endMs);
        if (gap < nearestGap) { nearestGap = gap; turn = item; }
      }
    }
    const speakerNumber = turn.speakerId.replace(/\D/g, "") || "1";
    return {
      ...segment,
      speakerId: turn.speakerId,
      // 未匹配声纹库的聚类用「发言人N」占位，用户在转写里改名即注册声纹。
      speakerName: turn.speakerName || `发言人${speakerNumber}`
    };
  });
}
