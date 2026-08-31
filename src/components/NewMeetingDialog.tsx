/**
 * 新建会议对话框：模板选择、标题、线上/线下模式、参与者与会议目标。
 * 模式决定录音采集策略（线上=麦克风+系统音频，线下=仅麦克风）；
 * 目标会作为 AI 总结的提示输入。创建后由 App 立即选中并可直接开始录音。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarBlank, CaretDown, Microphone, Users, WarningCircle, X } from "@phosphor-icons/react";
import type { CreateMeetingInput, MeetingMode } from "../types";
import { useMeetingStore } from "../store/meetingStore";
import { useDialogFocus } from "../hooks/useDialogFocus";

/** 内置会议模板：选择后预填标题与目标。 */
const templates = {
  blank: { title: "", goal: "" },
  weekly: { title: "团队周会", goal: "对齐本周进展、风险、决策和行动项" },
  retro: { title: "项目复盘", goal: "总结做得好的、需要改进的和下一步行动" },
  interview: { title: "用户访谈", goal: "理解用户场景、痛点和真实需求" },
  oneOnOne: { title: "一对一沟通", goal: "同步近况、反馈、成长目标和需要的支持" }
};

export function NewMeetingDialog({
  open,
  onClose,
  onCreate
}: {
  open: boolean;
  onClose(): void;
  /** options.startRecording=true 时创建后立即开始录音（一键开会）。 */
  onCreate(input: CreateMeetingInput, options?: { startRecording?: boolean }): Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<MeetingMode>("online");
  const [participants, setParticipants] = useState("我");
  const [goal, setGoal] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 创建失败的行内错误：保留弹窗与用户已填内容，方便直接重试。
  const [error, setError] = useState<string | null>(null);
  // 「创建并开始录音」按钮在提交前置位；表单隐式提交（输入框回车）走默认的「仅创建」。
  const startRecordingRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const preferences = useMeetingStore((state) => state.preferences);
  // 每次打开时把默认模式同步为用户偏好（可再手动切换）。
  useEffect(() => {
    if (open) {
      setMode(preferences.defaultMode);
      setDetailsOpen(false);
    }
  }, [open, preferences.defaultMode]);
  const handleEscape = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);
  const dialogRef = useDialogFocus<HTMLFormElement>(open, {
    initialFocus: "[data-dialog-initial-focus]",
    onEscape: handleEscape
  });
  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form
        ref={dialogRef}
        className="dialog new-meeting-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-meeting-title"
        onKeyDown={(event) => {
          // 桌面 WebView 对隐式表单提交的处理并不完全一致；统一把 Enter 明确映射为
          // “先创建会议”。文本域保留换行，主按钮仍通过 click 单独开启录音。
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          if ((event.target as HTMLElement).tagName === "TEXTAREA") return;
          event.preventDefault();
          startRecordingRef.current = false;
          event.currentTarget.requestSubmit();
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const startRecording = startRecordingRef.current;
          startRecordingRef.current = false;
          setBusy(true);
          setError(null);
          try {
            await onCreate({
              title: title.trim() || "未命名会议",
              mode,
              participants: participants.split(/[、,]/).map((item) => item.trim()).filter(Boolean),
              goals: goal.trim() ? [goal.trim()] : [],
              tags: []
            }, { startRecording });
            setTitle("");
            setGoal("");
          } catch (submitError) {
            // 失败时保持弹窗打开并就地展示原因；busy 必须复位，否则按钮会永久卡在“正在创建…”。
            setError(submitError instanceof Error ? submitError.message : "创建会议失败，请重试。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <div>
            <h2 id="new-meeting-title">新建会议</h2>
            <p>创建一份会随着讨论持续生长的会议文档。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭新建会议" disabled={busy}><X size={18} /></button>
        </header>
        <label className="field">
          <span>会议模板</span>
          <select
            defaultValue="blank"
            onChange={(event) => {
              const template = templates[event.target.value as keyof typeof templates];
              setTitle(template.title);
              setGoal(template.goal);
            }}
          >
            <option value="blank">空白会议</option>
            <option value="weekly">团队周会</option>
            <option value="retro">项目复盘</option>
            <option value="interview">用户访谈</option>
            <option value="oneOnOne">一对一沟通</option>
          </select>
        </label>
        <label className="field">
          <span>会议标题</span>
          <input data-dialog-initial-focus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品团队周会" />
        </label>
        <div className="field">
          <span>会议模式</span>
          <div className="segmented">
            <button type="button" aria-pressed={mode === "online"} className={mode === "online" ? "is-active" : ""} onClick={() => setMode("online")}>
              <Microphone size={17} />线上会议
            </button>
            <button type="button" aria-pressed={mode === "offline"} className={mode === "offline" ? "is-active" : ""} onClick={() => setMode("offline")}>
              <Users size={17} />线下会议
            </button>
          </div>
          <small>{mode === "online" ? "同时录制麦克风和系统音频。" : "仅录制麦克风，并对现场发言人进行分离。"}</small>
        </div>
        <button
          type="button"
          className={`meeting-details-toggle ${detailsOpen ? "is-open" : ""}`}
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((value) => !value)}
        >
          <span>
            <strong>补充会议信息</strong>
            <small>{goal.trim() ? "已填写会议目标" : "参与者与目标，可稍后再补充"}</small>
          </span>
          <CaretDown size={16} />
        </button>
        {detailsOpen && (
          <div className="meeting-details-fields">
            <label className="field">
              <span>参与者</span>
              <input value={participants} onChange={(event) => setParticipants(event.target.value)} placeholder="使用逗号分隔" />
            </label>
            <label className="field">
              <span>会议目标</span>
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="这次会议希望达成什么结果？" rows={3} />
            </label>
          </div>
        )}
        {error && <p className="dialog-error" role="alert"><WarningCircle size={14} weight="fill" />{error}</p>}
        <footer>
          <span><CalendarBlank size={16} />回车仅创建会议 · 每 {formatInterval(preferences.summaryIntervalSeconds)} 更新纪要</span>
          <div>
            <button type="button" className="text-button dialog-cancel" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="text-button new-meeting-create-only" disabled={busy}>创建会议</button>
            <button
              type="submit"
              className="button button--primary"
              disabled={busy}
              onClick={() => { startRecordingRef.current = true; }}
              title="创建会议并立即申请麦克风权限开始录音"
            >
              {busy ? "正在创建…" : "创建并开始录音"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

/** 偏好里的滚动纪要间隔（秒）→ 可读文案。 */
function formatInterval(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}
