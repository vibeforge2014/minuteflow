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

interface RecorderBarProps {
  meeting: Meeting;
  phase: "idle" | "starting" | "recording" | "paused" | "stopping";
  elapsed: number;
  levels: { microphone: number; system: number };
  queue: number;
  onStart(): Promise<void>;
  onPause(): Promise<void>;
  onStop(): Promise<void>;
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
  const live = ["recording", "paused", "starting", "stopping"].includes(phase);
  const active = phase === "recording" || phase === "paused";
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

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}
