/**
 * 录音引擎（渲染层）：封装一次会议录音的完整生命周期——
 * 权限预检、双轨采集（麦克风 + 系统/屏幕音频）、MediaRecorder 分块归档、
 * 独立 8 秒转写块轮询、实时电平表，以及「停止前等待所有音频块落盘」的安全收尾。
 * 供 hooks/useMeetingRecorder.ts 装配使用，通过 api 桥接主进程会话。
 *
 * 所属层：渲染层服务（音视频采集与转写调度）。
 * 主要导出：MeetingRecorder。
 */
import { api } from "../lib/api";
import { isMicrophonePermissionError, MICROPHONE_PERMISSION_REQUIRED, shouldRequestMicrophone } from "../lib/permissions";
import type { AudioTrackKind, Meeting, ModelProfile, TranscriptSegment, TranscriptionChunkResult } from "../types";

/** 可直接采集的轨道类型（"mixed" 仅用于已落盘的合成产物，不能采集）。 */
type CaptureTrack = Exclude<AudioTrackKind, "mixed">;

/** 录音过程中向上层（UI/hook）回调的事件集合。 */
interface RecordingCallbacks {
  /** 每帧输入电平（0-1，麦克风/系统各一路），驱动录音条波形动画。 */
  onLevel(levels: { microphone: number; system: number }): void;
  /** 收到一段定稿转录（仅非空文本才回调），会取代对应的临时段。 */
  onTranscript(segment: TranscriptSegment): void;
  /** 某个音频块已送出转写，先显示一条临时（provisional）占位段。 */
  onProvisional(segment: TranscriptSegment): void;
  /** 临时占位段应当移除（该块转写失败或返回空文本），segmentId 为空时清空全部。 */
  onProvisionalSettled(segmentId: string): void;
  /** 在途转写任务数量变化（用于 UI 显示积压指示）。 */
  onTranscriptionQueue(size: number): void;
  /** 非致命告警（如系统音频不可用、写盘失败），UI 以 Toast 呈现但不中断录音。 */
  onWarning(message: string): void;
}

/** 一条已绑定的采集轨道：流、归档录制器、块序号与在途落盘任务集合。 */
interface RecorderBinding {
  track: CaptureTrack;
  stream: MediaStream;
  archive: MediaRecorder;
  /** 归档块序号：主进程按 (track, sequence) 排序拼接，乱序会破坏音频。 */
  sequence: number;
  /** 在途的 recordings.append 任务集合；stop() 必须等它们全部落盘后才能收尾。 */
  pendingWrites: Set<Promise<void>>;
}

interface CompletedTranscription {
  provisionalId: string;
  segments: TranscriptSegment[];
}

/** 每条采集轨独立按签发序号提交，网络返回顺序不会改变段落顺序或稳定 id。 */
interface TrackTranscriptionState {
  issued: number;
  nextCommit: number;
  completed: Map<number, CompletedTranscription>;
}

/** 按优先级挑一个当前浏览器支持的编码（Chromium 优先 Opus/WebM），保证归档可被 FFmpeg 解码。 */
const supportedMimeType = () => [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4"
].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";

/** 用统一编码与码率创建录制器（归档 96kbps / 转写块 64kbps 由调用方指定）。 */
function createAudioRecorder(stream: MediaStream, audioBitsPerSecond: number) {
  const mimeType = supportedMimeType();
  return new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    audioBitsPerSecond
  });
}

/**
 * 单场会议的录音会话对象。
 * 关键设计：
 * - 归档与转写解耦：归档用长时 MediaRecorder 每 15s 落一块保证文件完整；
 *   转写用独立的短时录制器每 8s 产一个自包含块，避免切割长 WebM 导致的解码错位。
 * - 停止语义：stop() 先停录制器，再等全部在途 append 落盘，最后才调 recordings.stop 收尾，
 *   确保不会丢最后一块或留下无法保存的录音。
 */
export class MeetingRecorder {
  private meeting: Meeting;
  /** 已启用的 stt 模型档案；未配置时只归档不转写。 */
  private sttProfile: ModelProfile | undefined;
  private glossary: string[];
  private callbacks: RecordingCallbacks;
  /** 主进程录音会话 id，append/stop 都要带上。 */
  private sessionId = "";
  /** 会话开始时间戳（主进程返回），用于把块时间换算为相对会议的 startMs/endMs。 */
  private startedAt = 0;
  private bindings: RecorderBinding[] = [];
  /** 每条轨道的转写循环 Promise；stop 时等待它们退出。 */
  private transcriptionLoops: Array<Promise<void>> = [];
  private stopTranscription = false;
  private paused = false;
  private audioContext: AudioContext | null = null;
  /** 电平表 rAF 句柄，stop 时取消。 */
  private analyserFrame = 0;
  private transcriptionQueue = 0;
  /** 在途转录请求；正常停止会等待它们成功或明确失败后再持久化会议。 */
  private pendingTranscriptions = new Set<Promise<void>>();
  private transcriptionStates = new Map<CaptureTrack, TrackTranscriptionState>();
  /** 用户在启动过程中取消（start 会被 reject）。 */
  private startCancelled = false;
  /** 挂起的 getUserMedia/getDisplayMedia 的取消句柄。 */
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

