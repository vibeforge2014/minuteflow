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
  onRestored(): Promise<void>;
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

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
