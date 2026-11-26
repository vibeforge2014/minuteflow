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
  LIVE_CHUNK_MIN_SPEECH_MS,
  LIVE_CLUSTER_THRESHOLD,
  buildSpeechWindows,
  collectIntervalSamples,
  cosineSimilarity,
  decodePcm16Wav,
  windowsToTurns
} from "./diarization-core.mjs";
import { applyDiarization } from "./diarization.mjs";

/** 直播 8 秒块内切子窗检测插话的参数。 */
const LIVE_SUBWINDOW_MS = 2_200;
const LIVE_SUBWINDOW_HOP_MS = 1_100;
const LIVE_SUBWINDOW_MIN_MS = 1_400;
/** 块内任意两个子窗声纹余弦低于此值，说明本块大概率发生了换人/插话。 */
export const LIVE_INTRA_CHUNK_SPLIT_THRESHOLD = 0.58;
/** 混合块内子窗匹配已有说话人簇的阈值（2s 子窗方差略高于 8s 整块）。 */
const LIVE_SUBWINDOW_MATCH_THRESHOLD = 0.62;
/** 混合块内子窗低于此值且与所有已有簇不同才开新簇；中间灰区继承相邻子窗。 */
const LIVE_SUBWINDOW_NEW_CLUSTER_CEILING = 0.56;
/** 子窗相对整块主簇至少领先此余量且达标，也视为块内存在已有说话人插话。 */
const LIVE_EXISTING_SPEAKER_MARGIN = 0.08;

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

function normalizeVector(raw) {
  if (!raw?.length) return null;
  const embedding = Float32Array.from(raw);
  let norm = 0;
  for (const value of embedding) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm) return null;
  for (let index = 0; index < embedding.length; index += 1) embedding[index] /= norm;
  return embedding;
}

function extractNormalizedEmbedding(extractor, wave, intervals, minAudioMs) {
  try {
    const samples = collectIntervalSamples(wave, intervals, { minAudioMs });
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
    // compute 默认返回零拷贝外部缓冲数组；Electron 的 V8 禁用外部缓冲区，必须传 false。
    return normalizeVector(extractor.compute(stream, false));
  } catch {
    return null;
  }
}

function bestExistingCluster(session, embedding) {
  let bestIndex = -1;
  let bestSimilarity = -1;
  session.centroids.forEach((centroid, index) => {
    const similarity = cosineSimilarity(embedding, centroid.v);
    if (similarity > bestSimilarity) { bestSimilarity = similarity; bestIndex = index; }
  });
  return { bestIndex, bestSimilarity };
}

/**
 * 纯逻辑核心（可单测）：把一个 8 秒块内的整块声纹与子窗声纹做两阶段判定。
 * - 若块内子窗一致（无插话）：沿用整块声纹 + LIVE_CLUSTER_THRESHOLD（单人零回归）；
 * - 若检测到块内换人/插话：不拿混合整块声纹污染原质心，改为按子窗各自归簇并产出
 *   块内相对时间轮次，使突然插话在直播阶段就能切分成独立发言人。
 * @param {string} sessionKey
 * @param {Float32Array|null} fullEmbedding
 * @param {Array<{startMs:number, endMs:number, embedding:Float32Array}>} subWindows
 * @returns {Array<{startMs:number, endMs:number, speakerId:string, speakerName:string}>|null}
 */
