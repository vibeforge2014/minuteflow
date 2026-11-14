/**
 * 说话人分离的纯逻辑核心：聚类后处理合并、声纹比对、区间采样与嵌入编排。
 * 不依赖 Electron、数据库或原生 addon（sherpa 句柄由调用方传入），
 * 主进程（声纹登记/直播标注）与 diarization-worker（utilityProcess 重推理）共用，
 * 保证两条路径的合并与匹配行为完全一致。
 */
import { parsePcmWav } from "./audio-quality.mjs";

/**
 * 把内存里的 16-bit PCM WAV 块解成 Float32 采样（直播逐块声纹用，
 * 与 worker 的 readWave 同构）。非 PCM/损坏/多声道取首声道；失败返回 null，
 * 调用方按「不敢判定」回退原标签。
 */
export function decodePcm16Wav(buffer) {
  const wav = parsePcmWav(buffer);
  if (!wav) return null;
  const sampleCount = Math.floor(wav.length / 2);
  if (!sampleCount) return null;
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = buffer.readInt16LE(wav.start + index * 2) / 32768;
  }
  return { sampleRate: wav.sampleRate || 16000, samples };
}

// 官方 Node 示例使用 0.6；MinuteFlow 再增加“第一名与第二名的差距”约束，
// 以牺牲少量召回换取更少的错误姓名。档案可在高级 options 中覆盖这两个值。
export const DEFAULT_VOICEPRINT_THRESHOLD = 0.64;
export const DEFAULT_VOICEPRINT_MARGIN = 0.05;

const MIN_VOICEPRINT_AUDIO_MS = 2_000;
const MAX_VOICEPRINT_AUDIO_MS = 30_000;

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
export function voiceprintCentroids(samples, dimension) {
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

/** 从若干说话区间拼接最多 30 秒单人语音，过短时拒绝学习/识别以减少误判。 */
export function collectIntervalSamples(wave, intervals) {
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
export function computeVoiceprintEmbedding(sherpaOnnx, embeddingModel, wave, intervals) {
  const extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
    model: embeddingModel,
    numThreads: 2,
    debug: false,
    provider: "cpu"
  });
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: collectIntervalSamples(wave, intervals) });
  // compute 默认返回零拷贝外部缓冲数组；Electron 的 V8 禁用外部缓冲区，
  // 必须传 false 让 addon 把向量拷进堆（与 readWave 的第二个参数同理）。
  const embedding = extractor.compute(stream, false);
  if (!embedding?.length) throw new Error("未能从所选片段提取有效声纹。");
  return Float32Array.from(embedding);
}

