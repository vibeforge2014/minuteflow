import type { ModelProfile } from '../types';
import { transcriptionKeys, transcriptionParamCapabilities } from '../../shared/transcription-options.mjs';
export { transcriptionParamCapabilities, resolveTranscriptionLanguage, parameterRanges } from '../../shared/transcription-options.mjs';
export type TranscriptionPreset = 'default' | 'accuracy' | 'speed';
export const transcriptionPresets = [
  {id:'default', name:'默认设置', description:'平衡速度与准确率'},
  {id:'accuracy', name:'准确优先', description:'优先采用确定性解码与更宽的搜索'},
  {id:'speed', name:'速度优先', description:'缩小搜索范围，优先响应速度'}
] as const;
type Options = ModelProfile['options'];
export function applyTranscriptionPreset(options: Options, preset: TranscriptionPreset, transport: string): Options {
  const next = {...options};
  for (const key of transcriptionKeys) delete next[key];
  const supported = transcriptionParamCapabilities(transport, options);
  if (preset === 'accuracy') { if (supported.includes('beamSize')) next.beamSize = 5; if (supported.includes('temperature')) next.temperature = 0; }
  if (preset === 'speed' && supported.includes('beamSize')) next.beamSize = 1;
  return next;
}
export function identifyTranscriptionPreset(options: Options, transport: string): TranscriptionPreset | 'custom' {
  const supported = transcriptionParamCapabilities(transport, options);
  for (const preset of transcriptionPresets) {
    const candidate = applyTranscriptionPreset(options, preset.id, transport);
    if (supported.every(key => options[key] === candidate[key])) return preset.id;
  }
  return 'custom';
}
