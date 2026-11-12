/**
 * 转写音频质量：增强偏好、静音门限与 PCM 能量计算（纯逻辑 + 主进程模块级偏好）。
 *
 * 两条准确率问题的根因：
 * 1) 欠响度、带低频隆隆声的录音会让声学模型「听不清」。实测 -30dB 的会议 MP3
 *    经 highpass + loudnorm 后 Apple Speech 识别字数翻倍以上，但滤镜原先只挂在
 *    Apple 路由上，Whisper / 在线引擎吃不到同一份处理过的音频。
 * 2) 长录音里大量纯静音块会被 Whisper 解码成「谢谢观看」「好的，下一段」等幻觉，
 *    污染逐字稿与后续纪要。送进模型前先算 PCM 能量，静音块直接出空结果。
 *
 * 关键顺序：静音判定必须基于**未经 loudnorm 的原始 PCM**，否则底噪被整体抬升后
 * 会被误判成有人说话。因此增强被拆成独立的后处理步骤，不与格式归一化合并。
 */

/** 广播级响度归一 + 70Hz 高通（去空调/键盘/桌面低频隆隆声）。 */
export const AUDIO_ENHANCEMENT_FILTERS = ["highpass=f=70", "loudnorm=I=-16:TP=-1.5:LRA=9"];

/** RMS 低于约 -48 dBFS 视为静音；与峰值、活跃样本占比同时满足才跳过。 */
export const DEFAULT_SILENCE_RMS_THRESHOLD = 0.004;
/** 峰值高于约 -34 dBFS 说明有短促人声/敲击，即使整体 RMS 很低也不能跳过。 */
export const DEFAULT_SILENCE_PEAK_THRESHOLD = 0.02;
/** 超过 -40 dBFS 的样本占比上限。 */
export const DEFAULT_SILENCE_ACTIVE_RATIO = 0.01;
/** 短于 200ms 的块不下静音结论（可能是极短的语气词）。 */
export const MIN_SILENCE_DURATION_MS = 200;

// 主进程单例偏好；未注入时保持「增强开 / 静音跳过开」，与旧版 Apple 路由行为一致。
let enhancementEnabled = true;
let silenceSkipEnabled = true;

/** 由 main.mjs 在偏好读取/保存后注入，实时录音与导入队列共享同一份开关。 */
export function setAudioQualityPreferences(preferences = {}) {
  if (typeof preferences?.audioEnhancement === "boolean") enhancementEnabled = preferences.audioEnhancement;
  if (typeof preferences?.silenceSkip === "boolean") silenceSkipEnabled = preferences.silenceSkip;
  return { audioEnhancement: enhancementEnabled, silenceSkip: silenceSkipEnabled };
}

export function isAudioEnhancementEnabled() {
  return enhancementEnabled;
}

export function isSilenceSkipEnabled() {
  return silenceSkipEnabled;
}

/** FFmpeg -af 参数；关闭时返回空数组（调用方跳过增强步骤）。 */
export function audioEnhancementFilters() {
  return enhancementEnabled ? [...AUDIO_ENHANCEMENT_FILTERS] : [];
}

/**
 * 解析标准 PCM WAV 的 fmt/data 块。只接受 16-bit PCM（本应用所有切块都由
 * FFmpeg 以 pcm_s16le 输出）；浮点/压缩/损坏格式返回 null，调用方按「不敢判定」处理。
 */
export function parsePcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === "data") {
      data = { start: body, length: Math.min(size, Math.max(0, buffer.length - body)) };
      break;
    }
    if (size <= 0) break;
    offset = body + size + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.bitsPerSample !== 16 || data.length < 2) return null;
  return { ...format, ...data };
}

/**
 * 计算 WAV 的 RMS、峰值与活跃样本占比。等间隔抽样到 maxSamples，避免 30 秒
 * 480k 采样块在主线程做全量循环；统计特征对抽样不敏感。
 * @returns {{rms:number, peak:number, activeRatio:number, durationMs:number, sampleCount:number}|null}
 */
export function measurePcmWav(buffer, { maxSamples = 160_000 } = {}) {
  const wav = parsePcmWav(buffer);
  if (!wav) return null;
  const sampleCount = Math.floor(wav.length / 2);
  if (!sampleCount) return null;
  const step = Math.max(1, Math.floor(sampleCount / Math.max(1, maxSamples)));
  let sumSquares = 0;
  let peak = 0;
  let active = 0;
  let counted = 0;
  for (let index = 0; index < sampleCount; index += step) {
    const sample = buffer.readInt16LE(wav.start + index * 2) / 32768;
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    if (magnitude > peak) peak = magnitude;
    if (magnitude > 0.01) active += 1;
    counted += 1;
  }
  if (!counted) return null;
  return {
    rms: Math.sqrt(sumSquares / counted),
    peak,
    activeRatio: active / counted,
    durationMs: Math.round((sampleCount / Math.max(1, wav.sampleRate) / Math.max(1, wav.channels)) * 1000),
    sampleCount
  };
}

/**
 * 判断一块 PCM WAV 是否为静音。解析失败、块太短一律返回 false —— 宁可多跑一次
 * 识别，也不能把有人说话的块整段丢掉。
 */
export function isSilentPcmWav(buffer, options = {}) {
  const energy = measurePcmWav(buffer, options);
  if (!energy || energy.durationMs < (options.minDurationMs ?? MIN_SILENCE_DURATION_MS)) return false;
  const rmsThreshold = options.rmsThreshold ?? DEFAULT_SILENCE_RMS_THRESHOLD;
  const peakThreshold = options.peakThreshold ?? DEFAULT_SILENCE_PEAK_THRESHOLD;
  const activeThreshold = options.activeRatioThreshold ?? DEFAULT_SILENCE_ACTIVE_RATIO;
  return energy.rms < rmsThreshold
    && energy.peak < peakThreshold
    && energy.activeRatio < activeThreshold;
}
