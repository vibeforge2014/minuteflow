/**
 * 会议音频播放器：位于会议文档上方的回放条。
 * 加载主进程提供的第一个播放资产，时间轴拖动、±15 秒跳转；
 * onTimeChange 把当前播放毫秒持续上报给工作区，驱动转写面板的「歌词式」同步高亮，
 * seekToMs 则反向接收来自转写时间戳的点击跳转。
 */
import { Pause, Play, SkipBack, SkipForward, Waveform } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export function MeetingPlayer({ meetingId, durationSeconds, seekToMs, onTimeChange }: { meetingId: string; durationSeconds: number; seekToMs: number | null; onTimeChange(ms: number): void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);

  // 会议切换时重新拉取播放资产；先清空 url 让播放器隐藏（无录音的会议不显示）。
  useEffect(() => {
    setUrl("");
    if (!meetingId) return;
    let cancelled = false;
    api.recordings.assets(meetingId).then((assets) => { if (!cancelled) setUrl(assets[0]?.url || ""); }).catch(() => {});
    return () => { cancelled = true; };
  }, [meetingId]);
  // 响应外部跳转请求（点击转写时间戳）：定位并自动播放。
  useEffect(() => { if (seekToMs !== null && audioRef.current) { audioRef.current.currentTime = seekToMs / 1000; void audioRef.current.play(); } }, [seekToMs]);
  if (!url) return null;

  /** 前进/后退指定秒数，并夹在有效时长范围内。 */
  const skip = (seconds: number) => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds)); };
  return (
    <section className="meeting-player">
      <audio ref={audioRef} src={url} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onDurationChange={(event) => setDuration(event.currentTarget.duration || durationSeconds)} onTimeUpdate={(event) => { const value = event.currentTarget.currentTime; setCurrent(value); onTimeChange(value * 1000); }} />
      <div className="meeting-player__timeline"><time>{format(current)}</time><input aria-label="录音时间轴" type="range" min="0" max={Math.max(1, duration)} step="0.1" value={current} onChange={(event) => { const value = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = value; setCurrent(value); }} /><time>{format(duration)}</time></div>
      <div className="meeting-player__controls"><span><Waveform size={16} />录音回放</span><div><button aria-label="后退 15 秒" onClick={() => skip(-15)}><SkipBack size={18} /></button><button className="meeting-player__play" aria-label={playing ? "暂停" : "播放"} onClick={() => playing ? audioRef.current?.pause() : void audioRef.current?.play()}>{playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button><button aria-label="前进 15 秒" onClick={() => skip(15)}><SkipForward size={18} /></button></div><strong>1.0×</strong></div>
    </section>
  );
}

function format(seconds: number) { const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0; return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
