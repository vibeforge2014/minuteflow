import { api } from "../lib/api";
import type { AudioTrackKind, Meeting, ModelProfile, TranscriptSegment } from "../types";

type CaptureTrack = Exclude<AudioTrackKind, "mixed">;

interface RecordingCallbacks {
  onLevel(levels: { microphone: number; system: number }): void;
  onTranscript(segment: TranscriptSegment): void;
  onTranscriptionQueue(size: number): void;
  onWarning(message: string): void;
}

interface RecorderBinding {
  track: CaptureTrack;
  stream: MediaStream;
  archive: MediaRecorder;
  sequence: number;
  pendingWrites: Set<Promise<void>>;
}

const supportedMimeType = () => [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4"
].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";

function createAudioRecorder(stream: MediaStream, audioBitsPerSecond: number) {
  const mimeType = supportedMimeType();
  return new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond
  });
}

export class MeetingRecorder {
  private meeting: Meeting;
  private sttProfile: ModelProfile | undefined;
  private glossary: string[];
  private callbacks: RecordingCallbacks;
  private sessionId = "";
  private startedAt = 0;
  private bindings: RecorderBinding[] = [];
  private transcriptionLoops: Array<Promise<void>> = [];
  private stopTranscription = false;
  private paused = false;
  private audioContext: AudioContext | null = null;
  private analyserFrame = 0;
  private transcriptionQueue = 0;
  private startCancelled = false;
  private rejectStart: ((error: Error) => void) | null = null;

  constructor(
    meeting: Meeting,
    sttProfile: ModelProfile | undefined,
    glossary: string[],
    callbacks: RecordingCallbacks
  ) {
    this.meeting = meeting;
    this.sttProfile = sttProfile;
    this.glossary = glossary;
    this.callbacks = callbacks;
  }

