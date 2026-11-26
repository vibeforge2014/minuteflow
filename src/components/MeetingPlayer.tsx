/**
 * 会议音频播放器：位于会议文档上方的回放条。
 * 加载主进程提供的第一个播放资产，支持自定义进度条拖动、悬停时间预览、±15 秒跳转；
 * onTimeChange 把当前播放毫秒持续上报给工作区，驱动转写面板的「歌词式」同步高亮，
 * seekToMs 则反向接收来自转写时间戳的点击跳转。
 * 回放易用性：倍速循环切换（会话内记忆，切会议不重置）与空格/左右方向键操作。
 */
import { ArrowClockwise, ArrowCounterClockwise, Pause, Play, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/** 倍速档位：点击循环切换；选中的档位在本次会话内记忆（模块级变量，组件重挂载不丢）。 */
const PLAYBACK_RATES: number[] = [0.75, 1, 1.25, 1.5, 2, 3];
let rememberedPlaybackRate = 1;

interface MeetingPlayerProps {
  meetingId: string;
  durationSeconds: number;
  seekToMs: number | null;
  open: boolean;
  onClose(): void;
  onAvailabilityChange(available: boolean): void;
  onTimeChange(ms: number): void;
  onPlayingChange(playing: boolean): void;
  onError(message: string): void;
}

export function MeetingPlayer({
  meetingId,
  durationSeconds,
  seekToMs,
  open,
  onClose,
  onAvailabilityChange,
  onTimeChange,
  onPlayingChange,
  onError
}: MeetingPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);
  const [rate, setRate] = useState(rememberedPlaybackRate);
  const [rateTick, setRateTick] = useState(0);
  const [skipPulse, setSkipPulse] = useState<"back" | "forward" | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{ ratio: number; seconds: number } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    onPlayingChange(open && playing);
  }, [open, playing, onPlayingChange]);
  useEffect(() => () => {
    onPlayingChange(false);
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
  }, [onPlayingChange]);

  // 收起播放器时同步暂停，避免收起后声音仍在后台播放。
  useEffect(() => {
    if (!open && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [open]);

  // 会议切换时重新拉取播放资产；先清空 url 让播放器隐藏（无录音的会议不显示）。
  useEffect(() => {
    setUrl("");
    setPlaying(false);
    setCurrent(0);
    setDuration(durationSeconds);
    setMediaError(null);
    onAvailabilityChange(false);
    if (!meetingId) return;
    let cancelled = false;
    api.recordings.assets(meetingId).then((assets) => {
      if (cancelled) return;
      const asset = assets.find((item) => item.track === "mixed") ?? assets[0];
      setUrl(asset?.url || "");
      onAvailabilityChange(Boolean(asset));
    }).catch(() => onAvailabilityChange(false));
    return () => { cancelled = true; };
  }, [meetingId, durationSeconds, onAvailabilityChange]);

  // 倍速应用到媒体元素并记忆；同时写 defaultPlaybackRate，避免换源/重新加载后回退到 1x。
  useEffect(() => {
    rememberedPlaybackRate = rate;
    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
    }
  }, [rate, url]);

  // 响应外部跳转请求（点击转写时间戳）：定位并自动播放。
  useEffect(() => {
    if (seekToMs === null || !audioRef.current) return;
    const targetSec = Math.max(0, seekToMs / 1000);
    audioRef.current.currentTime = targetSec;
    setCurrent(targetSec);
    void audioRef.current.play().catch((error) => {
      if (error?.name !== "AbortError") onError("无法播放这段录音，请确认音频文件仍然可用。");
    });
  }, [seekToMs, onError]);

  const triggerSkipPulse = useCallback((direction: "back" | "forward") => {
    setSkipPulse(null);
    if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
    // 下一帧再写入方向，确保连续快速点按每次都能重播微动效。
    requestAnimationFrame(() => {
      setSkipPulse(direction);
      pulseTimerRef.current = window.setTimeout(() => setSkipPulse(null), 280);
    });
  }, []);

  /** 前进/后退指定秒数，并夹在有效时长范围内。 */
  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    const next = Math.max(0, Math.min(total, audio.currentTime + seconds));
    audio.currentTime = next;
    setCurrent(next);
    onTimeChange(next * 1000);
    triggerSkipPulse(seconds < 0 ? "back" : "forward");
  }, [duration, onTimeChange, triggerSkipPulse]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) return audio.pause();
    setMediaError(null);
    try {
      await audio.play();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = "录音加载失败，请检查文件是否完整或重新导入。";
      setMediaError(message);
      onError(message);
    }
  }, [onError]);

  // 回放条打开时的键盘操作：空格播放/暂停、左右方向键 ±15 秒（与按钮一致）。
  // 焦点在输入框/编辑器时不拦截，避免抢占笔记与搜索的按键。
  useEffect(() => {
    if (!url || !open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        skip(-15);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        skip(15);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, skip, togglePlayback, url]);

  if (!url) return null;

  const safeDuration = Math.max(1, duration);
  const progress = Math.max(0, Math.min(1, current / safeDuration));
  const tabIndex = open ? 0 : -1;

  return (
    <div className={`meeting-player-shell ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div className="meeting-player-shell__inner">
        <section
          className={`meeting-player ${playing ? "is-playing" : ""} ${scrubbing ? "is-scrubbing" : ""}`}
          aria-label="录音回放"
        >
          <audio
            ref={audioRef}
            src={url}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => { setPlaying(false); onClose(); }}
            onError={() => {
              setPlaying(false);
              const message = "这段录音无法读取，播放器已停止。";
              setMediaError(message);
              onError(message);
            }}
            onLoadedMetadata={(event) => {
              const value = event.currentTarget.duration;
              if (Number.isFinite(value) && value > 0) setDuration(value);
            }}
            onTimeUpdate={(event) => {
              if (scrubbing) return;
              const value = event.currentTarget.currentTime;
              setCurrent(value);
              onTimeChange(value * 1000);
            }}
          />

          <div className="meeting-player__bar">
            <div className="meeting-player__transport">
              <button
                type="button"
                tabIndex={tabIndex}
                className={`meeting-player__skip ${skipPulse === "back" ? "is-pulsing-back" : ""}`}
                aria-label="后退 15 秒"
                title="后退 15 秒（←）"
                onClick={() => skip(-15)}
              >
                <ArrowCounterClockwise size={17} weight="bold" />
                <span>15</span>
              </button>

              <button
                type="button"
                tabIndex={tabIndex}
                className={`meeting-player__play ${playing ? "is-playing" : ""}`}
                aria-label={playing ? "暂停" : "播放"}
                title={playing ? "暂停（空格）" : "播放（空格）"}
                onClick={() => void togglePlayback()}
              >
                <span className="meeting-player__play-icon" key={playing ? "pause" : "play"}>
                  {playing ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
                </span>
              </button>

              <button
                type="button"
                tabIndex={tabIndex}
                className={`meeting-player__skip ${skipPulse === "forward" ? "is-pulsing-forward" : ""}`}
                aria-label="前进 15 秒"
                title="前进 15 秒（→）"
                onClick={() => skip(15)}
              >
                <ArrowClockwise size={17} weight="bold" />
                <span>15</span>
              </button>
            </div>

            <div className="meeting-player__timeline">
              <span className="meeting-player__eq" aria-hidden="true">
                <i /><i /><i />
              </span>
              <time className="meeting-player__time meeting-player__time--current">{format(current, safeDuration >= 3600)}</time>

              <div
                className="meeting-player__scrubber"
                style={{ ["--player-progress" as string]: `${(progress * 100).toFixed(3)}%` }}
                onMouseMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (rect.width <= 0) return;
                  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                  setHoverPreview({ ratio, seconds: ratio * safeDuration });
                }}
                onMouseLeave={() => setHoverPreview(null)}
              >
                <div className="meeting-player__track" aria-hidden="true">
                  <div className="meeting-player__fill" />
                  <span className="meeting-player__thumb" />
                </div>
                {hoverPreview && (
                  <span
                    className="meeting-player__tooltip"
                    style={{ left: `${(hoverPreview.ratio * 100).toFixed(2)}%` }}
                    aria-hidden="true"
                  >
                    {format(hoverPreview.seconds, safeDuration >= 3600)}
                  </span>
                )}
                <input
                  tabIndex={tabIndex}
                  aria-label="录音时间轴"
                  type="range"
                  min="0"
                  max={safeDuration}
                  step="0.1"
                  value={Math.min(current, safeDuration)}
                  onPointerDown={() => setScrubbing(true)}
                  onPointerUp={() => setScrubbing(false)}
                  onPointerCancel={() => setScrubbing(false)}
                  onBlur={() => setScrubbing(false)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (audioRef.current) audioRef.current.currentTime = value;
                    setCurrent(value);
                    onTimeChange(value * 1000);
                  }}
                />
              </div>

              <time className="meeting-player__time meeting-player__time--total">{format(duration, safeDuration >= 3600)}</time>
            </div>

            <div className="meeting-player__trailing">
              <button
                type="button"
                tabIndex={tabIndex}
                className={`meeting-player__rate ${rate !== 1 ? "is-boosted" : ""}`}
                aria-label="切换播放倍速"
                title="播放倍速（循环切换）"
                onClick={() => {
                  setRate(PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length] ?? 1);
                  setRateTick((tick) => tick + 1);
                }}
              >
                <span key={rateTick}>{formatRate(rate)}</span>
              </button>
              <span className="meeting-player__divider" aria-hidden="true" />
              <button
                type="button"
                tabIndex={tabIndex}
                className="meeting-player__close"
                aria-label="收起录音回放"
                title="收起录音回放"
                onClick={() => { audioRef.current?.pause(); onClose(); }}
              >
                <X size={14} weight="bold" />
              </button>
            </div>
          </div>

          {mediaError && <p className="meeting-player__error">{mediaError}</p>}
        </section>
      </div>
    </div>
  );
}

/** 倍速显示：整数档不带小数（1x、2x、3x），小数档保留两位内（0.75x、1.25x）。 */
function formatRate(rate: number) {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0$/, "")}x`;
}

function format(seconds: number, showHours = false) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hrs = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (showHours || hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
