/**
 * 说话人分离（Electron 主进程 / 服务层）。
 * 基于 sherpa-onnx-node（Pyannote segmentation + 3D-Speaker embedding + 聚类）
 * 对整段音频做离线分离，并把轮次标签套回转录段落。
 * 主要导出：diarizeWithSherpa、applyDiarization。
 * 被 services/import-queue.mjs 的导入流水线（diarizing 阶段）调用。
 * 副作用：拉起 ffmpeg 子进程、写临时 WAV。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { managedFfmpegPath } from "./local-models.mjs";

// ESM 环境下加载 CJS 原生模块（sherpa-onnx-node）需要 createRequire。
const require = createRequire(import.meta.url);

// 官方 Node 示例使用 0.6；MinuteFlow 再增加“第一名与第二名的差距”约束，
// 以牺牲少量召回换取更少的错误姓名。档案可在高级 options 中覆盖这两个值。
export const DEFAULT_VOICEPRINT_THRESHOLD = 0.64;
export const DEFAULT_VOICEPRINT_MARGIN = 0.05;
const MIN_VOICEPRINT_AUDIO_MS = 2_000;
const MAX_VOICEPRINT_AUDIO_MS = 30_000;

/** 同一个 embedding 模型生成的向量才能互相比对；移动模型文件不影响已保存声纹。 */
export function voiceprintModelKey(profile) {
  const modelPath = profile?.options?.embeddingModelPath;
  return modelPath ? path.basename(modelPath).toLowerCase() : "";
}

/** 余弦相似度（无效/维度不同返回 -1，不让损坏样本参与自动命名）。 */
export function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export const DIARIZATION_MERGE_SIMILARITY = 0.7;
export const DIARIZATION_FRAGMENT_SECONDS = 10;
export const DIARIZATION_FRAGMENT_SIMILARITY_FLOOR = 0.55;

/**
 * 聚类后处理合并。真实嘈杂音频里逐段嵌入噪声大，sherpa 的阈值聚类常把同一个
 * 说话人劈成多个簇（碎片簇可达十几个）。两阶段修正：
 * 1) 平均链接合并——簇心余弦 ≥ mergeSimilarity 的簇两两合并，合并后按时长加权重算簇心；
 * 2) 碎片归并——总时长 < minClusterSeconds 的簇优先并入相似度 ≥ fragmentSimilarityFloor
 *    的最相似簇；提不出簇心（语音不足 2 秒）或没有合格相似者并入时间相邻的较大簇。
 * 纯函数（簇心向量由调用方计算），说话人 id 按时间首次出现顺序重排为 speaker-1..N。
 */
