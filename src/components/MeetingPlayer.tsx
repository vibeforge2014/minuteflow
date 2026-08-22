/**
 * 会议音频播放器：位于会议文档上方的回放条。
 * 加载主进程提供的第一个播放资产，时间轴拖动、±15 秒跳转；
 * onTimeChange 把当前播放毫秒持续上报给工作区，驱动转写面板的「歌词式」同步高亮，
 * seekToMs 则反向接收来自转写时间戳的点击跳转。
 * 回放易用性：倍速循环切换（会话内记忆，切会议不重置）与空格/左右方向键操作。
 */
import { Pause, Play, SkipBack, SkipForward, Waveform, X } from "@phosphor-icons/react";
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
  onError(message: string): void;
}

export function MeetingPlayer({ meetingId, durationSeconds, seekToMs, open, onClose, onAvailabilityChange, onTimeChange, onError }: MeetingPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);
  const [rate, setRate] = useState(rememberedPlaybackRate);
  const [mediaError, setMediaError] = useState<string | null>(null);

  // 会议切换时重新拉取播放资产；先清空 url 让播放器隐藏（无录音的会议不显示）。
  useEffect(() => {
    setUrl("");
    setPlaying(false);
    setCurrent(0);
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
  }, [meetingId, onAvailabilityChange]);

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
    audioRef.current.currentTime = seekToMs / 1000;
    void audioRef.current.play().catch(() => onError("无法播放这段录音，请确认音频文件仍然可用。"));
  }, [seekToMs, onError]);

  /** 前进/后退指定秒数，并夹在有效时长范围内。 */
  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    audio.currentTime = Math.max(0, Math.min(total, audio.currentTime + seconds));
    setCurrent(audio.currentTime);
  }, [duration]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) return audio.pause();
    setMediaError(null);
    try {
      await audio.play();
    } catch {
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

  if (!url || !open) return null;

  return (
    <section className="meeting-player">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); onClose(); }}
        onError={() => {
          const message = "这段录音无法读取，播放器已停止。";
          setMediaError(message);
          onError(message);
        }}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onTimeUpdate={(event) => { const value = event.currentTarget.currentTime; setCurrent(value); onTimeChange(value * 1000); }}
      />
      <div className="meeting-player__timeline"><time>{format(current)}</time><input aria-label="录音时间轴" type="range" min="0" max={Math.max(1, duration)} step="0.1" value={current} onChange={(event) => { const value = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = value; setCurrent(value); }} /><time>{format(duration)}</time></div>
      <div className="meeting-player__controls"><span><Waveform size={16} />录音回放</span><div><button aria-label="后退 15 秒" onClick={() => skip(-15)}><SkipBack size={18} /></button><button className="meeting-player__play" aria-label={playing ? "暂停" : "播放"} onClick={() => void togglePlayback()}>{playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button><button aria-label="前进 15 秒" onClick={() => skip(15)}><SkipForward size={18} /></button></div><div className="meeting-player__trailing"><button className="meeting-player__rate" aria-label="切换播放倍速" title="播放倍速（循环切换）" onClick={() => setRate(PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length] ?? 1)}>{formatRate(rate)}</button><button className="meeting-player__close" aria-label="收起录音回放" onClick={() => { audioRef.current?.pause(); onClose(); }}><X size={16} /></button></div></div>
      {mediaError && <p className="meeting-player__error">{mediaError}</p>}
    </section>
  );
}

/** 倍速显示：整数档不带小数（1x、2x、3x），小数档保留两位内（0.75x、1.25x）。 */
function formatRate(rate: number) {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0$/, "")}x`;
}

function format(seconds: number) { const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0; return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
