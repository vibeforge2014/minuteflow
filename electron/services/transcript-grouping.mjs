import { simplifyChinese } from "./chinese.mjs";

const normalizedText = (value) => String(value || "").toLocaleLowerCase()
  .replace(/[\s，。！？、,.!?;；:：'"“”‘’]/g, "");

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
    const sentenceCount = combinedText.match(/[。！？!?]/g)?.length ?? 0;
    const canMerge = previous.speakerId === current.speakerId
      && previous.track === current.track
      && gapMs >= -500 && gapMs <= 1_500
      && current.endMs - previous.startMs <= 18_000
      && combinedText.length <= 80
      && sentenceCount <= 4
      && !/[！？!?]\s*$/.test(previous.text)
      && !(/[。]\s*$/.test(previous.text) && (previous.text.match(/[。]/g)?.length ?? 0) >= 2);
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
