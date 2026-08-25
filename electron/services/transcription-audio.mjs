/**
 * 在线实时转录的音频预处理。
 *
 * Chromium MediaRecorder 生成的短 WebM/MP4 块可以正常解码，但 WebM 往往不含
 * Duration 元数据。部分 OpenAI 兼容网关会在转录前先读取时长用于计费，因而拒绝
 * 这类块。上传前统一转为 16 kHz 单声道 PCM WAV，既保留短块低延迟，也让时长可
 * 由固定采样率和数据长度可靠计算。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LIVE_CAPTURE_EXTENSIONS = new Set([".webm", ".m4a", ".mp4", ".ogg"]);

/** 仅转换浏览器实时采集格式；已经是 WAV 的导入块无需重复转码。 */
export function needsRemoteTranscriptionNormalization(fileName) {
  return LIVE_CAPTURE_EXTENSIONS.has(path.extname(String(fileName || "")).toLowerCase());
}

/** 拉起托管 FFmpeg，支持取消和 30 秒硬超时。 */
function runFfmpeg(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("转录请求已取消。")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("实时音频预处理超时。")));
    }, 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `FFmpeg 退出码 ${code}`));
    }));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 把一个浏览器实时音频块转成服务端兼容的 WAV。
 * execute 参数仅用于单元测试替换子进程，正式调用使用上面的托管 FFmpeg runner。
 */
export async function normalizeRemoteTranscriptionAudio(
  audioBuffer,
  fileName,
  ffmpegPath,
  signal,
  execute = runFfmpeg
) {
  if (!needsRemoteTranscriptionNormalization(fileName)) {
    return { audio: Buffer.from(audioBuffer), fileName };
  }
  if (!ffmpegPath) {
    throw new Error("应用内置音频组件无法加载，暂时不能发送实时在线转录。请重新安装 MinuteFlow。");
  }
  const sourceExtension = path.extname(String(fileName || "")).toLowerCase();
  const token = randomUUID();
  const inputPath = path.join(tmpdir(), `${token}-live${sourceExtension}`);
  const outputPath = path.join(tmpdir(), `${token}-live.wav`);
  await writeFile(inputPath, audioBuffer);
  try {
    await execute(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav",
      outputPath
    ], signal);
    const wave = await readFile(outputPath);
    if (wave.length <= 44 || wave.subarray(0, 4).toString("ascii") !== "RIFF") {
      throw new Error("FFmpeg 未生成有效 WAV 音频。");
    }
    return {
      audio: wave,
      fileName: `${path.basename(String(fileName || "chunk"), sourceExtension)}.wav`
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`实时音频预处理失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
  }
}
