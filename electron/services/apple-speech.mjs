/**
 * Apple Speech 本机转录（macOS 专属）。
 *
 * 通过预编译的 Swift helper（resources/apple-speech/mf-apple-speech.swift 产物）
 * 调用 macOS 内置的 SFSpeechRecognizer：完全免费、默认强制本机识别（音频不出设备）、
 * 无需下载任何模型。helper 以子进程运行，TCC 权限归属 MinuteFlow 主应用
 * （Info.plist 的 NSSpeechRecognitionUsageDescription）。
 *
 * 实测约束：helper 必须由 GUI 应用派生才能正确归属权限；纯 shell 直跑会被 TCC 拒绝。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 出厂默认判定：macOS 且用户还没有任何 stt 档案时，预启用 Apple 语音识别，
 * 让新装用户第一次录音即实时转写（零下载零配置）。已有 Whisper/在线配置的老用户
 * 与非 macOS 平台不受影响。
 */
export function shouldSeedAppleSpeechProfile(platform, sttProfileCount) {
  return platform === "darwin" && sttProfileCount === 0;
}

/** 出厂默认的 Apple 语音识别档案（智谱式多可用：保存即启用；首条 stt 档案自动成为默认档）。 */
export function appleSpeechDefaultProfile() {
  return {
    name: "Apple 语音识别",
    kind: "stt",
    transport: "apple-speech",
    baseUrl: "",
    model: "",
    enabled: true,
    isDefault: true,
    options: {}
  };
}

/**
 * 解析 helper 二进制路径：开发态取仓库 resources/bin，打包态取 Contents/Resources/bin。
 * @returns {string|null} 可执行文件路径；缺失（非 macOS 或未构建）返回 null。
 */
export function appleSpeechHelperPath() {
  if (process.platform !== "darwin") return null;
  const name = "mf-apple-speech-darwin-universal";
  const packaged = path.join(process.resourcesPath ?? "", "bin", name);
  if (existsSync(packaged)) return packaged;
  // electron/services/ → 仓库根/resources/bin/
  const dev = path.join(MODULE_DIR, "..", "..", "resources", "bin", name);
  return existsSync(dev) ? dev : null;
}

/**
 * 把应用语言偏好映射为 Apple Speech 的 BCP-47 locale。
 * @param {string|undefined} language "zh"/"en"/"auto"/"zh-CN"/"en-US" 等
 * @returns {string} 语音识别 locale；auto 与中文一律 zh-CN（首发中文优先）。
 */
export function mapLanguageToLocale(language) {
  const value = String(language ?? "").trim();
  if (!value || value === "auto") return "zh-CN";
  if (/^[a-z]{2,3}(-[\w-]+)?$/i.test(value) && value.includes("-")) return value;
  const lowered = value.toLowerCase();
  if (lowered === "en") return "en-US";
  if (lowered === "ja") return "ja-JP";
  if (lowered === "ko") return "ko-KR";
  if (lowered === "zh") return "zh-CN";
  if (/^[a-z]{2,3}$/i.test(lowered)) return `${lowered}-${lowered.toUpperCase()}`;
  return "zh-CN";
}

/** 解析 helper 的单行 JSON 输出；坏输出视为识别失败。 */
export function parseHelperOutput(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "");
  } catch {
    throw new Error("Apple 语音识别组件返回了无法解析的结果。");
  }
  if (!payload || payload.ok !== true) {
    // 系统识别器对静音音频走失败路径（helper 报 recognition_failed + 原始错误文本
    // "No speech detected"，中文系统则是「未检测到语音」），而不是 ok:true 空文本。
    // 统一归一为 no_speech：导入/直播按空输入继续，不把任务或录音块打成失败。
    if (payload?.code === "recognition_failed"
      && /no speech|未检测到语音|没有检测到语音|未检测到讲话/i.test(String(payload?.message ?? ""))) {
      const silentError = new Error("这段音频里没有识别到语音内容。");
      silentError.appleSpeechCode = "no_speech";
      throw silentError;
    }
    const message = payload?.message || "Apple 语音识别失败。";
    const error = new Error(message);
    error.appleSpeechCode = payload?.code || "unknown";
    throw error;
  }
  const segments = Array.isArray(payload.segments)
    ? payload.segments
        .filter((item) => item && typeof item.text === "string" && item.text.trim().length > 0)
        .map((item) => ({
          startMs: Math.max(0, Math.round(Number(item.start) || 0)),
          endMs: Math.max(0, Math.round(Number(item.end) || 0)),
          text: String(item.text).trim()
        }))
    : [];
  const text = String(payload.text ?? "").trim();
  if (!text && segments.length === 0) {
    const error = new Error("这段音频里没有识别到语音内容。");
    error.appleSpeechCode = "no_speech";
    throw error;
  }
  return {
    text,
    segments: segments.length > 0 ? segments : [{ startMs: 0, endMs: 0, text }],
    onDeviceUsed: payload.onDeviceUsed === true,
    partial: payload.partial === true
  };
}

/**
 * 运行 helper 一次（check 或 transcribe），带硬超时与取消支持。
 * @returns {Promise<object>} 解析后的 JSON payload
 */
