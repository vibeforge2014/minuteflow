/**
 * 底部悬浮录音条：录音状态灯、计时、麦克风/系统双轨电平表、转录队列徽标，
 * 以及开始/暂停/继续/停止/标记/取消操作。支持折叠为迷你模式（联动主进程迷你窗）。
 * phase 状态机由 useMeetingRecorder 驱动：idle → starting → recording ⇄ paused → stopping。
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowsOutSimple,
  BookmarkSimple,
  CaretDown,
  CheckCircle,
  Gear,
  Microphone,
  Pause,
  Play,
  SpeakerHigh,
  Stop,
  WarningCircle
} from "@phosphor-icons/react";
import type { Meeting, ModelProfile } from "../types";
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
  /** 本次会议是否配置了可用的实时转写档案。 */
  transcriptionReady: boolean;
  /** 已保存的转写档案（智谱式多可用：全部可勾选）。 */
  sttProfiles: ModelProfile[];
  /** 本场实际使用的转写档案（勾选 > 默认档 > 第一条可用）：id 用于菜单勾选态，名用于徽标。 */
  activeSttProfileId?: string;
  activeSttProfileName?: string;
  /** 任务开启时勾选转写模型；录音中切换从下一个 8 秒块生效。 */
  onSelectSttProfile(profileId: string): void;
  /** 打开设置 → 转录（未配置/异常时的去设置入口）。 */
  onManageTranscription(): void;
  /** 实时转写连续失败：徽标转为「转写异常 · 去修复」，点击直达本地 Whisper 配置。 */
  transcriptionFailed?: boolean;
  onFixTranscription?(): void;
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
  transcriptionReady,
  sttProfiles,
  activeSttProfileId,
  activeSttProfileName,
  onSelectSttProfile,
  onManageTranscription,
  transcriptionFailed = false,
  onFixTranscription,
  onStart,
  onPause,
  onStop,
  onMark
}: RecorderBarProps) {
  const [mini, setMini] = useState(false);
  // 麦克风静音检测：真实电平持续 6 秒为 0 时提示“未检测到声音”，
  // 让“麦克风被静音/选错设备”在录音中就能被发现，而不是录完才发现空音频。
  const [silentMic, setSilentMic] = useState(false);
  const lastSoundAt = useRef(Date.now());
  // live=会话进行中（含启动/收尾过渡态）；active=已实际在录（显示暂停/停止）。
  const live = ["recording", "paused", "starting", "stopping"].includes(phase);
  const active = phase === "recording" || phase === "paused";
  // 录制中显示实时计时，空闲时回退为该会议已保存的时长。
  const visualElapsed = live ? elapsed : meeting.durationSeconds;

  // 记录最后一次“听到声音”的时刻（真实电平 > 阈值才算）。
  useEffect(() => {
    if (levels.microphone > 0.01) lastSoundAt.current = Date.now();
  }, [levels.microphone]);

  // 录制中每秒检查一次静音时长；非录制态（含暂停）不提示。
  useEffect(() => {
    if (phase !== "recording") {
      setSilentMic(false);
      return;
    }
    lastSoundAt.current = Date.now();
    const timer = window.setInterval(() => {
      setSilentMic(Date.now() - lastSoundAt.current > 6_000);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  return (
    <div className={`recorder-bar ${mini ? "is-mini" : ""}`}>
      <div className="record-state" aria-live="polite">
        <span className={`record-dot ${live ? "is-live" : ""}`} />
        <div>
          <strong>{formatDuration(visualElapsed)}</strong>
          <span>
            {silentMic && phase === "recording"
              ? "未检测到麦克风声音"
              : phase === "starting" ? "正在申请录音权限" : phase === "stopping" ? "正在完成写盘" : phase === "paused" ? "已暂停" : live ? "录制中" : meeting.status === "complete" ? "会议已结束" : "准备录音"}
          </span>
        </div>
      </div>

      {!mini && (
        <>
          <Level label="麦克风" icon={<Microphone size={18} />} value={levels.microphone} />
          {meeting.mode === "online" && <Level label="系统声音" icon={<SpeakerHigh size={18} />} value={levels.system} />}
          {transcriptionFailed && transcriptionReady ? (
            <button
              type="button"
              className="transcription-status is-error"
              aria-live="polite"
              title="实时转写连续失败，点击改用本地 Whisper 或检查本地模型"
              onClick={onFixTranscription}
            >
              <WarningCircle size={14} weight="fill" />
              转写异常 · 去修复
            </button>
          ) : sttProfiles.length > 0 ? (
            <SttModelPicker
              profiles={sttProfiles}
              activeId={activeSttProfileId}
              activeName={activeSttProfileName}
              queue={queue}
              recording={phase === "recording"}
              onSelect={onSelectSttProfile}
              onManage={onManageTranscription}
            />
          ) : (
            <button
              type="button"
              className="transcription-status is-limited"
              aria-live="polite"
              title="配置转写模型后，录音的同时生成逐字稿"
              onClick={onManageTranscription}
            >
              <WarningCircle size={14} weight="fill" />
              未配置转写 · 去设置
            </button>
          )}
          {silentMic && (
            <span className="recorder-warning" role="alert">
              <WarningCircle size={14} weight="fill" />未检测到麦克风声音，请检查输入设备
            </span>
          )}
        </>
      )}

      <div className="recorder-actions">
        {!live ? (
          <button className="record-action record-action--start" onClick={onStart}>
            <Play size={18} weight="fill" />开始录音
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
            {/* 停止是单步操作：音频/转录始终已自动保存，误触可在停止后的
                「继续录音」提示里一键无损恢复，无需二次确认打断收尾时刻。 */}
            <button className="record-action record-action--stop" onClick={() => void onStop()}>
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

/** 转写模型勾选器：智谱式多可用语义——开启任务（录音）时直接勾选具体模型，
 *  勾选即本场生效（录音中切换从下一个 8 秒块开始），默认档用于一键快速录音。 */
function SttModelPicker({
  profiles,
  activeId,
  activeName,
  queue,
  recording,
  onSelect,
  onManage
}: {
  profiles: ModelProfile[];
  activeId?: string;
  activeName?: string;
  queue: number;
  recording: boolean;
  onSelect(profileId: string): void;
  onManage(): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="stt-picker" ref={rootRef}>
      <button
        type="button"
        className={`transcription-status is-ready stt-picker__trigger ${open ? "is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-live="polite"
        title="勾选本场录音使用的转写模型"
        onClick={() => setOpen((value) => !value)}
      >
        <CheckCircle size={14} weight="fill" />
        {activeName ? `转写 · ${activeName}` : "选择转写模型"}
        {queue > 0 && <em className="stt-picker__queue">{queue}</em>}
        <CaretDown size={12} weight="bold" />
      </button>
      {open && (
        <div className="stt-picker__menu" role="menu" aria-label="选择转写模型">
          {recording && (
            <small className="stt-picker__hint">切换从下一个 8 秒音频块生效，无需停止录音</small>
          )}
          {profiles.map((profile) => (
            <button
              key={profile.id}
              role="menuitemradio"
              aria-checked={profile.id === activeId}
              className="stt-picker__option"
              onClick={() => {
                onSelect(profile.id!);
                setOpen(false);
              }}
            >
              <span className="stt-picker__name">
                {profile.name}
                {profile.isDefault && <em>默认</em>}
              </span>
              <small>{[profile.model, TRANSPORT_HINTS[profile.transport]].filter(Boolean).join(" · ")}</small>
              {profile.id === activeId && <CheckCircle size={15} weight="fill" />}
            </button>
          ))}
          <button role="menuitem" className="stt-picker__option stt-picker__option--manage" onClick={() => { setOpen(false); onManage(); }}>
            <Gear size={15} />管理转写服务…
          </button>
        </div>
      )}
    </div>
  );
}

const TRANSPORT_HINTS: Partial<Record<ModelProfile["transport"], string>> = {
  "apple-speech": "macOS 内置",
  "openai-audio": "在线服务",
  "whisper-cpp": "whisper.cpp",
  "whisper-python": "Python Whisper",
  "faster-whisper": "CTranslate2",
  "mlx-whisper": "MLX"
};

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
