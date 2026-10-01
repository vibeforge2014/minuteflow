/**
 * 说话人分离的 utilityProcess 入口（由 diarization.mjs 的 diarizeWithSherpa fork）。
 * 整段 pyannote 分段 + 聚类 + 3D-Speaker 嵌入是同步原生推理，34 分钟音频约需
 * 4-5 分钟——放在主进程会把事件循环整个卡住（所有 IPC 挂起、界面假死），因此
 * 全部搬进这个独立进程，主进程只等待结果消息。
 *
 * 协议：parentPort 收到 { id, audioFilePath, ffmpegPath, segmentationModel,
 * embeddingModel, clustering, voiceprintSamples, voiceprintThreshold,
 * voiceprintMargin }；回 { id, ok: true, turns } 或 { id, ok: false, error }。
 * 样本向量只在本机进程间传递，不出设备。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  computeClusterCentroids,
  computeVoiceprintEmbedding,
  matchVoiceprint,
  mergeDiarizationClusters
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
async function diarize(request) {
  const { audioFilePath, ffmpegPath, segmentationModel, embeddingModel } = request;
  let sherpaOnnx;
  try {
    sherpaOnnx = require("sherpa-onnx-node");
  } catch {
    throw new Error("未安装 sherpa-onnx-node 运行时，请重新安装应用或改用手动发言人标签。");
  }
  const waveAsset = await ensureWave(audioFilePath, sherpaOnnx, ffmpegPath);
  try {
    const diarizer = new sherpaOnnx.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: segmentationModel } },
      embedding: { model: embeddingModel },
      clustering: {
        numClusters: request.clustering?.numClusters ?? -1,
        threshold: request.clustering?.threshold ?? 0.5
      },
      minDurationOn: 0.2,
      minDurationOff: 0.5
    });
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
    const samples = (request.voiceprintSamples ?? []).map((sample) => ({
      name: sample.name,
      embedding: Float32Array.from(sample.embedding ?? [])
    }));
    if (!samples.length) return turns;

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
        const match = matchVoiceprint(embedding, samples, {
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
  diarize(request)
    .then((turns) => process.parentPort.postMessage({ id, ok: true, turns }))
    .catch((error) => process.parentPort.postMessage({
      id, ok: false, error: error instanceof Error ? error.message : String(error ?? "说话人分离失败。")
    }));
});