export function classifyLiveChunkWindows(sessionKey, fullEmbedding, subWindows, options = {}) {
  const threshold = options.threshold ?? LIVE_CLUSTER_THRESHOLD;
  const splitThreshold = options.intraChunkSplitThreshold ?? LIVE_INTRA_CHUNK_SPLIT_THRESHOLD;
  const matchThreshold = options.subWindowMatchThreshold ?? LIVE_SUBWINDOW_MATCH_THRESHOLD;
  const newClusterCeiling = options.subWindowNewClusterCeiling ?? LIVE_SUBWINDOW_NEW_CLUSTER_CEILING;
  const validSubWindows = (subWindows ?? []).filter((item) => item?.embedding?.length && item.endMs > item.startMs);

  // 只有一个或零个子窗时直接走整块分类。
  if (validSubWindows.length <= 1) {
    const embedding = fullEmbedding ?? validSubWindows[0]?.embedding;
    if (!embedding) return null;
    const label = classifyLiveEmbedding(sessionKey, embedding, { threshold });
    const startMs = validSubWindows[0]?.startMs ?? 0;
    const endMs = validSubWindows[0]?.endMs ?? 1;
    return [{ startMs, endMs, ...label }];
  }

  const session = sessions.get(sessionKey) ?? { centroids: [] };
  sessions.set(sessionKey, session);

  // 检测块内是否存在说话人切换：
  // 1) 块内两子窗自身声纹差异足够大；
  // 2) 或某子窗明确偏向另一个已有会话簇（领先整块主簇 ≥ margin）。
  let hasIntraChange = false;
  for (let i = 0; i < validSubWindows.length && !hasIntraChange; i += 1) {
    for (let j = i + 1; j < validSubWindows.length; j += 1) {
      if (cosineSimilarity(validSubWindows[i].embedding, validSubWindows[j].embedding) < splitThreshold) {
        hasIntraChange = true;
        break;
      }
    }
  }
  if (!hasIntraChange && session.centroids.length >= 2 && fullEmbedding) {
    const fullBest = bestExistingCluster(session, fullEmbedding);
    for (const item of validSubWindows) {
      const subBest = bestExistingCluster(session, item.embedding);
      if (subBest.bestIndex >= 0 && subBest.bestIndex !== fullBest.bestIndex && subBest.bestSimilarity >= matchThreshold) {
        const simToFullCluster = fullBest.bestIndex >= 0
          ? cosineSimilarity(item.embedding, session.centroids[fullBest.bestIndex].v)
          : -1;
        if (subBest.bestSimilarity - simToFullCluster >= LIVE_EXISTING_SPEAKER_MARGIN) {
          hasIntraChange = true;
          break;
        }
      }
    }
  }

  // 一致单人块：走整块高精度分类，保持单人会议零误拆。
  if (!hasIntraChange && fullEmbedding) {
    const label = classifyLiveEmbedding(sessionKey, fullEmbedding, { threshold });
    return [{
      startMs: validSubWindows[0].startMs,
      endMs: validSubWindows[validSubWindows.length - 1].endMs,
      ...label
    }];
  }

  // 混合/插话块：逐子窗分类且不拿混合整块声纹污染已有质心。
  const assignedClusterIndices = new Array(validSubWindows.length).fill(-1);
  for (let index = 0; index < validSubWindows.length; index += 1) {
    const item = validSubWindows[index];
    const { bestIndex, bestSimilarity } = bestExistingCluster(session, item.embedding);
    if (bestIndex >= 0 && bestSimilarity >= matchThreshold) {
      assignedClusterIndices[index] = bestIndex;
      // 仅对足够长且高置信的子窗微调质心，防止边界过渡窗拉偏声纹。
      if (item.endMs - item.startMs >= 2_000 && bestSimilarity >= threshold) {
        blendCentroid(session.centroids[bestIndex], item.embedding);
      }
    } else if (session.centroids.length === 0 || bestSimilarity < newClusterCeiling) {
      session.centroids.push({ v: item.embedding, chunks: 1 });
      assignedClusterIndices[index] = session.centroids.length - 1;
    }
  }

  // 灰区过渡窗（0.56..0.62）归并到时间上最近的已定窗，找不到时回退最相似已有簇。
  for (let index = 0; index < assignedClusterIndices.length; index += 1) {
    if (assignedClusterIndices[index] >= 0) continue;
    let resolved = -1;
    for (let distance = 1; distance < assignedClusterIndices.length; distance += 1) {
      if (index - distance >= 0 && assignedClusterIndices[index - distance] >= 0) {
        resolved = assignedClusterIndices[index - distance];
        break;
      }
      if (index + distance < assignedClusterIndices.length && assignedClusterIndices[index + distance] >= 0) {
        resolved = assignedClusterIndices[index + distance];
        break;
      }
    }
    if (resolved < 0) {
      const { bestIndex } = bestExistingCluster(session, validSubWindows[index].embedding);
      resolved = bestIndex >= 0 ? bestIndex : 0;
    }
    assignedClusterIndices[index] = resolved;
  }

  const rawTurns = windowsToTurns(validSubWindows, assignedClusterIndices);
  return rawTurns.map((turn) => {
    const clusterIndex = Math.max(0, Number(turn.speakerId.replace(/\D/g, "")) - 1);
    return { startMs: turn.startMs, endMs: turn.endMs, ...labelForCluster(clusterIndex) };
  });
}

