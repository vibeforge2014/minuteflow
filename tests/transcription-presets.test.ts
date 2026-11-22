import { describe, expect, it } from 'vitest';
import { applyTranscriptionPreset, availableTranscriptionPresets, identifyTranscriptionPreset, resolveTranscriptionLanguage, switchTranscriptionModel, transcriptionParamCapabilities } from '../src/lib/transcription-presets';
import type { ModelProfile } from '../src/types';
import { pythonDecodingOptions, transcriptionDecodingOptions, whisperCliDecodingArgs, whisperCpuThreads } from '../shared/transcription-options.mjs';
describe('transcription presets and pipeline',()=>{
  it('applies and resets decode values while retaining model language and prompt',()=>{
    const source={timeoutMs:400000,initialPrompt:'术语',temperature:.5,usePreviousText:false};
    const accuracy=applyTranscriptionPreset(source,'accuracy','whisper-python');
    expect(accuracy).toEqual({timeoutMs:400000,initialPrompt:'术语',temperature:0,beamSize:5,usePreviousText:false});
    expect(identifyTranscriptionPreset(accuracy,'whisper-python')).toBe('accuracy');
    expect(identifyTranscriptionPreset({...accuracy,transcriptionLanguage:'en'},'whisper-python')).toBe('accuracy');
    expect(identifyTranscriptionPreset({...accuracy,temperature:0.4},'whisper-python')).toBe('custom');
    expect(applyTranscriptionPreset(accuracy,'default','whisper-python')).toEqual({timeoutMs:400000,initialPrompt:'术语',usePreviousText:false});
    expect(applyTranscriptionPreset({},'speed','faster-whisper')).toEqual({beamSize:1});
  });
  it('offers decode presets only when the engine supports their parameters', () => {
    expect(availableTranscriptionPresets('sense-voice', {})).toEqual([]);
    expect(availableTranscriptionPresets('whisper-cpp', {}).map(({ name }) => name)).toEqual(['引擎默认', '低温解码']);
    expect(availableTranscriptionPresets('whisper-cpp', { executablePath: '/whisper' }).map(({ name }) => name))
      .toEqual(['引擎默认', '准确优先', '速度优先']);
    expect(applyTranscriptionPreset({ temperature: 0.4 }, 'speed', 'whisper-cpp')).toEqual({ temperature: 0.4 });
  });
  it('isolates local model file settings inside one service, including saved data from older versions', () => {
    const base: ModelProfile = {
      id: 'whisper', name: 'Whisper', kind: 'stt', transport: 'whisper-cpp', model: 'base', baseUrl: '', enabled: true,
      options: { modelPath: '/models/base.bin', transcriptionLanguage: 'en', initialPrompt: 'local terms', temperature: 0, cpuThreads: 3, bestOf: 2, usePreviousText: false, computeMode: 'gpu' }
    };
    const small = switchTranscriptionModel(base, { transport: 'whisper-cpp', model: 'small' }, '/models/small.bin');
    expect(small.options).toMatchObject({ modelPath: '/models/small.bin', computeMode: 'gpu' });
    expect(small.options).not.toHaveProperty('transcriptionLanguage');
    expect(small.options).not.toHaveProperty('temperature');
    expect(small.options).not.toHaveProperty('cpuThreads');
    expect(small.options).not.toHaveProperty('usePreviousText');
    small.options.transcriptionLanguage = 'zh';
    small.options.temperature = 0.4;
    const restoredBase = switchTranscriptionModel(JSON.parse(JSON.stringify(small)), base, '/models/base.bin');
    expect(restoredBase.options).toMatchObject({ transcriptionLanguage: 'en', initialPrompt: 'local terms', temperature: 0, cpuThreads: 3, bestOf: 2, usePreviousText: false });
    const restoredSmall = switchTranscriptionModel(restoredBase, small, '/models/small.bin');
    expect(restoredSmall.options).toMatchObject({ transcriptionLanguage: 'zh', temperature: 0.4 });
    expect(restoredSmall.options).not.toHaveProperty('initialPrompt');
    expect(base.options.temperature).toBe(0);
  });
  it('isolates online model settings and restores them after editing the model name through an empty input', () => {
    const online: ModelProfile = {
      name: 'Online', kind: 'stt', transport: 'openai-audio', model: 'first', baseUrl: 'https://example.com', enabled: true,
      options: { timeoutMs: 400000, transcriptionLanguage: 'auto', initialPrompt: 'terms' }
    };
    const blank = switchTranscriptionModel(online, { transport: 'openai-audio', model: '' });
    const second = switchTranscriptionModel(blank, { transport: 'openai-audio', model: 'second' });
    expect(second.options).not.toHaveProperty('initialPrompt');
    expect(second.options.timeoutMs).toBe(400000);
    expect(switchTranscriptionModel(second, online).options).toMatchObject({ transcriptionLanguage: 'auto', initialPrompt: 'terms' });
    expect(switchTranscriptionModel({ ...online, model: '' }, online).options).toMatchObject(online.options);
  });
  it('exposes only each engine supported parameters',()=>{
    expect(transcriptionParamCapabilities('openai-audio')).toEqual(['transcriptionLanguage','initialPrompt','temperature','usePreviousText']);
    expect(transcriptionParamCapabilities('mlx-whisper')).toContain('compressionRatioThreshold');
    expect(transcriptionParamCapabilities('mlx-whisper')).not.toContain('beamSize');
    expect(transcriptionParamCapabilities('whisper-cpp')).not.toContain('entropyThreshold');
    expect(transcriptionParamCapabilities('whisper-cpp',{executablePath:'/whisper'})).toContain('entropyThreshold');
    expect(transcriptionParamCapabilities('whisper-python')).toContain('temperatureStep');
    expect(transcriptionParamCapabilities('faster-whisper')).toContain('temperatureStep');
    expect(transcriptionParamCapabilities('faster-whisper')).toContain('vadFilter');
    expect(transcriptionParamCapabilities('whisper-cpp')).toContain('cpuThreads');
    for(const transport of ['sense-voice','qwen3-asr','apple-speech']) expect(transcriptionParamCapabilities(transport)).toEqual(['transcriptionLanguage']);
    expect(transcriptionParamCapabilities('parakeet-tdt')).toEqual([]);
  });
  it('resolves task > model > global, preserving explicit auto',()=>{
    expect(resolveTranscriptionLanguage('auto',{transcriptionLanguage:'en'},'zh')).toBe('auto');
    expect(resolveTranscriptionLanguage('',{transcriptionLanguage:'en'},'zh')).toBe('en');
    expect(resolveTranscriptionLanguage('',{},'zh')).toBe('zh');
  });
  it('passes zero values, rejects invalid values and emits official CLI flags',()=>{
    const profile={transport:'whisper-cpp',options:{executablePath:'/whisper',temperature:0,temperatureStep:.2,beamSize:5,noSpeechThreshold:0,logprobThreshold:-1,entropyThreshold:2.4}};
    expect(whisperCliDecodingArgs(profile)).toEqual(['--temperature','0','--temperature-inc','0.2','--beam-size','5','--no-speech-thold','0','--logprob-thold','-1','--entropy-thold','2.4']);
    expect(transcriptionDecodingOptions({transport:'openai-audio',options:{beamSize:5,temperature:0}})).toEqual({temperature:0});
    expect(transcriptionDecodingOptions({transport:'whisper-python',options:{beamSize:1.5,temperature:Infinity}})).toEqual({});
    expect(transcriptionDecodingOptions({transport:'whisper-cpp',options:{bestOf:9}})).toEqual({});
    expect(whisperCpuThreads({transport:'whisper-cpp',options:{cpuThreads:2.5}})).toBeUndefined();
  });
  it('builds Python engine-specific decoding dictionaries and bounded fallback temperatures',()=>{
    expect(pythonDecodingOptions({transport:'whisper-python',options:{temperature:0,temperatureStep:.2,beamSize:5,logprobThreshold:-1}})).toEqual({temperature:[0,.2,.4,.6,.8,1],beam_size:5,logprob_threshold:-1});
    expect(pythonDecodingOptions({transport:'faster-whisper',options:{temperature:0,temperatureStep:.2,beamSize:1,logprobThreshold:-1,vadFilter:false}}))
      .toEqual({temperature:[0,.2,.4,.6,.8,1],beam_size:1,log_prob_threshold:-1,vad_filter:false});
  });
});
