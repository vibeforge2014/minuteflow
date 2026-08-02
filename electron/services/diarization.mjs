import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

const require = createRequire(import.meta.url);

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

async function ensureWave(filePath, ffmpegPath) {
  if (path.extname(filePath).toLowerCase() === ".wav") {
    return { filePath, temporary: false };
  }
  if (!ffmpegPath) {
    throw new Error("说话人分离非 WAV 文件时需要配置 FFmpeg 路径。");
  }
  const target = path.join(tmpdir(), `${randomUUID()}-diarization.wav`);
  await runProcess(ffmpegPath, [
    "-y", "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", target
  ]);
  return { filePath: target, temporary: true };
}

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

  const waveAsset = await ensureWave(audioFilePath, profile.options?.ffmpegPath);
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
