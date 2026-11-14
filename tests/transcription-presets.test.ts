import { describe, expect, it } from 'vitest';
import { applyTranscriptionPreset, identifyTranscriptionPreset, resolveTranscriptionLanguage, transcriptionParamCapabilities } from '../src/lib/transcription-presets';
import { pythonDecodingOptions, transcriptionDecodingOptions, whisperCliDecodingArgs } from '../shared/transcription-options.mjs';
describe('transcription presets and pipeline',()=>{
  it('applies concrete values, recognizes manual edits, and preserves unrelated settings',()=>{
    const source={timeoutMs:400000,initialPrompt:'术语',temperature:.5};
    const accuracy=applyTranscriptionPreset(source,'accuracy','whisper-python');
    expect(accuracy).toEqual({timeoutMs:400000,temperature:0,beamSize:5});
    expect(identifyTranscriptionPreset(accuracy,'whisper-python')).toBe('accuracy');
    expect(identifyTranscriptionPreset({...accuracy,transcriptionLanguage:'en'},'whisper-python')).toBe('custom');
    expect(applyTranscriptionPreset(accuracy,'default','whisper-python')).toEqual({timeoutMs:400000});
    expect(applyTranscriptionPreset({},'speed','faster-whisper')).toEqual({beamSize:1});
  });
  it('exposes only each engine supported parameters',()=>{
    for(const transport of ['openai-audio','mlx-whisper']) expect(transcriptionParamCapabilities(transport)).toEqual(['transcriptionLanguage','initialPrompt','temperature']);
    expect(transcriptionParamCapabilities('whisper-cpp')).not.toContain('entropyThreshold');
    expect(transcriptionParamCapabilities('whisper-cpp',{executablePath:'/whisper'})).toContain('entropyThreshold');
    expect(transcriptionParamCapabilities('whisper-python')).toContain('temperatureStep');
    expect(transcriptionParamCapabilities('faster-whisper')).not.toContain('temperatureStep');
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
  });
  it('builds Python engine-specific decoding dictionaries and bounded fallback temperatures',()=>{
    expect(pythonDecodingOptions({transport:'whisper-python',options:{temperature:0,temperatureStep:.2,beamSize:5,logprobThreshold:-1}})).toEqual({temperature:[0,.2,.4,.6,.8,1],beam_size:5,logprob_threshold:-1});
    expect(pythonDecodingOptions({transport:'faster-whisper',options:{temperature:0,temperatureStep:.2,beamSize:1}})).toEqual({temperature:0,beam_size:1});
  });
});
