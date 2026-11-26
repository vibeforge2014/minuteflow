/**
 * P1：低置信度 / 单段局部重识别服务（不重跑整场录音，只裁剪目标时间区间）。
 *
 * 流程：
 * 1. 从会议的归档音频资产中选出最匹配的音轨（优先同 track，其次 mixed，再兜底首条可用资产）；
 * 2. 用托管 FFmpeg 仅裁剪 [startMs - 800ms, endMs + 800ms] 为 16k 单声道 WAV，避免整场重复转码；
 * 3. 做音频增强后，注入本场动态热词 + 前序定稿上下文重新调用当前 STT 引擎；
 * 4. 提取落回原时间窗内的文字更新该段落，保留 rawText（原稿可恢复）并更新真实置信度。
 */
import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { enhanceTranscriptionAudio } from "./transcription-audio.mjs";
import { simplifyTranscriptResult } from "./chinese.mjs";
import { withSegmentConfidence } from "./transcript-confidence.mjs";

const PAD_BEFORE_MS = 800;
const PAD_AFTER_MS = 800;
const MIN_CLIP_MS = 1_200;

/** 用 FFmpeg 裁剪单个时间窗并转成 16k 单声道 PCM WAV。 */
export function extractSegmentWav(ffmpegPath, sourcePath, outputPath, startMs, durationMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y",
      "-ss", (Math.max(0, startMs) / 1000).toFixed(3),
      "-t", (Math.max(MIN_CLIP_MS, durationMs) / 1000).toFixed(3),
      "-i", sourcePath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      outputPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* 进程已退出 */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new DOMException("已取消局部重识别", "AbortError"));
        return;
      }
      if (code === 0) resolve(outputPath);
      else reject(new Error(`裁剪段落音频失败（exit ${code}）：${stderr.trim().slice(-240)}`));
    });
  });
}

/** 按段落音轨优先级选出最合适的归档音频资产。 */
export async function pickSegmentAudioAsset(assets = [], track = "mixed") {
  const ordered = [
    ...assets.filter((a) => a.track === track),
    ...assets.filter((a) => a.track === "mixed" && a.track !== track),
    ...assets.filter((a) => a.track !== track && a.track !== "mixed")
  ];
  for (const asset of ordered) {
    const candidatePath = asset.path || asset.playbackPath;
    if (!candidatePath) continue;
    const info = await stat(candidatePath).catch(() => null);
    if (info?.isFile() && info.size > 0) {
      return { ...asset, resolvedPath: candidatePath };
    }
  }
  return null;
}

/** 从带前后填充窗的识别结果里，挑出中心落在原段落窗口内的片段文本与置信度。 */
export function selectCoreClipText(result, padBeforeMs, segmentDurationMs) {
  const coreStart = Math.max(0, padBeforeMs - 250);
  const coreEnd = padBeforeMs + Math.max(400, segmentDurationMs) + 250;
  if (Array.isArray(result?.segments) && result.segments.length) {
    const inside = result.segments.filter((seg) => {
      const text = String(seg?.text ?? "").trim();
      if (!text) return false;
      const start = Number(seg.startMs) || 0;
      const end = Math.max(start, Number(seg.endMs) || start);
      const mid = (start + end) / 2;
      return mid >= coreStart && mid <= coreEnd;
    });
    const chosen = inside.length ? inside : result.segments.filter((seg) => String(seg?.text ?? "").trim());
    const text = chosen.map((seg) => String(seg.text).trim()).join("").trim();
    const confs = chosen.map((seg) => seg.confidence).filter((c) => typeof c === "number" && Number.isFinite(c));
    const confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : result.confidence;
    if (text) return { text, confidence };
  }
  const fallback = String(result?.text ?? "").trim();
  return { text: fallback, confidence: result?.confidence };
}

/**
 * 对单个转写段落执行局部重识别。
 */
export async function retranscribeSingleSegment({
  meeting,
  segmentId,
  assets,
  ffmpegPath,
  hotwords = [],
  language = "",
  transcribeWav,
  signal
}) {
  const transcript = Array.isArray(meeting?.transcript) ? meeting.transcript : [];
  const index = transcript.findIndex((seg) => seg.id === segmentId);
  if (index < 0) throw new Error("未找到要重新识别的转写段落。");
  const target = transcript[index];
  if (!ffmpegPath) throw new Error("内置音频组件不可用，无法裁剪局部音频。");

  const asset = await pickSegmentAudioAsset(assets, target.track);
  if (!asset) throw new Error("该会议没有可用的归档录音文件，无法局部重识别。");

  const startMs = Math.max(0, Number(target.startMs) || 0);
  const endMs = Math.max(startMs + 400, Number(target.endMs) || startMs + 2000);
  const clipStartMs = Math.max(0, startMs - PAD_BEFORE_MS);
  const actualPadBeforeMs = startMs - clipStartMs;
  const segmentDurationMs = endMs - startMs;
  const clipDurationMs = Math.max(MIN_CLIP_MS, actualPadBeforeMs + segmentDurationMs + PAD_AFTER_MS);

  const previousText = transcript
    .slice(Math.max(0, index - 2), index)
    .filter((seg) => seg.status !== "provisional" && typeof seg.text === "string")
    .map((seg) => seg.text.trim())
    .join("");

  const tempWav = path.join(tmpdir(), `minuteflow-retranscribe-${randomUUID()}.wav`);
  try {
    await extractSegmentWav(ffmpegPath, asset.resolvedPath, tempWav, clipStartMs, clipDurationMs, signal);
    const rawBuffer = await readFile(tempWav);
    const enhancedBuffer = await enhanceTranscriptionAudio(rawBuffer, ffmpegPath);
    const rawResult = await transcribeWav({
      audio: enhancedBuffer,
      wavPath: tempWav,
      fileName: `segment-${index}.wav`,
      language,
      glossary: hotwords,
      previousText
    });
    const normalized = withSegmentConfidence(simplifyTranscriptResult(rawResult));
    const { text, confidence } = selectCoreClipText(normalized, actualPadBeforeMs, segmentDurationMs);
    if (!text) {
      throw new Error("局部重识别未返回有效文字，已保留原段落内容。");
    }
    const updatedSegment = {
      ...target,
      rawText: target.rawText ?? target.text,
      text,
      corrected: false,
      ...(typeof confidence === "number" && Number.isFinite(confidence) ? { confidence } : {})
    };
    const nextTranscript = transcript.map((seg) => (seg.id === segmentId ? updatedSegment : seg));
    return {
      segment: updatedSegment,
      transcript: nextTranscript
    };
  } finally {
    await rm(tempWav, { force: true }).catch(() => {});
  }
}
