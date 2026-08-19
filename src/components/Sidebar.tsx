/**
 * 会议库侧栏（工作区左栏）：品牌、新建入口、搜索框、按时间分组的会议列表，
 * 以及底部辅助功能（导入录音/会议模板/最近删除/设置）。
 * 列表数据来自 Zustand store 的 meetings，搜索词也存于 store 以便 ⌘K 全局聚焦。
 */
import { useMemo } from "react";
import {
  FileArrowUp,
  GearSix,
  MagnifyingGlass,
  Plus,
  Trash,
  X
} from "@phosphor-icons/react";
import type { Meeting } from "../types";
import { useMeetingStore } from "../store/meetingStore";
import { formatDuration } from "../lib/format";
import { BrandMark } from "./BrandMark";

interface SidebarProps {
  meetings: Meeting[];
  selectedId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onImport(): void;
  /** 进行中的导入任务数（导入按钮角标）。 */
  importCount?: number;
  onTrash(): void;
  onSettings(): void;
}

export function Sidebar({ meetings, selectedId, onSelect, onNew, onImport, importCount = 0, onTrash, onSettings }: SidebarProps) {
  const search = useMeetingStore((state) => state.search);
  const setSearch = useMeetingStore((state) => state.setSearch);
  // 按开会时间距今天数分组（今天/本周/更早），meetings 变化时才重算。
  const groups = useMemo(() => groupMeetings(meetings), [meetings]);
  const searching = search.trim().length > 0;

  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark className="brand__mark" size={25} />
        <span>MinuteFlow</span>
      </div>

      <button className="new-meeting" onClick={onNew}>
        <Plus size={18} weight="bold" />
        新建会议
      </button>

      <label className="search-box">
        <MagnifyingGlass size={17} />
        <input
          id="meeting-search"
          value={search}
          placeholder="搜索会议或内容"
          onChange={(event) => setSearch(event.target.value)}
        />
        {searching ? (
          <button
            type="button"
            className="search-clear"
            aria-label="清除搜索"
            onClick={() => void setSearch("")}
          >
            <X size={13} weight="bold" />
          </button>
        ) : (
          <kbd>⌘ K</kbd>
        )}
      </label>

      <div className="meeting-groups">
        {groups.map((group) => (
          <section key={group.label} className="meeting-group">
            <h2>{group.label}</h2>
            {group.meetings.map((meeting) => (
              <button
                key={meeting.id}
                className={`meeting-row ${selectedId === meeting.id ? "is-selected" : ""}`}
                onClick={() => onSelect(meeting.id)}
              >
                <span className="meeting-row__title">
                  {meeting.status === "recording" && <i />}
                  {meeting.title}
                </span>
                <span className="meeting-row__meta">
                  {formatDate(meeting.scheduledAt)}
                  {meeting.status === "recording" ? (
                    <strong>进行中</strong>
                  ) : (
                    <span>{formatDuration(meeting.durationSeconds)}</span>
                  )}
                </span>
              </button>
            ))}
          </section>
        ))}
        {searching && !groups.length && (
          <div className="sidebar-empty">
            <p>没有找到与「{search.trim()}」匹配的会议</p>
            <button onClick={() => void setSearch("")}>清除搜索，查看全部会议</button>
          </div>
        )}
      </div>

      <nav className="sidebar-actions" aria-label="辅助功能">
        <button onClick={onImport}><FileArrowUp size={18} />导入录音{importCount > 0 && <span className="sidebar-task-count">{importCount}</span>}</button>
        <button onClick={onTrash}><Trash size={18} />最近删除</button>
        <button onClick={onSettings}><GearSix size={18} />设置</button>
      </nav>
    </aside>
  );
}

/** 按距今天数把会议分到 今天（<1天）/ 本周（<7天）/ 更早 三组，空组不显示。 */
function groupMeetings(meetings: Meeting[]) {
  const groups = [
    { label: "今天", meetings: [] as Meeting[] },
    { label: "本周", meetings: [] as Meeting[] },
    { label: "更早", meetings: [] as Meeting[] }
  ];
  const anchor = Date.now();
  for (const meeting of meetings) {
    const difference = (anchor - new Date(meeting.scheduledAt).getTime()) / 86_400_000;
    if (difference < 1) groups[0].meetings.push(meeting);
    else if (difference < 7) groups[1].meetings.push(meeting);
    else groups[2].meetings.push(meeting);
  }
  return groups.filter((group) => group.meetings.length);
}

/** 侧栏行内日期显示：MM-DD HH:mm。 */
function formatDate(value: string) {
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
