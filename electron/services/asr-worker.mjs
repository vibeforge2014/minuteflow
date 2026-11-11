/**
 * 本机 sherpa ASR（SenseVoice / Parakeet TDT）的 utilityProcess 入口
 * （由 asr-runtime.mjs 常驻 fork）。
 *
 * OfflineRecognizer 的创建与解码都是同步原生调用：放在主进程会卡住事件循环
 * （所有 IPC 挂起、界面假死），因此模型加载与逐块解码全部搬进这个独立进程，
 * 主进程只按消息 id 收发结果。识别器按（引擎+模型路径+语言+ITN）缓存，
 * 录音/导入的连续音频块复用同一实例，避免每个 8-10 秒块重新加载模型。
 *
 * 协议：parentPort 收到 { id, type:"decode", engine, paths, language, useItn,
 * numThreads, wavPath }（或 { id, type:"shutdown" }）；回 { id, ok:true, text,
 * timestamps? } 或 { id, ok:false, error }。
 * readWave 必须传拷贝标志 false：Electron 的 V8 禁用外部缓冲区
 * （AGENTS.md 记录的 "External buffers are not allowed"）。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let sherpaOnnx;

/** 惰性加载 sherpa-onnx-node；缺失时给可读错误（与说话人分离共用同一运行时）。 */
function getSherpaOnnx() {
  if (!sherpaOnnx) {
    try {
      sherpaOnnx = require("sherpa-onnx-node");
    } catch {
      throw new Error("未安装 sherpa-onnx-node 运行时，请重新安装应用或改用其他转录引擎。");
    }
    if (!sherpaOnnx?.OfflineRecognizer) {
      throw new Error("sherpa-onnx-node 运行时缺少 OfflineRecognizer，请更新应用。");
    }
  }
  return sherpaOnnx;
}

/** 同一份（引擎+模型文件+语言+ITN）配置只创建一次识别器。 */
const recognizers = new Map();

function recognizerKey(request) {
  return JSON.stringify([request.engine, request.paths, request.language ?? "", request.useItn !== false]);
}

/** 按引擎构造 OfflineModelConfig：SenseVoice 单模型 / NeMo TDT 三件套。 */
function buildModelConfig(request) {
  const { paths } = request;
  const base = {
    tokens: paths.tokens,
    numThreads: request.numThreads ?? 2,
    debug: 0,
    provider: "cpu"
  };
  if (request.engine === "sense-voice") {
    return {
      ...base,
      senseVoice: {
        model: paths.model,
        // 语言为空 = 自动检测；由调用方按应用的「自动/中文/英文」偏好映射。
        language: request.language ?? "",
        useInverseTextNormalization: request.useItn === false ? 0 : 1
      }
    };
  }
  return {
    ...base,
    transducer: {
      encoder: paths.encoder,
      decoder: paths.decoder,
      joiner: paths.joiner
    }
  };
}

async function getRecognizer(request) {
  const key = recognizerKey(request);
  const existing = recognizers.get(key);
  if (existing) return existing;
  const sherpa = getSherpaOnnx();
  const config = {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: buildModelConfig(request)
  };
  // createAsync 让模型加载不阻塞 worker 事件循环；旧版本回退同步构造。
  const recognizer = typeof sherpa.OfflineRecognizer.createAsync === "function"
    ? await sherpa.OfflineRecognizer.createAsync(config)
    : new sherpa.OfflineRecognizer(config);
  recognizers.set(key, recognizer);
  return recognizer;
}

/** 解码一个 16kHz 单声道 WAV：acceptWaveform → decode → 结果 JSON。 */
async function decode(request) {
  const sherpa = getSherpaOnnx();
  const recognizer = await getRecognizer(request);
  // 拷贝标志是硬性要求（见文件头注释）；采样率由调用方保证 16k 单声道。
  const wave = sherpa.readWave(request.wavPath, false);
  const stream = recognizer.createStream();
  stream.acceptWaveform(wave);
  recognizer.decode(stream);
  const result = recognizer.getResult(stream) ?? {};
  const text = String(result.text ?? "").trim();
  return {
    text,
    timestamps: Array.isArray(result.timestamps) ? result.timestamps : null
  };
}

process.parentPort.on("message", (event) => {
  const { id, ...request } = event.data ?? {};
  if (!id) return;
  if (request.type === "shutdown") {
    process.exit(0);
  }
  decode(request)
    .then((result) => process.parentPort.postMessage({ id, ok: true, ...result }))
    .catch((error) => process.parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error ?? "本机识别失败。")
    }));
});
