/**
 * 最近删除对话框：列出软删除的会议（deletedAt 非空），支持一键恢复回会议库。
 * 软删除保证录音文件与转写不丢失；数据清理策略由主进程按保留天数偏好执行。
 */
import { ArrowCounterClockwise, Trash, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Meeting } from "../types";

export function DeletedMeetingsDialog({
  open,
  onClose,
  onRestored
}: {
  open: boolean;
  onClose(): void;
  /** 恢复成功后刷新会议库列表。 */
  onRestored(): Promise<void>;
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  /** 正在恢复中的会议 id（按钮防重）。 */
  const [busyId, setBusyId] = useState<string | null>(null);

  // 每次打开时拉取含已删除标记的会议，过滤出软删除项。
  useEffect(() => {
    if (!open) return;
    api.meetings.list("", true).then((items) => {
      setMeetings(items.filter((meeting) => Boolean(meeting.deletedAt)));
    });
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog deleted-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deleted-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__header">
          <div>
            <h2 id="deleted-title">最近删除</h2>
            <p>会议采用软删除，可随时恢复到会议库。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="deleted-list">
          {meetings.length ? meetings.map((meeting) => (
            <article key={meeting.id}>
              <div>
                <strong>{meeting.title}</strong>
                <span>{new Date(meeting.scheduledAt).toLocaleString("zh-CN")}</span>
              </div>
              <button
                className="button button--secondary button--small"
                disabled={busyId === meeting.id}
                onClick={async () => {
                  setBusyId(meeting.id);
                  await api.meetings.restore(meeting.id);
                  setMeetings((items) => items.filter((item) => item.id !== meeting.id));
                  await onRestored();
                  setBusyId(null);
                }}
              >
                <ArrowCounterClockwise size={15} />
                {busyId === meeting.id ? "恢复中" : "恢复"}
              </button>
            </article>
          )) : (
            <div className="deleted-empty">
              <Trash size={25} weight="duotone" />
              <p>最近删除中没有会议。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
