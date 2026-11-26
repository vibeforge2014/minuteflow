import { useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle } from "@phosphor-icons/react";
import { api, isElectronRuntime } from "../lib/api";
import type { MeetingSummary, ModelProfile, TranscriptSegment } from "../types";

const exampleTranscript: TranscriptSegment[] = [
  { id: "sample-1", startMs: 0, endMs: 4500, speakerId: "xiaolin", speakerName: "小林", text: "这周先邀请 10 位用户试用新版预约流程，通过试用反馈再决定是否全量上线。", status: "final", track: "microphone" },
  { id: "sample-2", startMs: 4500, endMs: 9500, speakerId: "xiaoyu", speakerName: "小余", text: "我周四下班前整理试用反馈，周五会上一起决定上线时间。", status: "final", track: "microphone" }
];

const exampleSummary: MeetingSummary = {
  topics: [], keyPoints: [], openQuestions: [], risks: [], nextSteps: [],
  overview: "团队将邀请 10 位用户试用新版预约流程，周五根据反馈决定上线时间。",
  decisions: ["先小范围试用，再决定是否全量上线。"],
  actionItems: [{ id: "sample-action", title: "整理试用反馈", owner: "小余", dueDate: "周四下班前", status: "todo", done: false }]
};

export function OnboardingSummarySample({ profile, canGenerate, onConfigure }: {
  profile: ModelProfile;
  canGenerate: boolean;
  onConfigure(): void;
}) {
  const runModel = isElectronRuntime && canGenerate && Boolean(profile.id);
  const [sample, setSample] = useState<MeetingSummary | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [receiving, setReceiving] = useState(false);

  useEffect(() => {
    if (!runModel) return;
    const meetingId = `onboarding-sample-${crypto.randomUUID()}`;
    let current = true;
    let pending = true;
    void api.summary.generate({
      meetingId,
      profileId: profile.id,
      final: true,
      input: {
        title: "新版预约流程试用",
        participants: ["小林", "小余"],
        goals: [], notes: [], transcript: exampleTranscript,
        previousSummary: { topics: [], keyPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [] }
      }
    }, () => { if (current) setReceiving(true); }).then(
      (result) => { if (current) setSample(result); },
      (failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : "生成示例失败，请重试。"); }
    ).finally(() => { pending = false; });
    return () => {
      current = false;
      if (pending) void api.summary.cancel(meetingId).catch(() => {});
    };
  }, [runModel, profile.id, attempt]);

  const output = runModel ? sample : exampleSummary;
  const conclusions = output?.decisions.length ? output.decisions : output?.keyPoints;
  return <section className="onboarding-model-step onboarding-sample" aria-label="AI 纪要示例">
    <div className="onboarding-model-status is-ready" role="status">
      <CheckCircle size={21} weight="fill" />
      <div><strong>{profile.model || profile.name} 已保存</strong><small>{runModel ? "仅使用下方示例转写" : isElectronRuntime ? "示例展示 · 激活后可试生成" : "浏览器示例 · 未调用模型"}</small></div>
      <button type="button" className="button" onClick={onConfigure}>更改配置</button>
    </div>
    <details className="onboarding-sample__input">
      <summary>查看示例转写</summary>
      {exampleTranscript.map((segment) => <p key={segment.id}><strong>{segment.speakerName} </strong>{segment.text}</p>)}
    </details>
    {error ? <div className="connection-status is-error" role="alert">
      <span>{error}</span>
      <button type="button" className="text-button" onClick={() => { setError(""); setReceiving(false); setAttempt((value) => value + 1); }}><ArrowClockwise size={15} />重试生成</button>
    </div> : output ? <article className="onboarding-sample__document" aria-live="polite">
      <h3>试用评审纪要</h3>
      {output.overview && <p>{output.overview}</p>}
      {!!conclusions?.length && <><h4>关键结论</h4><ul>{conclusions.slice(0, 2).map((item, index) => <li key={index}>{item}</li>)}</ul></>}
      {!!output.actionItems.length && <><h4>行动项</h4><ul>{output.actionItems.slice(0, 2).map((item) => <li key={item.id}>{item.title}{[item.owner, item.dueDate].filter(Boolean).map((field) => ` · ${field}`).join("")}</li>)}</ul></>}
      {!output.overview && !conclusions?.length && !output.actionItems.length && output.discussionSections?.slice(0, 1).map((section) => <div key={section.title}><h4>{section.title}</h4><ul>{section.points.slice(0, 2).map((point, index) => <li key={index}>{point.text}</li>)}</ul></div>)}
      {!output.overview && !conclusions?.length && !output.actionItems.length && !output.discussionSections?.length && <p>{[...output.topics, ...output.openQuestions, ...output.risks, ...output.nextSteps].slice(0, 2).join("；")}</p>}
    </article> : <div className="onboarding-sample__loading" role="status">
      <ArrowClockwise size={18} className="spin" />{receiving ? "正在整理模型输出…" : "正在生成示例纪要…"}
    </div>}
  </section>;
}
