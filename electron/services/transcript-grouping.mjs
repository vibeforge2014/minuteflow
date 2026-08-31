import { simplifyChinese } from "./chinese.mjs";

const normalizedText = (value) => String(value || "").toLocaleLowerCase()
  .replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");

const TERMINAL_PUNCTUATION = /[。！？!?…]/g;
const HARD_TERMINAL = /[！？!?]\s*$/;
const COMPLETE_SENTENCE = /[。！？!?…]\s*$/;
const TOPIC_OPENER = /^(?:接下来|另外(?:一个|一点|一方面)?|关于|至于|最后|总结一下|下一(?:项|点|个)|第[二三四五六七八九十]+[点项个]|next\b|regarding\b|finally\b)/i;
const MAX_PARAGRAPH_CHARACTERS = 120;
const MAX_PARAGRAPH_DURATION_MS = 45_000;
const MAX_SILENCE_MS = 1_500;

/** 模型只返回全文时，保留句末标点拆成可组合的原子片段。 */
export function splitTranscriptText(value = "") {
  const text = String(value).trim();
  if (!text) return [];
  return text.match(/[^。！？!?…]+(?:[。！？!?…]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [text];
}

/** 按文字长度把句子映射到给定时间窗口；仅作为缺少模型时间片时的近似降级。 */
export function splitTimedTranscriptText(text, startMs, endMs) {
  const parts = splitTranscriptText(text);
  if (parts.length <= 1) return parts.map((part) => ({ startMs, endMs, text: part }));
  const duration = Math.max(parts.length, endMs - startMs);
  const weights = parts.map((part) => Math.max(1, normalizedText(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let consumedWeight = 0;
  let cursor = startMs;
  return parts.map((part, index) => {
    consumedWeight += weights[index];
    const next = index === parts.length - 1
      ? endMs
      : Math.min(endMs, Math.max(cursor + 1, startMs + Math.round(duration * consumedWeight / totalWeight)));
    const fragment = { startMs: cursor, endMs: Math.max(cursor + 1, next), text: part };
    cursor = fragment.endMs;
    return fragment;
  });
}

/** Electron 导入链路使用的自然段落整理器；策略与渲染层实时录音保持一致。 */
export function groupTranscriptSegments(segments = []) {
  return [...segments].sort((left, right) => left.startMs - right.startMs).reduce((grouped, raw) => {
    const current = { ...raw, text: simplifyChinese(String(raw.text || "")) };
    const previous = grouped.at(-1);
    if (!previous || previous.status !== "final" || current.status !== "final") {
      grouped.push(current);
      return grouped;
    }
    const gapMs = current.startMs - previous.endMs;
    const spacer = /[a-z\d]$/i.test(previous.text) && /^[a-z\d]/i.test(current.text) ? " " : "";
    const combinedText = `${previous.text}${spacer}${current.text}`;
    const previousSentenceCount = previous.text.match(TERMINAL_PUNCTUATION)?.length ?? 0;
    const startsNewTopic = COMPLETE_SENTENCE.test(previous.text) && TOPIC_OPENER.test(current.text.trim());
    const canMerge = previous.speakerId === current.speakerId
      && previous.track === current.track
      && gapMs >= -500 && gapMs < MAX_SILENCE_MS
      && current.endMs - previous.startMs <= MAX_PARAGRAPH_DURATION_MS
      && combinedText.length <= MAX_PARAGRAPH_CHARACTERS
      && previousSentenceCount < 2
      && !HARD_TERMINAL.test(previous.text)
      && !startsNewTopic;
    if (!canMerge) {
      grouped.push(current);
      return grouped;
    }
    const previousKey = normalizedText(previous.text);
    const currentKey = normalizedText(current.text);
    grouped[grouped.length - 1] = {
      ...previous,
      endMs: Math.max(previous.endMs, current.endMs),
      text: previousKey.includes(currentKey) ? previous.text : combinedText,
      confidence: previous.confidence === undefined ? current.confidence
        : current.confidence === undefined ? previous.confidence
          : Math.min(previous.confidence, current.confidence)
    };
    return grouped;
  }, []);
}
