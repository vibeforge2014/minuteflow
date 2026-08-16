/**
 * 底部悬浮录音条：录音状态灯、计时、麦克风/系统双轨电平表、转录队列徽标，
 * 以及开始/暂停/继续/停止/标记/取消操作。支持折叠为迷你模式（联动主进程迷你窗）。
 * phase 状态机由 useMeetingRecorder 驱动：idle → starting → recording ⇄ paused → stopping。
 */
import { useState } from "react";
import {
  ArrowsOutSimple,
  BookmarkSimple,
  Microphone,
  Pause,
  Play,
  SpeakerHigh,
  Stop
} from "@phosphor-icons/react";
import type { Meeting } from "../types";
import { api } from "../lib/api";
import { formatDuration } from "../lib/format";

interface RecorderBarProps {
  meeting: Meeting;
  /** 录音状态机：空闲/启动中/录制中/已暂停/收尾中。 */
  phase: "idle" | "starting" | "recording" | "paused" | "stopping";
  /** 已录制秒数（录制中实时更新）。 */
  elapsed: number;
  /** 双轨实时电平（0-1）。 */
  levels: { microphone: number; system: number };
  /** 在途转写任务数。 */
  queue: number;
  onStart(): Promise<void>;
  onPause(): Promise<void>;
  onStop(): Promise<void>;
  /** 在当前播放位置打一个笔记标记。 */
  onMark(): void;
}

export function RecorderBar({
  meeting,
  phase,
  elapsed,
  levels,
  queue,
  onStart,
  onPause,
  onStop,
  onMark
}: RecorderBarProps) {
  const [mini, setMini] = useState(false);
  // live=会话进行中（含启动/收尾过渡态）；active=已实际在录（显示暂停/停止）。
  const live = ["recording", "paused", "starting", "stopping"].includes(phase);
  const active = phase === "recording" || phase === "paused";
  // 录制中显示实时计时，空闲时回退为该会议已保存的时长。
  const visualElapsed = live ? elapsed : meeting.durationSeconds;

  return (
    <div className={`recorder-bar ${mini ? "is-mini" : ""}`}>
      <div className="record-state">
        <span className={`record-dot ${live ? "is-live" : ""}`} />
        <div>
          <strong>{formatDuration(visualElapsed)}</strong>
          <span>{phase === "starting" ? "正在申请录音权限" : phase === "stopping" ? "正在完成写盘" : phase === "paused" ? "已暂停" : live ? "录制中" : meeting.status === "complete" ? "会议已结束" : "准备录音"}</span>
        </div>
      </div>

      {!mini && (
        <>
          <Level label="麦克风" icon={<Microphone size={18} />} value={levels.microphone || (meeting.status === "recording" ? 0.35 : 0)} />
          <Level label="系统声音" icon={<SpeakerHigh size={18} />} value={levels.system || (meeting.status === "recording" ? 0.28 : 0)} />
          {queue > 0 && <span className="queue-badge">转录队列 {queue}</span>}
        </>
      )}

      <div className="recorder-actions">
        {!live ? (
          <button className="record-action record-action--start" onClick={onStart}>
            <Play size={18} weight="fill" />开始
          </button>
        ) : phase === "starting" ? (
          <button className="record-action record-action--stop" onClick={onStop}>
            <Stop size={18} weight="fill" />取消
          </button>
        ) : phase === "stopping" ? (
          <button className="record-action" disabled>
            正在保存…
          </button>
        ) : active ? (
          <>
            <button className="record-action" onClick={onMark}><BookmarkSimple size={19} />标记</button>
            <button className="record-action" onClick={onPause}>
              {phase === "paused" ? <Play size={18} weight="fill" /> : <Pause size={18} weight="fill" />}
              {phase === "paused" ? "继续" : "暂停"}
            </button>
            <button className="record-action record-action--stop" onClick={onStop}>
              <Stop size={18} weight="fill" />停止
            </button>
          </>
        ) : null}
        <button
          className="icon-button recorder-mini"
          aria-label="切换迷你录音窗口"
          onClick={async () => {
            // 本地立即切换视图 + 通知主进程开/关系统级迷你窗（置顶小窗）。
            const next = !mini;
            setMini(next);
            await api.window.toggleMini(next);
          }}
        >
          <ArrowsOutSimple size={17} />
        </button>
      </div>
    </div>
  );
}

/** 单轨电平表：把 0-1 的 RMS 值点亮为 6 格中的若干格。 */
function Level({ label, icon, value }: { label: string; icon: React.ReactNode; value: number }) {
  const active = Math.round(value * 6);
  return (
    <div className="audio-level">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <div className="level-bars">
          {Array.from({ length: 6 }, (_, index) => <i key={index} className={index < active ? "is-active" : ""} />)}
        </div>
      </div>
    </div>
  );
}