function runHelper(helperPath, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(helperPath, args, { windowsHide: true });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("语音识别已取消。")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("语音识别组件响应超时。")));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", () => finish(() => {
      try {
        resolve(parseHelperOutput(stdout));
      } catch (error) {
        if (stderr.trim()) {
          error.message = `${error.message}（${stderr.trim().slice(0, 200)}）`;
        }
        reject(error);
      }
    }));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** 随包中文测试样例（设置页「测试连接」用它跑一次真实识别）。 */
export function appleSpeechFixturePath() {
  if (process.platform !== "darwin") return null;
  const name = "apple-speech-test-zh.wav";
  const packaged = path.join(process.resourcesPath ?? "", "fixtures", name);
  if (existsSync(packaged)) return packaged;
  const dev = path.join(MODULE_DIR, "..", "..", "resources", "fixtures", name);
  return existsSync(dev) ? dev : null;
}

/**
 * 检查 Apple Speech 在当前机器的可用性（权限状态 + 语言支持）。
 * 不触发权限弹窗：notDetermined 只如实上报，由设置页测试按钮在用户主动时触发。
 */
export async function checkAppleSpeech(language = "zh-CN") {
  const helperPath = appleSpeechHelperPath();
  if (!helperPath) {
    return { available: false, reason: "missing_helper" };
  }
  const locale = mapLanguageToLocale(language);
  try {
    const payload = await runHelper(helperPath, ["check", "--locale", locale], 45_000);
    return {
      available: true,
      locale,
      authorization: payload.authorization ?? "unknown",
      supportsOnDevice: payload.supportsOnDevice === true,
      localeAvailable: payload.localeAvailable === true
    };
  } catch {
    return { available: false, reason: "helper_failed" };
  }
}

/**
 * 用 Apple Speech 转录一段音频。
 * @param {object} profile transport 为 "apple-speech" 的模型档案（无模型字段）
 * @param {Buffer} audio 音频数据（WebM/MP4 会先经托管 FFmpeg 转 16k WAV；WAV 直接使用）
 * @param {string} fileName 音频文件名（决定是否需要转码）
 * @param {string} language 语言偏好
 * @param {unknown} _glossary 未使用（Apple Speech 不支持自定义热词），保持签名一致
 * @param {object} [options] { allowServer?: boolean, ffmpegPath?: string, signal?: AbortSignal }
 * @returns {Promise<{text: string, segments: Array<{startMs,endMs,text}>, onDeviceUsed: boolean, partial?: boolean}>}
 */
export async function transcribeWithAppleSpeech(profile, audio, fileName, language, _glossary, options = {}) {
  const helperPath = appleSpeechHelperPath();
  if (!helperPath) {
    const error = new Error("[STT_NOT_READY] Apple 语音识别组件缺失，请重新安装 MinuteFlow 或改用其他转录方式。");
    error.appleSpeechCode = "missing_helper";
    throw error;
  }
  // 归一化在服务内部完成：transcription:chunk 对本地与远程 profile 传入的都是原始块。
  const prepared = await options.prepareAudio
    ? await options.prepareAudio(audio, fileName)
    : { audio, fileName };
  const token = randomUUID();
  const inputPath = path.join(tmpdir(), `mf-speech-${token}.wav`);
  await mkdir(tmpdir(), { recursive: true });
  await writeFile(inputPath, prepared.audio);
  try {
    // 单块识别时限：默认 55 秒（8–10 秒块），导入的 30 秒长块由调用方放宽到 100 秒。
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 55_000, 10_000), 300_000);
    const args = ["transcribe", inputPath, "--locale", mapLanguageToLocale(language), "--timeout", String(Math.round(timeoutMs / 1000))];
    if (options.allowServer) args.push("--allow-server");
    const payload = await runHelper(helperPath, args, timeoutMs + 10_000, options.signal);
    return {
      text: payload.text,
      segments: payload.segments,
      onDeviceUsed: payload.onDeviceUsed,
      ...(payload.partial ? { partial: true } : {})
    };
  } catch (error) {
    if (error.appleSpeechCode === "missing_helper") throw error;
    // 常见环境问题给出可行动文案；超时兜底提示听写资源。
    if (error.appleSpeechCode === "timeout") {
      error.message = "Apple 语音识别超时。请到 系统设置 → 键盘 → 听写 下载对应语言的离线资源后重试。";
    }
    throw error;
  } finally {
    await Promise.allSettled([unlink(inputPath)]);
  }
}

/** 供设置页「测试」使用：转录随包的中文样例语音，返回识别文本。 */
export async function testAppleSpeech(fixturePath, language = "zh-CN", options = {}) {
  const helperPath = appleSpeechHelperPath();
  if (!helperPath) return { available: false, reason: "missing_helper" };
  const audio = await readFile(fixturePath);
  const result = await transcribeWithAppleSpeech(
    { transport: "apple-speech" },
    audio,
    path.basename(fixturePath),
    language,
    undefined,
    options
  );
  return { available: true, text: result.text, onDeviceUsed: result.onDeviceUsed };
}
