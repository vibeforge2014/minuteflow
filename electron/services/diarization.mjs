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
 * 已是 .wav 直接复用；否则用 FFmpeg 转出临时文件（temporary 标记临时文件需清理）。
 */
async function ensureWave(filePath) {
  if (path.extname(filePath).toLowerCase() === ".wav") {
    return { filePath, temporary: false };
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

  const waveAsset = await ensureWave(audioFilePath);
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
    const wave = sherpaOnnx.readWave(waveAsset.filePath);
    // 模型只接受其固有采样率（16k），不匹配直接报错而不是静默产出错误结果。
    if (diarizer.sampleRate !== wave.sampleRate) {
      throw new Error(`说话人模型需要 ${diarizer.sampleRate}Hz 音频，实际为 ${wave.sampleRate}Hz。`);
    }
    return diarizer.process(wave.samples).map((turn) => ({
      startMs: Math.round((turn.start ?? turn.startSeconds ?? 0) * 1000),
      endMs: Math.round((turn.end ?? turn.endSeconds ?? 0) * 1000),
      speakerId: `speaker-${Number(turn.speaker ?? turn.speakerId ?? 0) + 1}`
    }));
  } finally {
    if (waveAsset.temporary) await unlink(waveAsset.filePath).catch(() => {});
  }
}

/**
 * 把分离轮次套回转录段：取每段的时间中点落在哪个轮次内即标记为该说话人，
 * 命不中任何轮次的段保持原说话人不变（保持幂等、不破坏原文）。
 * @param {Array} transcript 转录段落
 * @param {Array<{startMs,endMs,speakerId}>} turns diarizeWithSherpa 的轮次
 * @returns {Array} 更新说话人标签后的转录段
 */
export function applyDiarization(transcript, turns) {
  if (!turns.length) return transcript;
  return transcript.map((segment) => {
    const midpoint = (segment.startMs + segment.endMs) / 2;
    const turn = turns.find((item) => midpoint >= item.startMs && midpoint <= item.endMs);
    if (!turn) return segment;
    const speakerNumber = turn.speakerId.replace(/\D/g, "") || "1";
    return {
      ...segment,
      speakerId: turn.speakerId,
      speakerName: `Speaker ${speakerNumber}`
    };
  });
}