/** 逐簇计算平均声纹（同一 extractor 复用，每簇最多取 30 秒）；不足 2 秒的簇记 null，交给时间相邻兜底。 */
export function computeClusterCentroids(sherpaOnnx, embeddingModel, wave, turns) {
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

// —— 窗口化声纹聚类（直播逐块标注 + 录音后以转写区间为 VAD 的分离共用）——
// 背景（真实直播麦克风实测，452s/996s 两场）：pyannote 在 WebRTC NS/AGC 处理过的
// 远场多人音频上只检出 24–45s（转写引擎识别出 184s+），碎片 0.3–3s 的声纹不可靠，
// 聚类必然塌缩成 1 人；改用「转写结果已知有语音的区间」代替检出后，
// 同人窗口相似 0.85+、异人 ≤0.71，真实说话人可以分开。

export const SPEECH_WINDOW_MS = 4_000;
export const SPEECH_WINDOW_HOP_MS = 2_000;
/** 单窗语音不足 2 秒时声纹不可靠（与声纹登记同口径）。 */
export const SPEECH_WINDOW_MIN_MS = 2_000;
/**
 * 窗口级平均链接初筛阈值（其后还过 mergeDiarizationClusters 二段合并）。
 * 真实两场直播录音校准：0.45–0.50 初筛后 merge 恰好得到真实的 2 位说话人；
 * ≥0.55 初筛过碎（14 簇）会让 merge 把同一个人劈开。初筛宁粗勿碎。
 */
export const WINDOW_CLUSTER_THRESHOLD = 0.5;
/**
 * 直播逐块在线聚类的开新簇阈值（整块声纹比 4s 滑窗更稳，阈值取高一线：
 * 宁可暂时并入「我」，也不要把同一个人反复劈成新发言人）。
 */
export const LIVE_CLUSTER_THRESHOLD = 0.72;

/**
 * 把转写区间切成滑窗（合并重叠、按时间排序）。
 * 直播把 8 秒块的 STT 结果区间当 spans，录音后把整场 transcript 段落当 spans；
 * 窗口短于 minWindowMs 的尾巴直接丢弃。
 */
export function buildSpeechWindows(spans, {
  windowMs = SPEECH_WINDOW_MS,
  hopMs = SPEECH_WINDOW_HOP_MS,
  minWindowMs = SPEECH_WINDOW_MIN_MS
} = {}) {
  const windows = [];
  const normalized = [...(spans ?? [])]
    .map((span) => ({
      startMs: Math.max(0, Math.floor(Number(span?.startMs) || 0)),
      endMs: Math.max(0, Math.ceil(Number(span?.endMs) || 0))
    }))
    .filter((span) => span.endMs > span.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const seen = new Set();
  for (const span of normalized) {
    for (let at = span.startMs; ; at += hopMs) {
      const end = Math.min(span.endMs, at + windowMs);
      if (end - at < minWindowMs) break;
      const key = `${at}:${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        windows.push({ startMs: at, endMs: end });
      }
      if (end >= span.endMs) break;
    }
  }
  return windows.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

/**
 * 平均链接层次聚类。缓存两两余弦相似度，使用 nearest-neighbor chain
 * 找互为最近邻的簇，按成员数增量更新平均链接距离。
 * 平均链接具有 reducibility，链式合并与全局最高相似度合并产生相同分组。
 * 时间 O(n²·d + n²)，空间 O(n²)，不在每轮重算成员声纹。
 */
export function assignWindowsToClusters(embeddings, { threshold = WINDOW_CLUSTER_THRESHOLD } = {}) {
  const vectors = (embeddings ?? []).map((vector) => (vector?.length ? vector : null));
  const n = vectors.length;
  const groups = vectors.map((vector, index) => vector ? [index] : null);
  const active = new Set(groups.flatMap((group, index) => group ? [index] : []));
  const similarities = Array.from({ length: n }, () => new Float64Array(n));
  for (const i of active) {
    for (const j of active) {
      if (j <= i) continue;
      similarities[i][j] = similarities[j][i] = cosineSimilarity(vectors[i], vectors[j]);
    }
  }
  const chain = [];
  while (active.size) {
    if (!chain.length) chain.push(active.values().next().value);
    const left = chain[chain.length - 1];
    const previous = chain.length > 1 ? chain[chain.length - 2] : -1;
    let right = previous;
    let best = previous >= 0 ? similarities[left][previous] : -Infinity;
    for (const candidate of active) {
      if (candidate !== left && similarities[left][candidate] > best) {
        right = candidate;
        best = similarities[left][candidate];
      }
    }
    if (right < 0 || best < threshold) {
      // 当前簇与所有剩余簇都低于阈值；保留为最终簇。
      active.delete(left);
      chain.pop();
    } else if (right === previous) {
      chain.pop();
      chain.pop();
      const leftSize = groups[left].length;
      const rightSize = groups[right].length;
      for (const other of active) {
        if (other === left || other === right) continue;
        const similarity = (similarities[left][other] * leftSize + similarities[right][other] * rightSize) / (leftSize + rightSize);
        similarities[left][other] = similarities[other][left] = similarity;
      }
      groups[left].push(...groups[right]);
      groups[right] = null;
      active.delete(right);
    } else {
      chain.push(right);
    }
  }
  const ordered = groups.filter(Boolean)
    .map((members) => ({ first: Math.min(...members), members }))
    .sort((left, right) => left.first - right.first);
  const labels = new Array(n).fill(-1);
  ordered.forEach((group, clusterIndex) => {
    for (const member of group.members) labels[member] = clusterIndex;
  });
  return labels;
}

/**
 * 窗口 + 簇标 → 分离轮次：时间上相邻且同簇的窗口合并成一个轮次，
 * 结构与 pyannote 路径的 turns 完全一致（speaker-N），下游 applyDiarization
 * 与声纹命名无需区分来源。
 */
export function windowsToTurns(windows, labels) {
  const turns = [];
  const pairs = (windows ?? [])
    .map((window, index) => ({ window, label: labels?.[index] }))
    .filter((item) => item.label >= 0 && item.window?.endMs > item.window?.startMs)
    .sort((left, right) => left.window.startMs - right.window.startMs);
  for (const { window, label } of pairs) {
    const last = turns[turns.length - 1];
    if (last && last.label === label && window.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, window.endMs);
    } else {
      turns.push({ label, startMs: window.startMs, endMs: window.endMs });
    }
  }
  return turns.map(({ label, ...turn }) => ({ ...turn, speakerId: `speaker-${label + 1}` }));
}
