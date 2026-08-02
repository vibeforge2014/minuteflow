import { useMemo } from "react";
import {
  CalendarBlank,
  FileArrowUp,
  GearSix,
  MagnifyingGlass,
  Plus,
  Trash
} from "@phosphor-icons/react";
import type { Meeting } from "../types";
import { useMeetingStore } from "../store/meetingStore";
import { BrandMark } from "./BrandMark";

interface SidebarProps {
  meetings: Meeting[];
  selectedId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onImport(): void;
  onTemplates(): void;
  onTrash(): void;
  onSettings(): void;
}

export function Sidebar({ meetings, selectedId, onSelect, onNew, onImport, onTemplates, onTrash, onSettings }: SidebarProps) {
  const search = useMeetingStore((state) => state.search);
  const setSearch = useMeetingStore((state) => state.setSearch);
  const groups = useMemo(() => groupMeetings(meetings), [meetings]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark className="brand__mark" size={25} />
        <span>会议助手</span>
      </div>

      <button className="new-meeting" onClick={onNew}>
        <Plus size={18} weight="bold" />
        新建会议
      </button>

      <label className="search-box">
        <MagnifyingGlass size={17} />
        <input
          value={search}
          placeholder="搜索会议或内容"
          onChange={(event) => setSearch(event.target.value)}
        />
        <kbd>⌘ K</kbd>
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
      </div>

      <nav className="sidebar-actions" aria-label="辅助功能">
        <button onClick={onImport}><FileArrowUp size={18} />导入录音</button>
        <button onClick={onTemplates}><CalendarBlank size={18} />会议模板</button>
        <button onClick={onTrash}><Trash size={18} />最近删除</button>
        <button onClick={onSettings}><GearSix size={18} />设置</button>
      </nav>
    </aside>
  );
}

function groupMeetings(meetings: Meeting[]) {
  const groups = [
    { label: "今天", meetings: [] as Meeting[] },
    { label: "本周", meetings: [] as Meeting[] },
    { label: "更早", meetings: [] as Meeting[] }
  ];
  const anchor = new Date("2026-07-30T12:00:00+08:00").getTime();
  for (const meeting of meetings) {
    const difference = (anchor - new Date(meeting.scheduledAt).getTime()) / 86_400_000;
    if (difference < 1) groups[0].meetings.push(meeting);
    else if (difference < 7) groups[1].meetings.push(meeting);
    else groups[2].meetings.push(meeting);
  }
  return groups.filter((group) => group.meetings.length);
}

function formatDate(value: string) {
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
