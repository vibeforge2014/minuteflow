import { useEffect, useState } from "react";
import { describeSummaryRequest } from "../lib/import-status";
import type { ImportJob } from "../types";

export interface SummaryProgressState {
  startedAt: number;
  modelName?: string;
  receiving?: boolean;
  phase?: ImportJob["summaryPhase"];
}

export function SummaryProgress({ progress }: { progress: SummaryProgressState }) {
  const { startedAt, modelName, receiving, phase } = progress;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return (
    <div className="review-hero__generating">
      <span className="button-spinner" aria-hidden="true" />
      <span role="status">{describeSummaryRequest(phase, receiving)}{modelName ? ` · ${modelName}` : "…"}</span>
      <span aria-label={`已等待 ${elapsed} 秒`}>{elapsed} 秒</span>
    </div>
  );
}