/**
 * 给一个已完成 STT 的直播块打说话人标签（整块单标签接口，保留兼容与单测）。
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
    if (speechMs < LIVE_CHUNK_MIN_SPEECH_MS) return null;
    const extractor = getExtractor(options.embeddingModelPath);
    if (!extractor) return null;
    const wave = decodePcm16Wav(wavBuffer);
    if (!wave) return null;
    const embedding = extractNormalizedEmbedding(extractor, wave, intervals, LIVE_CHUNK_MIN_SPEECH_MS);
    if (!embedding) return null;
    return classifyLiveEmbedding(sessionKey, embedding, options);
  } catch {
    // 语音不足、模型拒绝输入等：直播标签只是增强，绝不影响转写主链路。
    return null;
  }
}

/**
 * 给一个 8 秒直播块内的转写片段逐段/逐子窗打说话人标签；若块内发生突然插话，
 * 会按检测到的说话人轮次拆段并分别贴标，而不再整块强行合并成同一人。
 * 失败或语音过短时返回 null，调用方回退按轨默认标签。
 */
export function labelLiveSegments(sessionKey, wavBuffer, segments, options = {}) {
  try {
    if (!segments?.length) return null;
    const speechIntervals = segments
      .map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs }))
      .filter((span) => span.endMs > span.startMs);
    const speechMs = speechIntervals.reduce((total, span) => total + (span.endMs - span.startMs), 0);
    if (speechMs < LIVE_SUBWINDOW_MIN_MS) return null;
    const extractor = getExtractor(options.embeddingModelPath);
    if (!extractor) return null;
    const wave = decodePcm16Wav(wavBuffer);
    if (!wave) return null;

    const fullEmbedding = speechMs >= LIVE_CHUNK_MIN_SPEECH_MS
      ? extractNormalizedEmbedding(extractor, wave, speechIntervals, LIVE_CHUNK_MIN_SPEECH_MS)
      : null;

    // 把块内语音切成 ~2.2s 子窗提取局部声纹；短段（≥1.4s）也可单独成窗。
    const mergedSpans = [];
    for (const span of [...speechIntervals].sort((left, right) => left.startMs - right.startMs)) {
      const last = mergedSpans.at(-1);
      if (last && span.startMs <= last.endMs + 250) {
        last.endMs = Math.max(last.endMs, span.endMs);
      } else {
        mergedSpans.push({ ...span });
      }
    }
    const candidateWindows = buildSpeechWindows(mergedSpans, {
      windowMs: LIVE_SUBWINDOW_MS,
      hopMs: LIVE_SUBWINDOW_HOP_MS,
      minWindowMs: LIVE_SUBWINDOW_MIN_MS
    });
    const subWindows = [];
    for (const window of candidateWindows) {
      const embedding = extractNormalizedEmbedding(extractor, wave, [window], LIVE_SUBWINDOW_MIN_MS);
      if (embedding) subWindows.push({ ...window, embedding });
    }

    const turns = classifyLiveChunkWindows(sessionKey, fullEmbedding, subWindows, options);
    if (!turns?.length) return null;
    return applyDiarization(segments, turns);
  } catch {
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
