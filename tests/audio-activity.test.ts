import { describe, it, expect } from 'vitest';
import { computeAudioActivity, isQuietActivity, shouldShowTranscriptionPlaceholder } from '../src/services/audio-activity';
describe('audio activity UI gate', () => {
  it('computes RMS, peak and active fraction, including empty/short input', () => {
    expect(computeAudioActivity(new Float32Array())).toEqual({rms:0,peak:0,activeRatio:0});
    const a=computeAudioActivity(new Float32Array([0,.02,-.02,0]));
    expect(a.rms).toBeCloseTo(Math.sqrt(.0002));expect(a.peak).toBeCloseTo(.02);expect(a.activeRatio).toBe(.5);
    expect(computeAudioActivity(new Float32Array([.5])).rms).toBe(.5);
  });
  it('suppresses silence/noise but preserves short peaks and quiet speech', () => {
    expect(isQuietActivity(computeAudioActivity(new Float32Array(16000).fill(.001)))).toBe(true);
    const pop=new Float32Array(16000);pop[5]=.1;expect(isQuietActivity(computeAudioActivity(pop))).toBe(false);
    expect(isQuietActivity({rms:.004,peak:.01,activeRatio:0})).toBe(false);
    expect(isQuietActivity(computeAudioActivity(new Float32Array([NaN])))).toBe(false);
  });
  it('copies the audio before decoding, checks every channel and fails open', async () => {
    const data=new ArrayBuffer(32);
    expect(await shouldShowTranscriptionPlaceholder(data,async copy=>{expect(copy).not.toBe(data);structuredClone(copy,{transfer:[copy]});return {numberOfChannels:1,getChannelData:()=>new Float32Array(200)}})).toBe(false);
    expect(data.byteLength).toBe(32);
    expect(await shouldShowTranscriptionPlaceholder(data,async()=>({numberOfChannels:2,getChannelData:c=>new Float32Array(200).fill(c ? .1 : 0)}))).toBe(true);
    expect(await shouldShowTranscriptionPlaceholder(data,async()=>{throw Error('unsupported codec')})).toBe(true);
  });
});
