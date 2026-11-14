export interface AudioActivity { rms: number; peak: number; activeRatio: number }
export function computeAudioActivity(samples: Float32Array): AudioActivity {
  let sum = 0, peak = 0, active = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return {rms: Infinity, peak: Infinity, activeRatio: 1};
    const magnitude = Math.abs(sample);
    sum += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude > 0.01) active++;
  }
  return {rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak, activeRatio: samples.length ? active / samples.length : 0};
}
/** UI-only gate; the main process still owns transcription/silence decisions. */
export function isQuietActivity(activity: AudioActivity) {
  return activity.rms < 0.004 && activity.peak < 0.02 && activity.activeRatio < 0.01;
}
export async function shouldShowTranscriptionPlaceholder(data: ArrayBuffer, decode: (copy: ArrayBuffer) => Promise<{numberOfChannels: number; getChannelData(channel: number): Float32Array}>) {
  try {
    const audio = await decode(data.slice(0));
    if (!audio.numberOfChannels) return true;
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const samples = audio.getChannelData(channel);
      if (!samples.length || !isQuietActivity(computeAudioActivity(samples))) return true;
    }
    return false;
  } catch { return true; }
}
