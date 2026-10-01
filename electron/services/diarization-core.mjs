/**
 * 说话人分离的纯逻辑核心：聚类后处理合并、声纹比对、区间采样与嵌入编排。
 * 不依赖 Electron、数据库或原生 addon（sherpa 句柄由调用方传入），
 * 主进程（声纹登记）与 diarization-worker（utilityProcess 重推理）共用，
 * 保证两条路径的合并与匹配行为完全一致。
 */

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
