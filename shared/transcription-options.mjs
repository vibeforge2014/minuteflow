/** Per-profile transcription settings shared by renderer and main process. */
export function transcriptionComputeMode(value) {
  return value === "cpu" || value === "gpu" ? value : "auto";
}

/** GPU backends the app can request. Driver and runtime availability still depend on the device. */
export function transcriptionGpuBackend(profile, platform, arch) {
  switch (profile.transport) {
    case "whisper-cpp":
      if (profile.options?.executablePath) return "external";
      if (platform === "darwin" && arch === "arm64") return "metal";
      if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "vulkan";
      return undefined;
    case "whisper-python":
    case "faster-whisper":
      return platform === "win32" || platform === "linux" ? "cuda" : undefined;
    case "mlx-whisper":
      return platform === "darwin" && arch === "arm64" ? "metal" : undefined;
    default:
      return undefined;
  }
}

export const decodingKeys = [
  'temperature', 'temperatureStep', 'beamSize', 'bestOf',
  'noSpeechThreshold', 'logprobThreshold', 'entropyThreshold', 'compressionRatioThreshold'
];
export const transcriptionKeys = ['transcriptionLanguage', 'initialPrompt', ...decodingKeys, 'cpuThreads', 'usePreviousText', 'vadFilter'];
export const parameterRanges = {
  temperature: [0, 1, 0.1], temperatureStep: [0, 1, 0.1], beamSize: [1, 8, 1],
  bestOf: [1, 8, 1], noSpeechThreshold: [0, 1, 0.05], logprobThreshold: [-2, 0, 0.1],
  entropyThreshold: [0, 5, 0.1], compressionRatioThreshold: [1, 5, 0.1], cpuThreads: [1, 16, 1]
};
export function transcriptionParamCapabilities(transport, options = {}) {
  const base = ['transcriptionLanguage'];
  if (transport === 'parakeet-tdt') return [];
  if (['sense-voice', 'qwen3-asr', 'apple-speech'].includes(transport)) return base;
  if (!['openai-audio', 'whisper-cpp', 'whisper-python', 'faster-whisper', 'mlx-whisper'].includes(transport)) return [];
  const common = [...base, 'initialPrompt', 'temperature', 'usePreviousText'];
  if (transport === 'openai-audio') return common;
  if (transport === 'whisper-cpp') {
    const local = [...common, 'temperatureStep', 'bestOf', 'cpuThreads'];
    return options.executablePath ? [...local, 'beamSize', 'noSpeechThreshold', 'logprobThreshold', 'entropyThreshold'] : local;
  }
  const python = [...common, 'temperatureStep', 'bestOf', 'noSpeechThreshold', 'logprobThreshold', 'compressionRatioThreshold'];
  if (transport === 'mlx-whisper') return python;
  return transport === 'faster-whisper' ? [...python, 'beamSize', 'vadFilter'] : [...python, 'beamSize'];
}
export function resolveTranscriptionLanguage(explicit, options = {}, globalLanguage = 'zh') {
  return explicit || options.transcriptionLanguage || globalLanguage || 'zh';
}
/** Ignore unsupported/invalid persisted values rather than sending unknown engine arguments. */
export function transcriptionDecodingOptions(profile) {
  const supported = transcriptionParamCapabilities(profile.transport, profile.options);
  return Object.fromEntries(decodingKeys.flatMap(key => {
    const value = profile.options?.[key];
    return supported.includes(key) && validNumericParameter(key, value) ? [[key, value]] : [];
  }));
}
function validNumericParameter(key, value) {
  const [min, max, step] = parameterRanges[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (step !== 1 || Number.isInteger(value));
}
export function whisperCpuThreads(profile) {
  const threads = profile.options?.cpuThreads;
  return profile.transport === 'whisper-cpp' && validNumericParameter('cpuThreads', threads) ? threads : undefined;
}
export function whisperCliDecodingArgs(profile) {
  const flags = {temperature:'--temperature',temperatureStep:'--temperature-inc',beamSize:'--beam-size',bestOf:'--best-of',noSpeechThreshold:'--no-speech-thold',logprobThreshold:'--logprob-thold',entropyThreshold:'--entropy-thold'};
  const args = Object.entries(transcriptionDecodingOptions(profile)).flatMap(([key,value]) => [flags[key], String(value)]);
  const threads = whisperCpuThreads(profile);
  if (threads !== undefined) args.push('--threads', String(threads));
  return args;
}
export function pythonDecodingOptions(profile) {
  const values = transcriptionDecodingOptions(profile);
  const faster = profile.transport === 'faster-whisper';
  const names = {
    temperature:'temperature', beamSize:'beam_size', bestOf:'best_of', noSpeechThreshold:'no_speech_threshold',
    logprobThreshold: faster ? 'log_prob_threshold' : 'logprob_threshold', compressionRatioThreshold:'compression_ratio_threshold'
  };
  const result = Object.fromEntries(Object.entries(names).flatMap(([key,name]) => values[key] === undefined ? [] : [[name, values[key]]]));
  if (faster && typeof profile.options?.vadFilter === 'boolean') result.vad_filter = profile.options.vadFilter;
  if (values.temperatureStep !== undefined) {
    const start = values.temperature ?? 0;
    result.temperature = values.temperatureStep > 0
      ? Array.from({length: Math.min(101, Math.floor((1 - start) / values.temperatureStep + 1e-8) + 1)}, (_,i) => Number((start + i * values.temperatureStep).toFixed(8)))
      : start;
  }
  return result;
}
