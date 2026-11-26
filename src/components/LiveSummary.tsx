import { useState } from "react";
import { SummaryProgress, type SummaryProgressState } from "./SummaryProgress";
import { ArrowClockwise, PencilSimple, X } from "@phosphor-icons/react";
import type { ImportJob, Meeting, ModelProfile } from "../types";
import { hasUnassignedImportSpeakers, isActiveImportJob } from "../lib/import-status";
import { MinutesOverview, MinutesSections, MinutesSource, type MinutesSourceJump } from "./MinutesSections";

interface LiveSummaryProps {
  meeting: Meeting;
  recording: boolean;
  importJob?: ImportJob;
  busy: boolean;
  progress: SummaryProgressState | null;
  onRefresh(): void;
  onCancel(): void;
  onPauseImport(id: string): void;
  onEdit(): void;
  onConfigureSummary(): void;
  summaryProfiles: ModelProfile[];
  onRetryImport(id: string, llmProfileId?: string): Promise<void>;
  onJumpToSource: MinutesSourceJump;
}

export function LiveSummary({ meeting, recording, importJob, busy, progress, onRefresh, onCancel, onPauseImport, onEdit, onConfigureSummary, summaryProfiles, onRetryImport, onJumpToSource }: LiveSummaryProps) {
  const { summary } = meeting;
  const details = [
    { title: "已确认决策", items: summary.decisions },
    { title: "未决问题", items: summary.openQuestions },
    { title: "风险", items: summary.risks },
    { title: "下一步", items: summary.nextSteps }
  ].filter(({ items }) => items.length > 0);
  const hasSummary = Boolean(summary.overview || summary.discussionSections?.length)
    || summary.keyPoints.length > 0 || summary.actionItems.length > 0 || details.length > 0;
  const hasSource = meeting.notes.some((note) => note.trim())
    || meeting.transcript.some((segment) => segment.status === "final" && segment.text.trim());
  const importPending = isActiveImportJob(importJob);
  const speakersUnassigned = hasUnassignedImportSpeakers(importJob);
  const generating = busy || importJob?.status === "summarizing";
  const importStartedAt = importJob?.status === "summarizing"
    ? Date.parse(importJob.summaryStartedAt ?? importJob.updatedAt) : NaN;
  const activeProgress = Number.isFinite(importStartedAt)
    ? { startedAt: importStartedAt, modelName: importJob?.summaryModelName ?? summaryProfiles.find((profile) => profile.id === importJob?.llmProfileId)?.model, receiving: importJob?.summaryReceiving, phase: importJob?.summaryPhase }
    : progress;
  const hasSummaryModel = summaryProfiles.some(
    (profile) => profile.kind === "llm" && profile.enabled !== false && profile.transport !== "local-summary"
  );
  const needsSummaryModel = importJob?.status === "waiting_for_summary_model"
    || (importJob?.status === "transcribing" && importJob.autoSummarize !== false && !hasSummaryModel);
  const canRetrySummary = importJob?.stage === "summarizing"
    && (importJob.status === "failed" || importJob.status === "cancelled");
  const status = generating ? "正在总结…" : !hasSummary ? undefined
    : summary.generationMode === "local" ? importPending ? "本机纪要预览" : "本机基础纪要"
    : summary.generationMode === "online" ? "AI 纪要" : undefined;

  return (
    <section className="live-summary" aria-labelledby="live-summary-title" aria-busy={generating}>
      <header className="live-summary__header">
        <h2 id="live-summary-title">{recording ? "实时总结" : "AI 纪要"}</h2>
        <div className="live-summary__actions">
          {importJob?.status === "summarizing" ? (
            <button className="text-button" onClick={() => onPauseImport(importJob.id)} title="暂停后可继续生成纪要">
              <X size={14} />暂停处理
            </button>
          ) : busy ? (
            <button className="text-button" onClick={onCancel} aria-label="取消总结"><X size={14} />取消</button>
          ) : needsSummaryModel ? (
            <button className="text-button" onClick={onConfigureSummary}>配置总结模型</button>
          ) : !importPending && !canRetrySummary ? (
            <button className="text-button" onClick={onRefresh} disabled={!hasSource || importPending} aria-label={`${hasSummary ? "更新" : "生成"}${recording ? "实时总结" : "纪要"}`}>
              <ArrowClockwise size={14} />{hasSummary ? "更新" : "生成"}
            </button>
          ) : null}
          <button className="icon-button" onClick={onEdit} aria-label="编辑纪要" title="编辑纪要"><PencilSimple size={16} /></button>
        </div>
      </header>

      <div className="live-summary__scroll">
        {activeProgress && <SummaryProgress progress={activeProgress} />}
        {needsSummaryModel && (
          <p className="live-summary__status" role="status">
            {importJob?.status === "transcribing"
              ? "配置 AI 总结模型后，即可在转写同时实时生成纪要。"
              : "转写已保存，配置总结模型后自动生成。"}
          </p>
        )}
        {canRetrySummary && importJob && <SummaryRetry key={importJob.id} job={importJob} profiles={summaryProfiles}
          onRetry={onRetryImport} onConfigure={onConfigureSummary} />}
        {!activeProgress && (status || (hasSummary && summary.stale)) && (
          <p className="live-summary__status" role="status">
            {[status, hasSummary && summary.stale && !generating ? "待更新" : undefined].filter(Boolean).join(" · ")}
          </p>
        )}
        {summary.overview && <MinutesOverview text={summary.overview} />}
        {!hasSummary && !generating && !needsSummaryModel && !canRetrySummary && (
          <p className="live-summary__empty">{recording
            ? hasSource ? "已有会议内容，等待总结…" : "等待转写…"
            : importJob?.autoSummarize === false ? "自动生成已关闭"
            : importJob?.status === "diarizing" ? "识别发言人后生成纪要"
            : importJob?.status === "transcribing" ? "已边转写边生成纪要，正在整理新增内容"
            : importPending ? "正在阶段性生成纪要"
            : importJob?.status === "waiting_for_model" ? "等待配置转写模型"
            : importJob?.status === "waiting_for_network" ? "等待转写服务恢复"
            : importJob?.status === "waiting_for_audio_tool" ? "等待音频组件恢复"
            : importJob?.status === "failed" ? importJob.error || "导入处理失败"
            : importJob?.status === "cancelled" ? "导入处理已暂停"
            : "暂无纪要"}</p>
        )}
        {hasSummary && summary.topics.length > 0 && (
          <ul className="live-summary__topics" aria-label="讨论主题">
            {summary.topics.map((topic, index) => <li key={index}>{topic}</li>)}
          </ul>
        )}
        {summary.keyPoints.length > 0 && (
          <section className="live-summary__conclusions" aria-label="关键结论">
            <h3>关键结论</h3>
            <ul className="live-summary__points">
              {summary.keyPoints.map((point, index) => (
                <li key={index}>
                  {summary.keyPointHeadlines?.[index] && <strong>{summary.keyPointHeadlines[index]}</strong>}
                  <p>{point}</p>
                  <MinutesSource ms={summary.keyPointTimes?.[index]} onJump={onJumpToSource} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {!recording && (
          <MinutesSections sections={summary.discussionSections} transcript={meeting.transcript} onJump={onJumpToSource} />
        )}
        {summary.actionItems.length > 0 && (
          <section className="live-summary__detail">
            <h3>行动项</h3>
            <ul>
              {summary.actionItems.map((item) => {
                const owner = speakersUnassigned && item.owner === "发言人1" ? "" : item.owner;
                const source = meeting.transcript.find((segment) => segment.status === "final" && item.evidenceSegmentIds?.includes(segment.id));
                return (
                  <li key={item.id}>
                    <span>{item.title}</span>
                    <div className="live-summary__action-meta">
                      <small>{owner && owner !== "待确认" ? owner : "负责人待确认"} · {item.dueDate && item.dueDate !== "待确认" ? item.dueDate : "期限待确认"}</small>
                      <MinutesSource ms={source?.startMs} segmentId={source?.id} onJump={onJumpToSource} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {details.map(({ title, items }) => (
          <section key={title} className="live-summary__detail">
            <h3>{title}</h3>
            <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function SummaryRetry({ job, profiles, onRetry, onConfigure }: {
  job: ImportJob;
  profiles: ModelProfile[];
  onRetry(id: string, llmProfileId?: string): Promise<void>;
  onConfigure(): void;
}) {
  const [retrying, setRetrying] = useState(false);
  const available = profiles.filter((profile) => profile.kind === "llm" && profile.enabled !== false
    && profile.transport !== "local-summary" && profile.id);
  const previous = available.find((profile) => profile.id === job.llmProfileId);
  const preferred = available.find((profile) => profile.isDefault) ?? previous ?? available[0];
  return (
    <div className="live-summary__retry">
      <p className="live-summary__status" role="status">{job.error || "纪要生成已暂停。"}{(job.summaryModelName || previous?.model) && ` 上次使用 ${job.summaryModelName || previous?.model}。`}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (retrying) return;
        const selected = new FormData(event.currentTarget).get("summary-model");
        setRetrying(true);
        void onRetry(job.id, typeof selected === "string" && selected ? selected : undefined)
          .finally(() => setRetrying(false));
      }}>
        {available.length > 1 && <select name="summary-model" aria-label="重试用的总结模型" defaultValue="" disabled={retrying}>
          <option value="">{preferred?.isDefault ? "当前默认" : "推荐重试"} · {preferred?.model || preferred?.name}</option>
          {available.filter((profile) => profile.id !== preferred?.id)
            .map((profile) => <option key={profile.id} value={profile.id}>{profile.model || profile.name}</option>)}
        </select>}
        <button className="button button--small" type="submit" disabled={retrying || !preferred}>重试生成</button>
        <button className="text-button" type="button" onClick={onConfigure}>总结设置</button>
      </form>
    </div>
  );
}
