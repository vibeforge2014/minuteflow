/**
 * 全局录音坞：录音期间切到别的会议时，录音条会随工作区一起消失。
 * 这里固定悬浮显示「正在录哪场」的计时与暂停/结束入口，点击可回到该会议，
 * 避免用户忘记仍在录音或误以为已经结束。
 */
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
  const stateLabel = phase === "starting"
    ? "正在启动录音"
    : phase === "stopping"
      ? "正在完成写盘"
      : phase === "paused"
        ? "已暂停"
        : "正在录音";

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
        {/* 与录音条一致的单步停止：内容始终已保存，误触可经停止后的「继续录音」无损恢复。 */}
        <button
          type="button"
          className="icon-button recording-dock__stop"
          aria-label="结束录音"
          title="结束录音"
          onClick={onStop}
        >
          <Stop size={16} weight="fill" />
        </button>
      </div>
    </aside>
  );
}
