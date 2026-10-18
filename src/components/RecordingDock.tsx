/**
 * 全局录音坞：录音期间切到别的会议时，录音条会随工作区一起消失。
 * 这里固定悬浮显示「正在录哪场」的计时与暂停/结束入口，点击可回到该会议，
 * 避免用户忘记仍在录音或误以为已经结束。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUUpLeft, Pause, Play, Stop } from "@phosphor-icons/react";
import { formatDuration } from "../lib/format";

interface RecordingDockProps {
  title: string;
  phase: "starting" | "recording" | "paused" | "stopping";
  elapsed: number;
  onOpen(): void;
  onPause(): void;
  onStop(): void;
}

export function RecordingDock({ title, phase, elapsed, onOpen, onPause, onStop }: RecordingDockProps) {
  // 与录音条一致的二段确认：误触不会直接结束一场还在进行的会议。
  const [stopArmed, setStopArmed] = useState(false);
  const stopTimer = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") setStopArmed(false);
  }, [phase]);

  useEffect(() => () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
  }, []);

  const stateLabel = phase === "starting"
    ? "正在启动录音"
    : phase === "stopping"
      ? "正在完成写盘"
      : phase === "paused"
        ? "已暂停"
        : "正在录音";

  function handleStop() {
    if (stopArmed) {
      if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
      setStopArmed(false);
      onStop();
      return;
    }
    setStopArmed(true);
    stopTimer.current = window.setTimeout(() => {
      stopTimer.current = null;
      setStopArmed(false);
    }, 3_000);
  }

  return (
    <aside className="recording-dock" aria-label="后台录音">
      <span className={`recording-dock__dot ${phase === "paused" ? "is-paused" : ""}`} aria-hidden />
      <div className="recording-dock__meta">
        <span>{stateLabel}</span>
        <strong title={title}>{title}</strong>
      </div>
      <span className="recording-dock__time">{formatDuration(elapsed)}</span>
      <div className="recording-dock__actions">
        <button type="button" className="recording-dock__open" aria-label="回到录音" title="回到正在录音的会议" onClick={onOpen}>
          <ArrowUUpLeft size={15} weight="bold" aria-hidden />
          <span>回到录音</span>
        </button>
        {(phase === "recording" || phase === "paused") && (
          <button
            type="button"
            className="icon-button"
            aria-label={phase === "paused" ? "继续录音" : "暂停录音"}
            title={phase === "paused" ? "继续录音" : "暂停录音"}
            onClick={onPause}
          >
            {phase === "paused" ? <Play size={16} weight="fill" /> : <Pause size={16} weight="fill" />}
          </button>
        )}
        <button
          type="button"
          className={`icon-button recording-dock__stop ${stopArmed ? "is-armed" : ""}`}
          aria-label={stopArmed ? "确认结束录音" : "结束录音"}
          title={stopArmed ? "再点一次确认结束" : "结束录音"}
          onClick={handleStop}
        >
          <Stop size={16} weight="fill" />
        </button>
      </div>
    </aside>
  );
}
