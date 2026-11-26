/**
 * 说话人分离的 utilityProcess 入口（由 diarization.mjs 的 diarizeWithSherpa fork）。
 * 整段 pyannote 分段 + 聚类 + 3D-Speaker 嵌入是同步原生推理，34 分钟音频约需
 * 4-5 分钟——放在主进程会把事件循环整个卡住（所有 IPC 挂起、界面假死），因此
 * 全部搬进这个独立进程，主进程只等待结果消息。
 *
 * 协议：parentPort 收到 { id, audioFilePath, ffmpegPath, segmentationModel,
 * embeddingModel, clustering, voiceprintSamples, voiceprintThreshold,
 * voiceprintMargin, transcriptSpans }；回 { id, ok: true, turns } 或
 * { id, ok: false, error }。带 transcriptSpans（直播录音的转写区间）时跳过
 * pyannote 检出、改用窗口化声纹聚类。样本向量只在本机进程间传递，不出设备。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  assignWindowsToClusters,
  buildSpeechWindows,
  computeClusterCentroids,
  computeVoiceprintEmbedding,
  createVoiceprintExtractor,
  embedVoiceprintSamples,
  diarizeAudioWindows,
  matchVoiceprint,
  mergeDiarizationClusters,
  windowsToTurns
} from "./diarization-core.mjs";

const require = createRequire(import.meta.url);

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
 * 确保输入是 16k 单声道 WAV（分离模型的采样率要求）：已是合规 WAV 直接复用；
 * 其他输入（或采样率不符的 WAV）用调用方传入的打包 FFmpeg 转出临时文件。
 */
async function ensureWave(filePath, sherpaOnnx, ffmpegPath) {
  const needsFfmpeg = async () => {
    if (path.extname(filePath).toLowerCase() !== ".wav") return true;
    try {
      // readWave 默认返回零拷贝外部缓冲数组；Electron 的 V8 禁用外部缓冲区，
      // 必须传 false 让其拷贝进堆（包括本次仅探测采样率的读取）。
      return sherpaOnnx.readWave(filePath, false).sampleRate !== 16_000;
    } catch {
      // 损坏或非标准 WAV 继续交给 FFmpeg，保留其更完整的格式兼容与错误提示。
      return true;
    }
  };
  if (!await needsFfmpeg()) return { filePath, temporary: false };
  if (!ffmpegPath) throw new Error("应用内置音频组件无法加载，请重新安装 MinuteFlow。");
  const target = path.join(tmpdir(), `${randomUUID()}-diarization.wav`);
  await runProcess(ffmpegPath, ["-y", "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", target]);
  return { filePath: target, temporary: true };
}