export function mergeDiarizationClusters(turns, centroidEmbeddings, {
  mergeSimilarity = DIARIZATION_MERGE_SIMILARITY,
  minClusterSeconds = DIARIZATION_FRAGMENT_SECONDS,
  fragmentSimilarityFloor = DIARIZATION_FRAGMENT_SIMILARITY_FLOOR
} = {}) {
  const clusters = new Map();
  // 簇归属父指针：absorb 只合并记账，轮次对象上的旧 speakerId 由这里解析到簇根。
  const labelOf = new Map();
  const rootOf = (id) => {
    let current = id;
    while (labelOf.has(current) && labelOf.get(current) !== current) current = labelOf.get(current);
    return current;
  };
  for (const turn of turns) {
    const cluster = clusters.get(turn.speakerId) ?? { turns: [], durationMs: 0, centroid: centroidEmbeddings?.get(turn.speakerId) ?? null };
    labelOf.set(turn.speakerId, turn.speakerId);
    cluster.turns.push(turn);
    cluster.durationMs += turn.endMs - turn.startMs;
    clusters.set(turn.speakerId, cluster);
  }
  const absorb = (sourceId, targetId) => {
    const source = clusters.get(sourceId);
    const target = clusters.get(targetId);
    target.turns.push(...source.turns);
    target.durationMs += source.durationMs;
    // 时长加权平均近似合并簇心；任一侧缺失时保留较大簇的原簇心。
    if (source.centroid && target.centroid && source.centroid.length === target.centroid.length) {
      const total = target.durationMs;
      const weight = source.durationMs / total;
      const blended = new Float32Array(target.centroid.length);
      for (let index = 0; index < blended.length; index += 1) {
        blended[index] = target.centroid[index] * (1 - weight) + source.centroid[index] * weight;
      }
      target.centroid = blended;
    }
    labelOf.set(sourceId, targetId);
    clusters.delete(sourceId);
  };

  // 阶段一：平均链接合并同一个人的大簇。
  while (clusters.size > 1) {
    let best = null;
    for (const [leftId, left] of clusters) {
      if (!left.centroid) continue;
      for (const [rightId, right] of clusters) {
        if (rightId === leftId || !right.centroid) continue;
        const similarity = cosineSimilarity(left.centroid, right.centroid);
        if (similarity >= mergeSimilarity && (!best || similarity > best.similarity)) {
          best = { similarity, source: leftId, target: rightId };
        }
      }
    }
    if (!best) break;
    // 大簇吸收小簇，保持簇心锚定在主要内容上。
    const [source, target] = clusters.get(best.source).durationMs <= clusters.get(best.target).durationMs
      ? [best.source, best.target]
      : [best.target, best.source];
    absorb(source, target);
  }

  // 阶段二：碎片簇归并。按时长从小到大处理，各自独立选择去处。
  for (const fragmentId of [...clusters.keys()].sort((left, right) => clusters.get(left).durationMs - clusters.get(right).durationMs)) {
    const fragment = clusters.get(fragmentId);
    if (!fragment || fragment.durationMs >= minClusterSeconds * 1000 || clusters.size === 1) continue;
    let bestId = null;
    let bestSimilarity = fragmentSimilarityFloor;
    if (fragment.centroid) {
      for (const [candidateId, candidate] of clusters) {
        if (candidateId === fragmentId || !candidate.centroid) continue;
        const similarity = cosineSimilarity(fragment.centroid, candidate.centroid);
        if (similarity >= bestSimilarity) { bestSimilarity = similarity; bestId = candidateId; }
      }
    }
    if (!bestId) {
      // 时间相邻兜底：找该簇时间轴上前后最近的轮次所属簇。
      const fragmentStart = Math.min(...fragment.turns.map((turn) => turn.startMs));
      const fragmentEnd = Math.max(...fragment.turns.map((turn) => turn.endMs));
      let nearest = null;
      for (const [candidateId, candidate] of clusters) {
        if (candidateId === fragmentId) continue;
        for (const turn of candidate.turns) {
          const gap = turn.endMs <= fragmentStart
            ? fragmentStart - turn.endMs
            : turn.startMs >= fragmentEnd ? turn.startMs - fragmentEnd : 0;
          if (!nearest || gap < nearest.gap) nearest = { gap, candidateId };
        }
      }
      bestId = nearest?.candidateId;
    }
    if (bestId) absorb(fragmentId, bestId);
  }

  // 按时间首次出现顺序重排为密集编号（以合并后的簇根为准）。
  const ordered = [...clusters.values()]
    .flatMap((cluster) => cluster.turns)
    .sort((left, right) => left.startMs - right.startMs);
  const relabel = new Map();
  return ordered.map((turn) => {
    const root = rootOf(turn.speakerId);
    if (!relabel.has(root)) relabel.set(root, `speaker-${relabel.size + 1}`);
    return { ...turn, speakerId: relabel.get(root) };
  });
}

/** 把同一姓名的多次本地学习样本归一化平均，降低单场噪音对识别的影响。 */
function voiceprintCentroids(samples, dimension) {
  const groups = new Map();
  for (const sample of samples) {
    if (!sample?.name || sample.embedding?.length !== dimension) continue;
    const values = groups.get(sample.name) ?? [];
    values.push(sample.embedding);
    groups.set(sample.name, values);
  }
  return Array.from(groups, ([name, vectors]) => {
    const centroid = new Float32Array(dimension);
    for (const vector of vectors) {
      for (let index = 0; index < dimension; index += 1) centroid[index] += vector[index] / vectors.length;
    }
    return { name, embedding: centroid, sampleCount: vectors.length };
  });
}

