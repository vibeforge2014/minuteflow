/**
 * 直播逐块说话人标注（Electron 主进程内）。
 *
 * 背景：线下会议只有一条麦克风轨，房间里所有人都在这条轨上；旧实现按轨硬编码
 * 「我」，直播转写永远无法区分人声。这里对每个已完成 STT 的 8 秒块，用其
 * STT 结果区间（已知的语音位置）在主进程内提取一份声纹，与本次录音会话的
 * 运行质心做在线聚类：簇 1 沿用「我」（单人会议零回归、笔记本麦下主声通常
 * 即机主），后续簇标「发言人 N」。
 *
 * 实测依据（真实直播麦克风）：整块声纹同人 ≥0.85、异人 ≤0.71，0.72 的开新簇
 * 阈值宁可暂时并入「我」也不把同一个人劈成新发言人。远场直播与近场登记的
 * 信道域差（自比 ≤0.36）使声纹书命名不可靠，因此直播只给通用标签——
 * 录音后的全量窗口化分离才是最终口径，改名/声纹登记沿用既有路径。
 *
 * 健壮性：任何失败（模型缺失、解码失败、语音不足 2 秒）都返回 null，
 * 调用方回退按轨标签，绝不阻塞转写。
 */
import { createRequire } from "node:module";
import {
  LIVE_CLUSTER_THRESHOLD,
  SPEECH_WINDOW_MIN_MS,
  collectIntervalSamples,
  cosineSimilarity,
  decodePcm16Wav
} from "./diarization-core.mjs";

const nodeRequire = createRequire(import.meta.url);

/** 每个录音会话的运行质心：centroids[i] = { v:归一化均值, chunks:成员块数 }。 */
const sessions = new Map();

/** 缓存的 SpeakerEmbeddingExtractor（按模型路径复用；换模型时重建）。 */
let extractorCache = { modelPath: "", extractor: null };

function getExtractor(modelPath) {
  if (!modelPath) return null;
  if (extractorCache.modelPath === modelPath && extractorCache.extractor) {
    return extractorCache.extractor;
  }
  let sherpaOnnx;
  try {
    sherpaOnnx = nodeRequire("sherpa-onnx-node");
  } catch {
    return null;
  }
  const extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
    model: modelPath,
    numThreads: 2,
    debug: false,
    provider: "cpu"
  });
  extractorCache = { modelPath, extractor };
  return extractor;
}

/** 簇 1 固定「我」；后续簇 live-speaker-N / 发言人 N（录音后分离会全量重标）。 */
function labelForCluster(clusterIndex) {
  if (clusterIndex === 0) return { speakerId: "me", speakerName: "我" };
  return { speakerId: `live-speaker-${clusterIndex + 1}`, speakerName: `发言人${clusterIndex + 1}` };
}

/** 归一化运行质心：成员块等权平均后重新归一，避免质心范数随簇增长漂移。 */
function blendCentroid(centroid, embedding) {
  const weight = 1 / (centroid.chunks + 1);
  const blended = new Float32Array(centroid.v.length);
  for (let index = 0; index < blended.length; index += 1) {
    blended[index] = centroid.v[index] * (1 - weight) + embedding[index] * weight;
  }
  let norm = 0;
  for (const value of blended) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < blended.length; index += 1) blended[index] /= norm;
  centroid.v = blended;
  centroid.chunks += 1;
}

/**
 * 纯逻辑核心（可单测）：把一个已归一化的声纹归入会话簇或开新簇。
 * @returns {{speakerId:string, speakerName:string}} 簇 1 =「我」
 */
export function classifyLiveEmbedding(sessionKey, embedding, { threshold = LIVE_CLUSTER_THRESHOLD } = {}) {
  const session = sessions.get(sessionKey) ?? { centroids: [] };
  sessions.set(sessionKey, session);
  let bestIndex = -1;
  let bestSimilarity = -1;
  session.centroids.forEach((centroid, index) => {
    const similarity = cosineSimilarity(embedding, centroid.v);
    if (similarity > bestSimilarity) { bestSimilarity = similarity; bestIndex = index; }
  });
  if (bestIndex >= 0 && bestSimilarity >= threshold) {
    blendCentroid(session.centroids[bestIndex], embedding);
    return labelForCluster(bestIndex);
  }
  session.centroids.push({ v: embedding, chunks: 1 });
  return labelForCluster(session.centroids.length - 1);
}

/**
 * 给一个已完成 STT 的直播块打说话人标签。
 * @param {string} sessionKey 录音会话键（meetingId，recordings:start/stop 时重置）
 * @param {Buffer} wavBuffer 归一化后的 16k 单声道 PCM WAV 块
 * @param {Array<{startMs,endMs}>} speechIntervalsMs STT 结果在本块内的相对语音区间
 * @param {object} options embeddingModelPath：diarization 档案的 embedding 模型路径
 * @returns {{speakerId:string, speakerName:string}|null} null = 不敢判定，调用方回退按轨标签
 */
export function labelLiveChunk(sessionKey, wavBuffer, speechIntervalsMs, options = {}) {
  try {
    const intervals = (speechIntervalsMs ?? []).filter((span) => span?.endMs > span?.startMs);
    const speechMs = intervals.reduce((total, span) => total + (span.endMs - span.startMs), 0);
    if (speechMs < SPEECH_WINDOW_MIN_MS) return null;
    const extractor = getExtractor(options.embeddingModelPath);
    if (!extractor) return null;
    const wave = decodePcm16Wav(wavBuffer);
    if (!wave) return null;
    // 复用声纹登记的区间采样：拼接语音区间、上限 30 秒、不足 2 秒抛错（回退 null）。
    const samples = collectIntervalSamples(wave, intervals);
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
    // compute 默认返回零拷贝外部缓冲数组；Electron 的 V8 禁用外部缓冲区，必须传 false。
    const raw = extractor.compute(stream, false);
    if (!raw?.length) return null;
    const embedding = Float32Array.from(raw);
    let norm = 0;
    for (const value of embedding) norm += value * value;
    norm = Math.sqrt(norm);
    if (!norm) return null;
    for (let index = 0; index < embedding.length; index += 1) embedding[index] /= norm;
    return classifyLiveEmbedding(sessionKey, embedding, options);
  } catch {
    // 语音不足、模型拒绝输入等：直播标签只是增强，绝不影响转写主链路。
    return null;
  }
}

/** 录音开始/结束时清掉该会话的质心（继续录音会重建，块级标签本就是临时口径）。 */
export function resetLiveSession(sessionKey) {
  sessions.delete(sessionKey);
}

/** 测试用：读取会话簇数（不暴露向量）。 */
export function liveSessionClusterCount(sessionKey) {
  return sessions.get(sessionKey)?.centroids.length ?? 0;
}
