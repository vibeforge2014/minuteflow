/**
 * 本机 sherpa ASR（SenseVoice / Parakeet TDT）的主进程门面：
 * - decodeWithSherpaAsr：把一个 16kHz 单声道 WAV 交给常驻 utilityProcess
 *   （asr-worker.mjs）解码，主进程事件循环不被同步原生推理阻塞；
 * - resolveAsrModelPaths：从 bundle 目录挑出引擎需要的具体文件（缺失给可读错误）；
 * - shutdownLocalAsr：应用退出前回收 worker。
 *
 * worker 意外退出时丢弃在途请求并拒绝（错误可读），下一次调用自动重新拉起；
 * 单次解码带 120 秒守护超时，防止单块异常把录音/导入管线永久挂死。
 */
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

const DECODE_TIMEOUT_MS = 120_000;

/**
 * SenseVoice 的语言参数映射：auto（空）→ 空串（引擎内自动检测），zh / en 直接传。
 * Parakeet 不分语言（模型自带语言集合），调用方传空即可。
 */
export function mapSenseVoiceLanguage(language) {
  return language === "zh" || language === "en" ? language : "";
}

let worker = null;
let workerGeneration = 0;
const pending = new Map();

/** 拉起常驻 worker；已存活则复用。 */
function ensureWorker() {
  if (worker && !worker.child.killed) return worker;
  const generation = workerGeneration + 1;
  workerGeneration = generation;
  const child = require("electron").utilityProcess.fork(
    new URL("./asr-worker.mjs", import.meta.url).pathname,
    [],
    { serviceName: "minuteflow-asr", stdio: "ignore" }
  );
  worker = { child, generation };
  child.on("message", (event) => {
    const { id } = event.data ?? {};
    const entry = id ? pending.get(id) : null;
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (event.data.ok) entry.resolve(event.data);
    else entry.reject(new Error(event.data.error || "本机识别失败。"));
  });
  child.on("exit", () => {
    // 崩溃/被杀：所有在途请求按失败落定；下一次调用重新 fork。
    if (worker?.generation !== generation) return;
    const outstanding = [...pending.values()];
    pending.clear();
    worker = null;
    outstanding.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error("本机识别进程已退出，请重试。"));
    });
  });
  return worker;
}

/** 给单个 decode 请求挂守护超时；超时杀掉 worker（可能在原生调用里卡死）。 */
function decodeWithTimeout(payload) {
  return new Promise((resolve, reject) => {
    const running = ensureWorker();
    const id = `asr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      killWorker();
      reject(new Error("本机识别超时，请重试。"));
    }, DECODE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    running.child.postMessage({ id, ...payload });
  });
}

function killWorker() {
  if (!worker) return;
  try {
    worker.child.kill();
  } catch {
    // 已退出的 worker 忽略。
  }
  worker = null;
}

/** SenseVoice / Parakeet bundle 目录 → 引擎需要的具体文件路径（缺失抛可读错误）。 */
export async function resolveAsrModelPaths(engine, modelDirectory) {
  if (!modelDirectory) throw new Error("尚未选择本地模型，请在转录设置中下载或选择模型。");
  let entries;
  try {
    entries = await readdir(modelDirectory, { withFileTypes: true });
  } catch {
    throw new Error("本地模型目录不可读，请在转录设置中重新选择模型。");
  }
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const tokens = names.find((name) => name === "tokens.txt");
  if (!tokens) throw new Error("本地模型目录缺少 tokens.txt，请重新下载模型。");
  const pick = (pattern) => names.filter((name) => pattern.test(name)).sort((left, right) => {
    // 命名一致时优先 fp32 全精度文件（parakeet bundle 目前只有 int8，规则保持通用）。
    const leftInt8 = /int8/i.test(left);
    const rightInt8 = /int8/i.test(right);
    if (leftInt8 !== rightInt8) return leftInt8 ? 1 : -1;
    return left.localeCompare(right);
  })[0];
  if (engine === "sense-voice") {
    const model = pick(/^model(?:\.int8)?\.onnx$/i);
    if (!model) throw new Error("本地模型目录缺少 model.int8.onnx，请重新下载模型。");
    return { tokens: path.join(modelDirectory, tokens), model: path.join(modelDirectory, model) };
  }
  if (engine === "parakeet-tdt") {
    const encoder = pick(/^encoder.*\.onnx$/i);
    const decoder = pick(/^decoder.*\.onnx$/i);
    const joiner = pick(/^joiner.*\.onnx$/i);
    if (!encoder || !decoder || !joiner) {
      throw new Error("本地模型目录缺少 encoder/decoder/joiner 三件套，请重新下载模型。");
    }
    return {
      tokens: path.join(modelDirectory, tokens),
      encoder: path.join(modelDirectory, encoder),
      decoder: path.join(modelDirectory, decoder),
      joiner: path.join(modelDirectory, joiner)
    };
  }
  throw new Error(`引擎 ${engine} 不使用本机 sherpa 运行时。`);
}

/**
 * 解码一段 16kHz 单声道 WAV。profile 需已通过 resolveLocalModelProfile 就绪检查。
 * @returns {Promise<{text: string, timestamps: number[]|null}>}
 */
export async function decodeWithSherpaAsr(profile, wavPath, { language = "", useItn = true, numThreads = 2 } = {}) {
  const engine = profile?.transport;
  if (engine !== "sense-voice" && engine !== "parakeet-tdt") {
    throw new Error(`引擎 ${engine} 不使用本机 sherpa 运行时。`);
  }
  const paths = await resolveAsrModelPaths(engine, profile?.options?.modelPath);
  return decodeWithTimeout({
    type: "decode",
    engine,
    paths,
    language,
    useItn,
    numThreads,
    wavPath
  });
}

/** 应用退出前回收 worker（before-quit 调用；在途请求按失败落定）。 */
export function shutdownLocalAsr() {
  const outstanding = [...pending.values()];
  pending.clear();
  killWorker();
  outstanding.forEach((entry) => {
    clearTimeout(entry.timer);
    entry.reject(new Error("应用正在退出，本机识别已取消。"));
  });
}
