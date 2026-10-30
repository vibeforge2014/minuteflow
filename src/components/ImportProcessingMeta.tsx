/**
 * 导入任务进度条 + 副标题：说话人分离这类长阶段没有百分比回调，
 * 因此用“阶段 + 真实已用时间”持续刷新，而不是让进度条停在 73% 不动。
 */
import { useEffect, useState } from "react";
import type { ImportJob } from "../types";
import {
  describeImportProgressDetail,
  importProgressFraction
} from "../lib/import-status";

export function ImportProcessingMeta({ job, compact = false, showDetail = true, queuePosition }: {
  job: ImportJob;
  compact?: boolean;
  /** 调用方已经单独展示错误原因时可关闭副标题，避免重复。 */
  showDetail?: boolean;
  /** 排队中的顺位（1 开始）：让“等待处理”不再是没有任何反馈的静止状态。 */
  queuePosition?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  // 仅分离阶段需要每秒重绘（已用时间）；其它阶段由任务推送驱动即可。
  useEffect(() => {
    if (job.status !== "diarizing" || !job.diarizationStartedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job.status, job.diarizationStartedAt]);

  const fraction = importProgressFraction(job);
  const detail = job.status === "queued" && queuePosition
    ? `排队第 ${queuePosition} 位`
    : describeImportProgressDetail(job, now);
  // 排队与说话人分离都没有细粒度百分比：用流动进度条表示“仍在推进”。
  const indeterminate = job.status === "diarizing" || job.status === "queued";
  return (
    <div className={`import-processing-meta ${compact ? "is-compact" : ""}`}>
      <div
        className={`import-progress ${indeterminate ? "is-indeterminate" : ""} ${job.status === "failed" ? "is-failed" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(fraction * 100)}
        aria-valuetext={detail || undefined}
      >
        <i style={{ width: `${Math.max(3, fraction * 100)}%` }} />
      </div>
      {detail && showDetail && <small className="import-processing-meta__detail">{detail}</small>}
    </div>
  );
}
