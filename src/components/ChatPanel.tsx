/**
 * 右侧 AI 问答面板：围绕当前会议的转写与纪要与大模型对话。
 * - 会话按 meeting.id 存在模块级 Map 里：切换会议/收起面板不丢当次对话（不落盘，刷新即清）。
 * - 空状态展示「猜你想问」：从当前纪要内容推导的建议问题，点按即发送。
 * - 请求走主进程 chat:send（需已配置在线总结服务并已激活）；失败在气泡内以错误样式呈现，可重试。
 * - 回答按 Markdown 安全渲染（与个人笔记同一管线）；思维链在传输层仍被拆分
 *   （防止内联 <think> 泄入正文），但不再提供「思考过程」展示入口。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatTeardropText, Eraser, PaperPlaneRight, X } from "@phosphor-icons/react";
import type { Meeting } from "../types";
import { api } from "../lib/api";
import { markdownToHtml } from "../lib/markdown";
import { TYPEWRITER_TICK_MS, typewriterStep } from "../lib/typewriter";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 模型返回的思维链/思考过程（无则省略），默认折叠展示。 */
  reasoning?: string;
  pending?: boolean;
  failed?: boolean;
}

/** meeting.id → 当次会话的问答记录（内存态，随窗口关闭清空）。 */
const chatSessions = new Map<string, ChatMessage[]>();

function newMessageId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 转写 → "[mm:ss] 发言人：文本" 行；长会议只保留最近片段并注明截断。 */
function transcriptToContextText(meeting: Meeting) {
  if (meeting.transcript.length === 0) return "（本场会议还没有转写内容。）";
  const formatTime = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };
  const cap = 400;
  const segments = meeting.transcript.length > cap ? meeting.transcript.slice(-cap) : meeting.transcript;
  const body = segments.map((segment) =>
    `[${formatTime(segment.startMs)}] ${segment.speakerName}：${segment.text}`).join("\n");
  return meeting.transcript.length > cap
    ? `（仅保留最近 ${cap} 段，此前还有 ${meeting.transcript.length - cap} 段。）\n${body}`
    : body;
}

/** 从纪要推导「猜你想问」：优先指向本场会议实际存在的内容。 */
function suggestedQuestions(meeting: Meeting) {
  const questions = ["用三句话总结这场会议"];
  if (meeting.summary.decisions.length > 0) questions.push("这次会议确认了哪些决定？");
  if (meeting.summary.actionItems.length > 0) questions.push("行动项分别由谁负责？");
  if (meeting.summary.openQuestions.length > 0) questions.push("还有哪些未决问题？");
  if (questions.length < 3) questions.push("会议的重点内容是什么？");
  return questions.slice(0, 4);
}

interface ChatPanelProps {
  meeting: Meeting;
  /** 退场动画期间为 true：面板沿滑入方向收回，与栅格轨道收缩同步。 */
  closing?: boolean;
  onClose(): void;
}