/**
 * 给一个未知向量找最可靠的历史姓名。除了最低相似度，还要求领先第二名足够多；
 * 不满足时返回 null，让 UI 保持“发言人 N”而不是冒险误认。
 */
export function matchVoiceprint(embedding, samples, options = {}) {
  if (!embedding?.length) return null;
  const threshold = options.threshold ?? DEFAULT_VOICEPRINT_THRESHOLD;
  const margin = options.margin ?? DEFAULT_VOICEPRINT_MARGIN;
  const ranked = voiceprintCentroids(samples, embedding.length)
    .map((candidate) => ({
      name: candidate.name,
      sampleCount: candidate.sampleCount,
      score: cosineSimilarity(embedding, candidate.embedding)
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < threshold) return null;
  if (runnerUp && best.score - runnerUp.score < margin) return null;
  return best;
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

/** 从若干说话区间拼接最多 30 秒单人语音，过短时拒绝学习/识别以减少误判。 */
function collectIntervalSamples(wave, intervals) {
  const maximumSamples = Math.round(wave.sampleRate * MAX_VOICEPRINT_AUDIO_MS / 1000);
  const minimumSamples = Math.round(wave.sampleRate * MIN_VOICEPRINT_AUDIO_MS / 1000);
  const chunks = [];
  let total = 0;
  for (const interval of [...intervals].sort((left, right) => left.startMs - right.startMs)) {
    if (total >= maximumSamples) break;
    const start = Math.max(0, Math.floor(interval.startMs * wave.sampleRate / 1000));
    const end = Math.min(wave.samples.length, Math.ceil(interval.endMs * wave.sampleRate / 1000));
    if (end <= start) continue;
    const chunk = wave.samples.subarray(start, Math.min(end, start + maximumSamples - total));
    if (!chunk.length) continue;
    chunks.push(chunk);
    total += chunk.length;
  }
  if (total < minimumSamples) {
    throw new Error("可用的单人语音不足 2 秒，请在该发言人有更多内容后再记住。");
  }
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

/** 用当前 diarization 档案的 3D-Speaker 模型计算一份本地声纹向量。 */
function computeVoiceprintEmbedding(sherpaOnnx, embeddingModel, wave, intervals) {
  const extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
    model: embeddingModel,
    numThreads: 2,
    debug: false,
    provider: "cpu"
  });
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: collectIntervalSamples(wave, intervals) });
  // compute 默认返回零拷贝外部缓冲数组；Electron 主进程 V8 禁用外部缓冲区，
  // 必须传 false 让 addon 把向量拷进堆（与 readWave 的第二个参数同理）。
  const embedding = extractor.compute(stream, false);
  if (!embedding?.length) throw new Error("未能从所选片段提取有效声纹。");
  return Float32Array.from(embedding);
}

/** 逐簇计算平均声纹（同一 extractor 复用，每簇最多取 30 秒）；不足 2 秒的簇记 null，交给时间相邻兜底。 */
function computeClusterCentroids(sherpaOnnx, embeddingModel, wave, turns) {
  const extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
    model: embeddingModel,
    numThreads: 2,
    debug: false,
    provider: "cpu"
  });
  const centroids = new Map();
  for (const speakerId of new Set(turns.map((turn) => turn.speakerId))) {
    try {
      const stream = extractor.createStream();
      stream.acceptWaveform({
        sampleRate: wave.sampleRate,
        samples: collectIntervalSamples(wave, turns.filter((turn) => turn.speakerId === speakerId))
      });
      const embedding = extractor.compute(stream, false);
      centroids.set(speakerId, embedding?.length ? Float32Array.from(embedding) : null);
    } catch {
      centroids.set(speakerId, null);
    }
  }
  return centroids;
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
    sherpaOnnx = require("sherpa-onnx-node");
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

/**
 * 用 sherpa-onnx 做离线说话人分离。副作用：ffmpeg 子进程、临时 WAV、
 * 进程内跑分离模型（CPU 密集）。
 * @param {object} profile diarization 模型档案（segmentation/embedding 模型路径等）
 * @param {object} options expectedSpeakers 已知人数（-1 自动聚类），threshold 聚类阈值
 * @returns {Promise<Array<{startMs, endMs, speakerId}>>} 说话人轮次列表
 */
