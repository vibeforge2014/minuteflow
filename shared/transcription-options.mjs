/** Per-profile transcription settings shared by renderer and main process. */
export const decodingKeys = ['temperature', 'temperatureStep', 'beamSize', 'noSpeechThreshold', 'logprobThreshold', 'entropyThreshold'];
export const transcriptionKeys = ['transcriptionLanguage', 'initialPrompt', ...decodingKeys];
export const parameterRanges = {
  temperature: [0, 1, 0.1], temperatureStep: [0, 1, 0.1], beamSize: [1, 8, 1],
  noSpeechThreshold: [0, 1, 0.05], logprobThreshold: [-2, 0, 0.1], entropyThreshold: [0, 5, 0.1]
};
export function transcriptionParamCapabilities(transport, options = {}) {
  const base = ['transcriptionLanguage'];
  if (transport === 'parakeet-tdt') return [];
  if (['sense-voice', 'qwen3-asr', 'apple-speech'].includes(transport)) return base;
  if (!['openai-audio', 'whisper-cpp', 'whisper-python', 'faster-whisper', 'mlx-whisper'].includes(transport)) return [];
  const common = [...base, 'initialPrompt', 'temperature'];
  if (transport === 'whisper-cpp' && options.executablePath) return [...base, 'initialPrompt', ...decodingKeys];
  if (transport === 'whisper-cpp') return [...common, 'temperatureStep'];
  if (transport === 'whisper-python') return [...common, 'temperatureStep', 'beamSize', 'noSpeechThreshold', 'logprobThreshold'];
  if (transport === 'faster-whisper') return [...common, 'beamSize', 'noSpeechThreshold', 'logprobThreshold'];
  return common;
}
export function resolveTranscriptionLanguage(explicit, options = {}, globalLanguage = 'zh') {
  return explicit || options.transcriptionLanguage || globalLanguage || 'zh';
}
/** Ignore unsupported/invalid persisted values rather than sending unknown engine arguments. */
export function transcriptionDecodingOptions(profile) {
  const supported = transcriptionParamCapabilities(profile.transport, profile.options);
  return Object.fromEntries(decodingKeys.flatMap(key => {
    const value = profile.options?.[key];
    const [min, max] = parameterRanges[key];
    return supported.includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (key !== 'beamSize' || Number.isInteger(value)) ? [[key, value]] : [];
  }));
}
export function whisperCliDecodingArgs(profile) {
  const flags = {temperature:'--temperature',temperatureStep:'--temperature-inc',beamSize:'--beam-size',noSpeechThreshold:'--no-speech-thold',logprobThreshold:'--logprob-thold',entropyThreshold:'--entropy-thold'};
  return Object.entries(transcriptionDecodingOptions(profile)).flatMap(([key,value]) => [flags[key], String(value)]);
}
export function pythonDecodingOptions(profile) {
  const values = transcriptionDecodingOptions(profile);
  const names = {temperature:'temperature',beamSize:'beam_size',noSpeechThreshold:'no_speech_threshold',logprobThreshold:'logprob_threshold'};
  const result = Object.fromEntries(Object.entries(names).flatMap(([key,name]) => values[key] === undefined ? [] : [[name, values[key]]]));
  if (values.temperatureStep !== undefined) {
    const start = values.temperature ?? 0;
    result.temperature = values.temperatureStep > 0
      ? Array.from({length: Math.min(101, Math.floor((1 - start) / values.temperatureStep + 1e-8) + 1)}, (_,i) => Number((start + i * values.temperatureStep).toFixed(8)))
      : start;
  }
  return result;
}