  /**
   * 启动录音：权限预检 → 建主进程会话 → 采集麦克风（线上会议再叠加系统音频轨）→ 启动电平表。
   * 任何一步失败都会停止已开的轨道/录制器并 abort 会话，不留半启动状态。
   * 麦克风状态可能滞后：未显示 granted 时先请求一次，但最终以真实 getUserMedia 结果为准。
   * macOS 系统音频仍只在首run流程准备，正常录音不主动重开系统权限选择器。
   */
  async start() {
    const permissions = await api.system.getPermissions();
    if (shouldRequestMicrophone(permissions.microphone)) {
      // macOS 由主进程触发系统请求；Windows/未知状态仍会继续走 getUserMedia，
      // 让 Chromium 用实际采集结果纠正可能过期的 systemPreferences 状态。
      await api.system.requestMicrophone().catch(() => undefined);
    }
    if (this.meeting.mode === "online" && permissions.systemAudioRequired && permissions.screen !== "granted") {
      throw new Error("系统音频权限未就绪。请在系统设置中重新授权；MinuteFlow 不会在录音时弹出权限申请。");
    }
    const session = await api.recordings.start(this.meeting.id);
    this.sessionId = session.sessionId;
    this.startedAt = session.startedAt;
    try {
      let microphone: MediaStream;
      try {
        microphone = await this.requestMedia({
          audio: {
            // 线上会议开启回声消除，避免扬声器里的远端声音被麦克风重复录到。
            echoCancellation: this.meeting.mode === "online",
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        }, 30_000, "等待麦克风授权超时，请在系统设置中允许录音后重试。");
      } catch (error) {
        if (isMicrophonePermissionError(error)) {
          throw new Error(`${MICROPHONE_PERMISSION_REQUIRED} 麦克风权限未允许，请授权后重试。`);
        }
        throw error;
      }
      await this.bindStream("microphone", microphone);

      if (this.meeting.mode === "online") {
        try {
          // 屏幕采集只为了拿到系统音频轨：请求最小规格视频（部分平台强制要求视频轨）后立即禁用。
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

  /** 用户主动取消启动：标记取消、reject 挂起的授权请求，并停掉已开的轨道。 */
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

  /**
   * 给授权请求加「用户取消 + 超时」双保险：Promise.race 原始请求/取消/超时三者。
   * 输掉的那路拿到的流必须立刻 stop，防止轨道泄漏（常见于用户先取消后授权弹窗才返回）。
   */
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

  /**
   * 绑定一条采集轨道：创建 15s 分块的归档录制器，dataavailable 时把块经 IPC 追加到主进程；
   * 若配置了 stt 档案，同时为该轨道启动独立的转写循环。
   */
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
      // 归档块写入：登记到 pendingWrites，让 stop() 能等它真正落盘后再收尾。
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
      // 写完（无论成败）即从集合移除；错误已在上面回调过 onWarning。
      void write.catch(() => {}).finally(() => binding.pendingWrites.delete(write));
    });
    // 15 秒一块：兼顾落盘及时性与块数量（IPC 传输次数）。
    archive.start(15_000);
    this.bindings.push(binding);

    if (this.sttProfile) {
      this.transcriptionStates.set(track, { issued: 0, nextCommit: 0, completed: new Map() });
      this.transcriptionLoops.push(this.runTranscriptionLoop(track, stream));
    }
  }

  /**
   * 转写循环：每轮独立录一个 8 秒的自包含块，立刻送主进程转写（不落盘、用完即弃）。
   * 块送出时先经 onProvisional 显示“转写中”占位段，定稿结果到达后被合并逻辑取代；
   * 瞬时失败自动重试一次，仍失败才告警并移除占位段。
   * 暂停期间只休眠不采集；块时间戳换算为相对会议起点，供转写段落排序与播放器同步。
   */
  private async runTranscriptionLoop(track: CaptureTrack, stream: MediaStream) {
    const state = this.transcriptionStates.get(track);
    if (!state) return;
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
      const sequence = state.issued++;
      // 占位临时段：与最终段落共享时间区间与轨道，mergeTranscriptSegments 会用定稿结果替换它。
      const provisional: TranscriptSegment = {
        id: `provisional-${track}-${sequence}-${startMs}`,
        startMs,
        endMs,
        speakerId: track === "microphone" ? "me" : "remote",
        speakerName: track === "microphone" ? "我" : "远端发言人",
        text: "……",
        status: "provisional",
        track
      };
      this.callbacks.onProvisional(provisional);
      const payload = {
        profileId: this.sttProfile.id,
        data: await blob.arrayBuffer(),
        fileName: `${track}-${startMs}.${blob.type.includes("mp4") ? "m4a" : "webm"}`,
        language: "zh",
        startMs,
        endMs,
        track,
        glossary: this.glossary
      };
      // 入队在途计数 +1，UI 可显示「转写中 N」。
      this.transcriptionQueue += 1;
      this.callbacks.onTranscriptionQueue(this.transcriptionQueue);
      const request = () => api.transcription.processChunk(payload);
      const transcription = (async () => {
        let result: TranscriptionChunkResult = { segments: [] };
        try {
          result = await request();
        } catch (firstError) {
          // 瞬时故障（网络抖动/本地进程偶发失败）等 1.5 秒重试一次，仍失败才告警。
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          try {
            result = await request();
          } catch {
            this.callbacks.onWarning(firstError instanceof Error ? firstError.message : "转录任务失败");
          }
        }
        state.completed.set(sequence, {
          provisionalId: provisional.id,
          segments: result.segments.filter((segment) => segment.text.trim())
        });
        this.commitCompletedTranscriptions(track);
      })();
      this.pendingTranscriptions.add(transcription);
      void transcription.finally(() => {
        this.pendingTranscriptions.delete(transcription);
        this.transcriptionQueue = Math.max(0, this.transcriptionQueue - 1);
        this.callbacks.onTranscriptionQueue(this.transcriptionQueue);
      });
    }
  }

  /** 只提交从 nextCommit 开始的连续完成结果；较晚窗口先返回时暂存在 completed 中。 */
  private commitCompletedTranscriptions(track: CaptureTrack) {
    const state = this.transcriptionStates.get(track);
    if (!state) return;
    while (state.completed.has(state.nextCommit)) {
      const completed = state.completed.get(state.nextCommit)!;
      state.completed.delete(state.nextCommit);
      state.nextCommit += 1;
      this.callbacks.onProvisionalSettled(completed.provisionalId);
      for (const segment of completed.segments) this.callbacks.onTranscript(segment);
    }
  }

  /** 单独录一个固定时长的自包含块（起止各产生一次事件），避免切割长录制流导致的时间戳错位。 */
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

  /** 启动 rAF 电平表：每条轨接一个 AnalyserNode，按 RMS 计算输入电平（×4.5 增益后截断到 1）。 */
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

  /** 暂停：归档录制器 pause，转写循环进入休眠（轨道保持打开，快速恢复不断流）。 */
  pause() {
    this.paused = true;
    for (const binding of this.bindings) {
      if (binding.archive.state === "recording") binding.archive.pause();
    }
  }

  /** 恢复：归档录制器 resume，转写循环恢复采集。 */
  resume() {
    this.paused = false;
    for (const binding of this.bindings) {
      if (binding.archive.state === "paused") binding.archive.resume();
    }
  }

  /**
   * 放弃录音并回收资源（不产出文件）：停转写循环与电平表、等归档录制器停止、
   * 关轨道与 AudioContext，最后 recordings.abort 让主进程删除 .partial 并把会议退回草稿。
   * 供启动过程中用户取消（stop 晚于最后一次取消检查的窄竞态）时兜底使用。
   */
  async abort() {
    this.stopTranscription = true;
    cancelAnimationFrame(this.analyserFrame);
    const stops = this.bindings.map((binding) => new Promise<void>((resolve) => {
      if (binding.archive.state === "inactive") return resolve();
      binding.archive.addEventListener("stop", () => resolve(), { once: true });
      binding.archive.stop();
    }));
    await Promise.all(stops);
    for (const binding of this.bindings) {
      for (const track of binding.stream.getTracks()) track.stop();
    }
    await this.audioContext?.close().catch(() => {});
    return api.recordings.abort({
      meetingId: this.meeting.id,
      sessionId: this.sessionId
    });
  }

  /**
   * 停止录音并安全收尾。顺序是关键：
   * 停转写 → 停归档录制器 → 等全部在途 append 落盘（Promise.allSettled）→ 关轨道与 AudioContext
   * → 等转写循环退出 → 最后 recordings.stop 让主进程合并/重命名产物文件。
   * 任何提前返回都可能丢最后一块音频或留下未完成的录音。
   */
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
    await Promise.allSettled(Array.from(this.pendingTranscriptions));
    return api.recordings.stop({
      meetingId: this.meeting.id,
      sessionId: this.sessionId,
      durationSeconds
    });
  }
}