  async start() {
    const permissions = await api.system.getPermissions();
    if (permissions.microphone !== "granted") {
      throw new Error("麦克风权限未就绪。请在系统设置中重新授权；MinuteFlow 不会在录音时弹出权限申请。");
    }
    if (this.meeting.mode === "online" && permissions.systemAudioRequired && permissions.screen !== "granted") {
      throw new Error("系统音频权限未就绪。请在系统设置中重新授权；MinuteFlow 不会在录音时弹出权限申请。");
    }
    const session = await api.recordings.start(this.meeting.id);
    this.sessionId = session.sessionId;
    this.startedAt = session.startedAt;
    try {
      const microphone = await this.requestMedia({
        audio: {
          echoCancellation: this.meeting.mode === "online",
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      }, 30_000, "等待麦克风授权超时，请在系统设置中允许录音后重试。");
      await this.bindStream("microphone", microphone);

      if (this.meeting.mode === "online") {
        try {
          const display = await this.requestDisplayMedia({
            video: { width: { ideal: 2 }, height: { ideal: 2 }, frameRate: { ideal: 1, max: 1 } },
            audio: true
          }, 30_000);
          const audioTracks = display.getAudioTracks();
          if (audioTracks.length) {
            await this.bindStream("system", new MediaStream(audioTracks));
            for (const videoTrack of display.getVideoTracks()) videoTrack.enabled = false;
          } else {
            this.callbacks.onWarning("系统音频流为空，将继续录制麦克风。请检查系统录音权限。");
            for (const track of display.getTracks()) track.stop();
          }
        } catch (error) {
          if (this.startCancelled) throw error;
          this.callbacks.onWarning(
            error instanceof Error && error.name === "NotAllowedError"
              ? "未授权系统音频，将继续录制麦克风。"
              : "系统音频启动失败，将继续录制麦克风。"
          );
        }
      }
      if (this.startCancelled) throw new Error("录音启动已取消。");
      this.startLevelMeter();
      return session;
    } catch (error) {
      for (const binding of this.bindings) {
        if (binding.archive.state !== "inactive") binding.archive.stop();
        for (const track of binding.stream.getTracks()) track.stop();
      }
      await api.recordings.abort({
        meetingId: this.meeting.id,
        sessionId: this.sessionId
      }).catch(() => {});
      throw error;
    }
  }

  cancelStart() {
    this.startCancelled = true;
    this.rejectStart?.(new Error("录音启动已取消。"));
    for (const binding of this.bindings) {
      if (binding.archive.state !== "inactive") binding.archive.stop();
      for (const track of binding.stream.getTracks()) track.stop();
    }
  }

  private requestMedia(constraints: MediaStreamConstraints, timeoutMs: number, timeoutMessage: string) {
    return this.withStartDeadline(
      navigator.mediaDevices.getUserMedia(constraints),
      timeoutMs,
      timeoutMessage
    );
  }

  private requestDisplayMedia(constraints: DisplayMediaStreamOptions, timeoutMs: number) {
    return this.withStartDeadline(
      navigator.mediaDevices.getDisplayMedia(constraints),
      timeoutMs,
      "等待系统音频授权超时，将继续录制麦克风。"
    );
  }

  private withStartDeadline(request: Promise<MediaStream>, timeoutMs: number, timeoutMessage: string) {
    let settled = false;
    const cancellation = new Promise<MediaStream>((_resolve, reject) => {
      this.rejectStart = reject;
    });
    const timeout = new Promise<MediaStream>((_resolve, reject) => {
      window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    request.then((stream) => {
      if (settled || this.startCancelled) {
        for (const track of stream.getTracks()) track.stop();
      }
    }).catch(() => {});
    return Promise.race([request, cancellation, timeout]).then((stream) => {
      settled = true;
      this.rejectStart = null;
      if (this.startCancelled) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("录音启动已取消。");
      }
      return stream;
    }, (error) => {
      settled = true;
      this.rejectStart = null;
      throw error;
    });
  }

  private async bindStream(track: CaptureTrack, stream: MediaStream) {
    const archive = createAudioRecorder(stream, 96_000);
    const binding: RecorderBinding = {
      track,
      stream,
      archive,
      sequence: 0,
      pendingWrites: new Set()
    };
    archive.addEventListener("dataavailable", (event) => {
      if (!event.data.size) return;
      const write = (async () => {
        try {
          const data = await event.data.arrayBuffer();
          await api.recordings.append({
            meetingId: this.meeting.id,
            sessionId: this.sessionId,
            track,
            sequence: binding.sequence++,
            data,
            mimeType: event.data.type || archive.mimeType
          });
        } catch (error) {
          this.callbacks.onWarning(
            error instanceof Error ? error.message : "录音块写入失败，请检查磁盘空间。"
          );
          throw error;
        }
      })();
      binding.pendingWrites.add(write);
      void write.catch(() => {}).finally(() => binding.pendingWrites.delete(write));
    });
    archive.start(15_000);
    this.bindings.push(binding);

    if (this.sttProfile) {
      this.transcriptionLoops.push(this.runTranscriptionLoop(track, stream));
    }
  }

  private async runTranscriptionLoop(track: CaptureTrack, stream: MediaStream) {
    while (!this.stopTranscription && stream.active) {
      if (this.paused) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const chunkStarted = Date.now();
      const blob = await this.captureStandaloneChunk(stream, 8_000);
      if (!blob?.size || this.stopTranscription || !this.sttProfile?.id) continue;
      const startMs = Math.max(0, chunkStarted - this.startedAt);
      const endMs = Math.max(startMs, Date.now() - this.startedAt);
      this.transcriptionQueue += 1;
      this.callbacks.onTranscriptionQueue(this.transcriptionQueue);
      api.transcription.processChunk({
        profileId: this.sttProfile.id,
        data: await blob.arrayBuffer(),
        fileName: `${track}-${startMs}.${blob.type.includes("mp4") ? "m4a" : "webm"}`,
        language: "zh",
        startMs,
        endMs,
        track,
        glossary: this.glossary
      }).then((segment) => {
        if (segment.text.trim()) this.callbacks.onTranscript(segment);
      }).catch((error) => {
        this.callbacks.onWarning(error instanceof Error ? error.message : "转录任务失败");
      }).finally(() => {
        this.transcriptionQueue = Math.max(0, this.transcriptionQueue - 1);
        this.callbacks.onTranscriptionQueue(this.transcriptionQueue);
      });
    }
  }

  private captureStandaloneChunk(stream: MediaStream, duration: number) {
    return new Promise<Blob | null>((resolve) => {
      if (this.stopTranscription || !stream.active) return resolve(null);
      const chunks: BlobPart[] = [];
      const recorder = createAudioRecorder(stream, 64_000);
      let timeout = 0;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        window.clearTimeout(timeout);
        resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null);
      }, { once: true });
      recorder.start();
      timeout = window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, duration);
    });
  }

  private startLevelMeter() {
    this.audioContext = new AudioContext();
    const analysers = new Map<CaptureTrack, AnalyserNode>();
    for (const binding of this.bindings) {
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 512;
      this.audioContext.createMediaStreamSource(binding.stream).connect(analyser);
      analysers.set(binding.track, analyser);
    }
    const sample = () => {
      const levels = { microphone: 0, system: 0 };
      for (const [track, analyser] of analysers.entries()) {
        const values = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(values);
        const rms = Math.sqrt(values.reduce((sum, value) => {
          const centered = (value - 128) / 128;
          return sum + centered * centered;
        }, 0) / values.length);
        levels[track] = Math.min(1, rms * 4.5);
      }
      this.callbacks.onLevel(levels);
      this.analyserFrame = requestAnimationFrame(sample);
    };
    sample();
  }

  pause() {
    this.paused = true;
    for (const binding of this.bindings) {
      if (binding.archive.state === "recording") binding.archive.pause();
    }
  }

  resume() {
    this.paused = false;
    for (const binding of this.bindings) {
      if (binding.archive.state === "paused") binding.archive.resume();
    }
  }

  async stop(durationSeconds: number) {
    this.stopTranscription = true;
    cancelAnimationFrame(this.analyserFrame);
    const stops = this.bindings.map((binding) => new Promise<void>((resolve) => {
      if (binding.archive.state === "inactive") return resolve();
      binding.archive.addEventListener("stop", () => resolve(), { once: true });
      binding.archive.stop();
    }));
    await Promise.all(stops);
    await Promise.allSettled(this.bindings.flatMap((binding) => Array.from(binding.pendingWrites)));
    for (const binding of this.bindings) {
      for (const track of binding.stream.getTracks()) track.stop();
    }
    await this.audioContext?.close().catch(() => {});
    await Promise.allSettled(this.transcriptionLoops);
    return api.recordings.stop({
      meetingId: this.meeting.id,
      sessionId: this.sessionId,
      durationSeconds
    });
  }
}