/** 一次完整的离线分离：分段聚类 → 簇心合并 → （有声纹簿时）自动命名。 */
async function diarize(request, reportProgress, reportUnnamedTurns) {
  const { audioFilePath, ffmpegPath, segmentationModel, embeddingModel } = request;
  let sherpaOnnx;
  try {
    sherpaOnnx = require("sherpa-onnx-node");
  } catch {
    throw new Error("未安装 sherpa-onnx-node 运行时，请重新安装应用或改用手动发言人标签。");
  }
  // 阶段进度：sherpa 的 process() 是同步原生调用、内部不回调，但进入长推理前
  // 先发一帧「analyzing」，父进程即可显示真实的“分析中”状态与已用时间。
  reportProgress({ phase: "preparing" });
  const waveAsset = await ensureWave(audioFilePath, sherpaOnnx, ffmpegPath);
  try {
    const wave = sherpaOnnx.readWave(waveAsset.filePath, false);
    const samples = (request.voiceprintSamples ?? []).map((sample) => ({
      name: sample.name,
      embedding: Float32Array.from(sample.embedding ?? [])
    }));
    // 直播录音走「转写区间当 VAD」的窗口化路径：pyannote 在 WebRTC NS/AGC
    // 处理过的远场多人音频上只检出零头（实测 452s 里 24s），窗口化后真实说话人
    // 才能分开。导入音频（近场、检出充分）继续走 pyannote 全量路径。
    let turns;
    let extractor;
    if (request.transcriptSpans?.length) {
      reportProgress({ phase: "loading" });
      const windows = buildSpeechWindows(request.transcriptSpans);
      if (!windows.length) return [];
      extractor = createVoiceprintExtractor(sherpaOnnx, embeddingModel);
      reportProgress({
        phase: "analyzing",
        audioDurationMs: Math.round((wave.samples.length / Math.max(1, wave.sampleRate)) * 1000)
      });
      const embeddings = [];
      for (const window of windows) {
        const start = Math.max(0, Math.floor(window.startMs * wave.sampleRate / 1000));
        const end = Math.min(wave.samples.length, Math.ceil(window.endMs * wave.sampleRate / 1000));
        // 转写区间可能超出归档音频末尾：不足 1 秒的切片不喂模型（eres2net 会报
        // num_frames:0），按无效窗口参与聚类。
        if (end - start < wave.sampleRate) {
          embeddings.push(null);
          continue;
        }
        embeddings.push(embedVoiceprintSamples(extractor, wave.sampleRate, wave.samples.subarray(start, end)));
      }
      reportProgress({ phase: "refining" });
      // 初筛宁粗勿碎（0.5），再复用导入链路的簇心合并 + 碎片归并收口——
      // 真实直播录音上 4s 窗初筛 + merge 恰好还原真实的说话人数。
      const clustered = windowsToTurns(windows, assignWindowsToClusters(embeddings));
      const centroids = computeClusterCentroids(extractor, wave, clustered);
      turns = mergeDiarizationClusters(clustered, centroids);
    } else {
      reportProgress({ phase: "loading" });
      const numThreads = Math.max(1, Math.min(3, availableParallelism() - 1));
      const diarizer = new sherpaOnnx.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: segmentationModel }, numThreads },
        embedding: { model: embeddingModel, numThreads },
        clustering: {
          numClusters: request.clustering?.numClusters ?? -1,
          threshold: request.clustering?.threshold ?? 0.5
        },
        minDurationOn: 0.2,
        minDurationOff: 0.5
      });
      // 模型只接受其固有采样率（16k），不匹配直接报错而不是静默产出错误结果。
      if (diarizer.sampleRate !== wave.sampleRate) {
        throw new Error(`说话人模型需要 ${diarizer.sampleRate}Hz 音频，实际为 ${wave.sampleRate}Hz。`);
      }
      const audioDurationMs = Math.round(wave.samples.length / wave.sampleRate * 1000);
      reportProgress({ phase: "analyzing", audioDurationMs });
      // 长录音会把整小时的特征和聚类数据塞进同一次原生调用。限制单次窗口，
      // 再用整场归档音频上的声纹簇心合并各窗口身份。
      const rawTurns = diarizeAudioWindows(wave, (samples) => diarizer.process(samples), {
        windowMs: 60_000,
        checkpoint: request.diarizationCheckpoint,
        onWindow: (window) => reportProgress({ phase: "analyzing", audioDurationMs, window })
      });
      // 阈值聚类在真实嘈杂音频上常把同一人劈成多个簇：算出簇心后做后处理合并。
      reportProgress({ phase: "refining" });
      if (!rawTurns.length) return [];
      extractor = createVoiceprintExtractor(sherpaOnnx, embeddingModel);
      const centroidEmbeddings = computeClusterCentroids(extractor, wave, rawTurns);
      turns = mergeDiarizationClusters(rawTurns, centroidEmbeddings);
    }
    const compatibleSamples = samples.filter((sample) => sample.embedding.length === extractor?.dim);
    if (!turns.length || !compatibleSamples.length) return turns;

    reportUnnamedTurns(turns);
    reportProgress({ phase: "naming" });
    const identified = new Map();
    const claimedNames = new Set();
    const candidates = [];
    for (const speakerId of new Set(turns.map((turn) => turn.speakerId))) {
      try {
        const embedding = computeVoiceprintEmbedding(
          extractor,
          wave,
          turns.filter((turn) => turn.speakerId === speakerId)
        );
        const match = matchVoiceprint(embedding, compatibleSamples, {
          threshold: request.voiceprintThreshold,
          margin: request.voiceprintMargin
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

process.parentPort.on("message", (event) => {
  const { id, ...request } = event.data ?? {};
  // 进度帧与结果帧共用 id；父进程按 message.progress 区分，不会误当结果。
  const reportProgress = (progress) => process.parentPort.postMessage({ id, progress });
  const reportUnnamedTurns = (unnamedTurns) => process.parentPort.postMessage({ id, unnamedTurns });
  diarize(request, reportProgress, reportUnnamedTurns)
    .then((turns) => process.parentPort.postMessage({ id, ok: true, turns }))
    .catch((error) => process.parentPort.postMessage({
      id, ok: false, error: error instanceof Error ? error.message : String(error ?? "说话人分离失败。")
    }));
});
