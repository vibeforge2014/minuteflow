import { useEffect, useState } from "react";
import { CalendarBlank, Microphone, Users, X } from "@phosphor-icons/react";
import type { CreateMeetingInput, MeetingMode } from "../types";
import { useMeetingStore } from "../store/meetingStore";

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
  onCreate(input: CreateMeetingInput): Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<MeetingMode>("online");
  const [participants, setParticipants] = useState("我");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const preferences = useMeetingStore((state) => state.preferences);
  useEffect(() => {
    if (open) setMode(preferences.defaultMode);
  }, [open, preferences.defaultMode]);
  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="dialog new-meeting-dialog"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          await onCreate({
            title: title.trim() || "未命名会议",
            mode,
            participants: participants.split(/[、,]/).map((item) => item.trim()).filter(Boolean),
            goals: goal.trim() ? [goal.trim()] : [],
            tags: []
          });
          setTitle("");
          setGoal("");
          setBusy(false);
        }}
      >
        <header>
          <div>
            <h2>新建会议</h2>
            <p>创建一份会随着讨论持续生长的会议文档。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭新建会议"><X size={18} /></button>
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
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品团队周会" />
        </label>
        <div className="field">
          <span>会议模式</span>
          <div className="segmented">
            <button type="button" className={mode === "online" ? "is-active" : ""} onClick={() => setMode("online")}>
              <Microphone size={17} />线上会议
            </button>
            <button type="button" className={mode === "offline" ? "is-active" : ""} onClick={() => setMode("offline")}>
              <Users size={17} />线下会议
            </button>
          </div>
          <small>{mode === "online" ? "同时录制麦克风和系统音频。" : "仅录制麦克风，并对现场发言人进行分离。"}</small>
        </div>
        <label className="field">
          <span>参与者</span>
          <input value={participants} onChange={(event) => setParticipants(event.target.value)} placeholder="使用逗号分隔" />
        </label>
        <label className="field">
          <span>会议目标</span>
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="这次会议希望达成什么结果？" rows={3} />
        </label>
        <footer>
          <span><CalendarBlank size={16} />默认每 {formatInterval(preferences.summaryIntervalSeconds)} 更新纪要</span>
          <div>
            <button type="button" className="button" onClick={onClose}>取消</button>
            <button className="button button--primary" disabled={busy}>{busy ? "正在创建…" : "创建会议"}</button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function formatInterval(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}