export function ChatPanel({ meeting, closing, onClose }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatSessions.get(meeting.id) ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const suggestions = useMemo(() => suggestedQuestions(meeting), [meeting]);

  // 切换会议时载入该会议自己的会话记录。
  useEffect(() => {
    setMessages(chatSessions.get(meeting.id) ?? []);
  }, [meeting.id]);

  // 新消息/等待态出现时贴底滚动（跟随最新一问一答）。
  // 流式进行中增量高频到达，平滑滚动会排队抖动，改用瞬时贴底。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const streaming = Boolean(messages.at(-1)?.pending);
    list.scrollTo({
      top: list.scrollHeight,
      behavior: streaming || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    });
  }, [messages]);

  /** 当前会议 id 的镜像：发送进行中用户切换会议时，只写会话存储不覆盖正在看的列表。 */
  const meetingIdRef = useRef(meeting.id);
  meetingIdRef.current = meeting.id;

  const commitMessages = (next: ChatMessage[]) => {
    chatSessions.set(meeting.id, next);
    if (meetingIdRef.current === meeting.id) setMessages(next);
  };

  const send = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setDraft("");
    setBusy(true);
    const pendingId = newMessageId();
    const history = messages.map(({ role, text }) => ({ role, text }));
    commitMessages([
      ...messages,
      { id: newMessageId(), role: "user", text: trimmed },
      { id: pendingId, role: "assistant", text: "", pending: true }
    ]);
    // 打字机平滑队列（Codex 观感）：传输层增量先入缓冲，按真实模型的生成速度出字——
    // 约 40 字/秒起步、随缓冲增大提速（160 字/秒封顶），130 字回答约 3-4 秒铺完；
    // 出字在标点处断句并小停（句号 ~120ms、逗号 ~40ms），带自然呼吸而不是机械节拍器。
    const buffer = { content: "", reasoning: "" };
    let drainTimer: number | null = null;
    let pauseTicks = 0;
    const patchPending = (patch: (message: ChatMessage) => ChatMessage) => {
      commitMessages((chatSessions.get(meeting.id) ?? messages).map((message) =>
        message.id === pendingId ? patch(message) : message));
    };
    const startDrain = () => {
      if (drainTimer !== null) return;
      drainTimer = window.setInterval(() => {
        if (pauseTicks > 0) { pauseTicks -= 1; return; }
        // 出字节奏与断句小停统一走 typewriter 核心（转写流式揭示共用同一观感）。
        const contentStep = typewriterStep(buffer.content);
        const reasoningStep = typewriterStep(buffer.reasoning);
        if (!contentStep && !reasoningStep) return;
        buffer.content = buffer.content.slice((contentStep?.emit ?? "").length);
        buffer.reasoning = buffer.reasoning.slice((reasoningStep?.emit ?? "").length);
        pauseTicks = Math.max(pauseTicks, contentStep?.pauseTicks ?? 0, reasoningStep?.pauseTicks ?? 0);
        patchPending((message) => {
          const text = message.text + (contentStep?.emit ?? "");
          const reasoning = (message.reasoning ?? "") + (reasoningStep?.emit ?? "");
          return { ...message, text, reasoning: reasoning || undefined };
        });
        if (!buffer.content && !buffer.reasoning && drainTimer !== null) {
          window.clearInterval(drainTimer);
          drainTimer = null;
        }
      }, TYPEWRITER_TICK_MS);
    };
    try {
      const result = await api.chat.send(trimmed, history, {
        title: meeting.title,
        participants: meeting.participants,
        goals: meeting.goals,
        notes: meeting.notes,
        summary: meeting.summary,
        transcriptText: transcriptToContextText(meeting)
      }, (delta) => {
        buffer.reasoning += delta.reasoning ?? "";
        buffer.content += delta.content ?? "";
        startDrain();
      });
      // 流结束后等平滑队列吐完再落最终结果，避免结尾突兀地整段校正。
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!buffer.content && !buffer.reasoning && drainTimer === null) resolve();
          else window.setTimeout(check, 30);
        };
        check();
      });
      patchPending((message) =>
        ({ ...message, text: result.answer, reasoning: result.reasoning || undefined, pending: false, failed: false }));
    } catch (error) {
      if (drainTimer !== null) window.clearInterval(drainTimer);
      const reason = error instanceof Error ? error.message : String(error);
      patchPending((message) =>
        ({ ...message, text: reason.replace(/^Error invoking remote method '[^']+':\s*/, ""), pending: false, failed: true }));
    } finally {
      setBusy(false);
    }
  };

  const clearSession = () => {
    chatSessions.delete(meeting.id);
    setMessages([]);
  };

  return (
    <aside className={`transcript-panel chat-panel ${closing ? "is-closing" : ""}`} aria-label="AI 问答">
      <header className="chat-panel__header">
        <div>
          <h2>AI 问答</h2>
          <p>基于本场会议的转写与纪要回答</p>
        </div>
        <div className="chat-panel__actions">
          {messages.length > 0 && (
            <button
              className="icon-button"
              aria-label="清空对话"
              title="清空这场会议的问答记录"
              onClick={clearSession}
            >
              <Eraser size={16} />
            </button>
          )}
          <button className="icon-button" aria-label="关闭 AI 问答侧栏" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <ChatTeardropText size={28} weight="duotone" />
            <p>问问这场会议的任何内容——重点、决定、待办，或者某段讨论的细节。</p>
            <div className="chat-suggestions" aria-label="猜你想问">
              {suggestions.map((question) => (
                <button key={question} onClick={() => void send(question)}>{question}</button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`chat-row chat-row--${message.role} content-fade-enter`}>
              {message.role === "assistant" && (
                <span className="chat-avatar" aria-hidden="true"><ChatTeardropText size={15} weight="fill" /></span>
              )}
              <div className={`chat-bubble chat-bubble--${message.role} ${message.failed ? "is-failed" : ""}`}>
                {message.role === "assistant" ? (
                  message.text ? (
                    // 回答按 Markdown 安全渲染（marked + DOMPurify，见 lib/markdown），流式期间带打字光标。
                    <div
                      className={`chat-bubble__content ${message.pending ? "is-streaming" : ""}`}
                      dangerouslySetInnerHTML={{ __html: markdownToHtml(message.text) }}
                    />
                  ) : message.pending ? (
                    <span className="chat-typing" aria-label="正在思考" role="status">
                      <i /><i /><i />
                    </span>
                  ) : null
                ) : message.text}
              </div>
            </div>
          ))
        )}
      </div>

      <footer className="chat-composer">
        <textarea
          value={draft}
          rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 26)))}
          placeholder={busy ? "正在回答…" : "问点什么，回车发送"}
          aria-label="提问输入框"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
        />
        <button
          className="chat-send"
          aria-label="发送问题"
          disabled={busy || draft.trim().length === 0}
          onClick={() => void send(draft)}
        >
          <PaperPlaneRight size={16} weight="fill" />
        </button>
      </footer>
    </aside>
  );
}