export async function diarizeWithSherpa(profile, audioFilePath, options = {}) {
  const segmentationModel = profile.options?.segmentationModelPath;
  const embeddingModel = profile.options?.embeddingModelPath;
  if (!segmentationModel || !embeddingModel) {
    throw new Error("请配置 Pyannote segmentation 与 3D-Speaker embedding 模型路径。");
  }

  let sherpaOnnx;
  try {
    sherpaOnnx = require("sherpa-onnx-node");
  } catch {
    throw new Error("未安装 sherpa-onnx-node 运行时，请重新安装应用或改用手动发言人标签。");
  }

  const waveAsset = await ensureWave(audioFilePath, sherpaOnnx);
  try {
    const diarizer = new sherpaOnnx.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: segmentationModel } },
      embedding: { model: embeddingModel },
      clustering: {
        numClusters: options.expectedSpeakers ?? -1,
        threshold: options.threshold ?? profile.options?.clusteringThreshold ?? 0.5
      },
      minDurationOn: 0.2,
      minDurationOff: 0.5
    });
    // readWave 默认返回零拷贝外部缓冲数组；Electron 的 V8 禁用外部缓冲区，
    // 再传回 addon 会抛 "External buffers are not allowed"，必须传 false 让其拷贝进堆。
    const wave = sherpaOnnx.readWave(waveAsset.filePath, false);
    // 模型只接受其固有采样率（16k），不匹配直接报错而不是静默产出错误结果。
    if (diarizer.sampleRate !== wave.sampleRate) {
      throw new Error(`说话人模型需要 ${diarizer.sampleRate}Hz 音频，实际为 ${wave.sampleRate}Hz。`);
    }
    const rawTurns = diarizer.process(wave.samples).map((turn) => ({
      startMs: Math.round((turn.start ?? turn.startSeconds ?? 0) * 1000),
      endMs: Math.round((turn.end ?? turn.endSeconds ?? 0) * 1000),
      speakerId: `speaker-${Number(turn.speaker ?? turn.speakerId ?? 0) + 1}`
    }));
    // 阈值聚类在真实嘈杂音频上常把同一人劈成多个簇：算出簇心后做后处理合并。
    const centroidEmbeddings = computeClusterCentroids(sherpaOnnx, embeddingModel, wave, rawTurns);
    const turns = mergeDiarizationClusters(rawTurns, centroidEmbeddings);
    const compatibleSamples = (options.voiceprints ?? []).filter((sample) =>
      sample.modelKey === voiceprintModelKey(profile));
    if (!compatibleSamples.length) return turns;

    const identified = new Map();
    const claimedNames = new Set();
    const candidates = [];
    for (const speakerId of new Set(turns.map((turn) => turn.speakerId))) {
      try {
        const embedding = computeVoiceprintEmbedding(
          sherpaOnnx,
          embeddingModel,
          wave,
          turns.filter((turn) => turn.speakerId === speakerId)
        );
        const match = matchVoiceprint(embedding, compatibleSamples, {
          threshold: profile.options?.voiceprintThreshold,
          margin: profile.options?.voiceprintMargin
        });
        if (match) candidates.push({ speakerId, ...match });
      } catch {
        // 片段太短或模型拒绝输入时仅跳过自动命名，分离结果本身仍然有效。
      }
    }
    // 同一场会议中一个历史姓名只自动分配给置信度最高的聚类，避免两个人被同时误标为同一人。
    candidates.sort((left, right) => right.score - left.score).forEach((candidate) => {
      if (claimedNames.has(candidate.name)) return;
      claimedNames.add(candidate.name);
      identified.set(candidate.speakerId, candidate.name);
    });
    return turns.map((turn) => ({ ...turn, speakerName: identified.get(turn.speakerId) }));
  } finally {
    if (waveAsset.temporary) await unlink(waveAsset.filePath).catch(() => {});
  }
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
