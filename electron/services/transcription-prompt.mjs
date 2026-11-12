/**
 * 转写提示词与语言决策（纯函数，无 Electron 依赖，可被 vitest 直测）。
 *
 * Whisper 系引擎的 initial_prompt / --prompt 有很短的上下文上限（官方 224 token，
 * 中文约等于 224 字），且内容会直接影响解码器的用词、简繁与专有名词写法。
 * 因此把三类上下文按优先级压进固定预算：
 *   1. 简体引导语（仅语言已确定为 zh 时；auto 首块不引导，避免语种被带偏）
 *   2. 上一块已定稿文本的尾部（保持专名、断句风格连续，抑制同音词漂移）
 *   3. 用户术语表（专有名词优先，超出预算的条目截掉）
 *
 * 收口前各引擎各拼各的：远程接口只传术语表、whisper.cpp 额外加简体引导语，
 * 而导入/重转写链路三者都不传，导致同一场会议换条路径识别用词就不一致。
 * 另外「自动识别」原先会让每个 10 秒块各自重新判语种，短块（尤其中英混说、
 * 只有语气词的块）极易误判；这里提供从首块结果锁定语言的决策函数。
 */

/** Whisper prompt 的安全字符预算；留出余量避免被 tokenizer 截断后丢掉术语表。 */
export const DEFAULT_PROMPT_MAX_CHARS = 220;
/** 前文只取尾部这一小段，过长会把 prompt 预算吃光并污染当前块。 */
export const PREVIOUS_TEXT_MAX_CHARS = 80;

const SIMPLIFIED_CHINESE_HINT = "以下是简体中文的会议记录。";
const SENTENCE_END = /[。！？!?…；;]/g;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN = /[a-z\u00c0-\u024f]/gi;

/** 术语表清洗：去空、去过长误粘贴段落、按原样去重。 */
export function normalizeGlossary(glossary = []) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(glossary) ? glossary : []) {
    const term = String(raw ?? "").trim();
    if (!term || term.length > 40) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

/**
 * 取已定稿文本的尾部作为下一块的上下文。尽量从句首开始，避免把半句话塞进
 * prompt 让模型续写；找不到句末边界时按字符硬截。
 */
export function tailTranscriptText(text = "", maxChars = PREVIOUS_TEXT_MAX_CHARS) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  const sliced = normalized.slice(-maxChars);
  const breaks = [...sliced.matchAll(SENTENCE_END)];
  if (!breaks.length) return sliced.trim();
  // 只取最后一句完整句：硬截出来的头尾半句都丢掉，避免模型把上下文当续写任务。
  const last = breaks.at(-1);
  const previous = breaks.length >= 2 ? breaks.at(-2) : null;
  const start = previous ? previous.index + previous[0].length : 0;
  const end = last.index + last[0].length;
  return sliced.slice(start, end).trim() || sliced.trim();
}

/**
 * 构造送入识别引擎的提示词。返回空串表示「不要传 prompt 参数」。
 * 预算按优先级分配：引导语 → 前文 → 术语表；任何一项放不下就整段舍弃，
 * 绝不把术语截成半个词（半个专名反而会诱导模型写错）。
 */
export function buildTranscriptionPrompt({
  language = "",
  glossary = [],
  previousText = "",
  maxChars = DEFAULT_PROMPT_MAX_CHARS
} = {}) {
  const budget = Math.max(0, Number(maxChars) || 0);
  if (!budget) return "";
  // 语言未定（auto 首块）时不给任何引导语：Whisper 的 initial_prompt 带有明显
  // 语言倾向，中文提示会把英文音频诱导成中文输出。等首块锁定语种后再补简体引导。
  const hint = language === "zh" ? SIMPLIFIED_CHINESE_HINT : "";
  const parts = [];
  const withPart = (candidate) => [...parts, candidate].join(" ").length <= budget;
  if (hint && withPart(hint)) parts.push(hint);
  const tail = tailTranscriptText(previousText);
  if (tail && withPart(tail)) parts.push(tail);
  let termsText = "";
  for (const term of normalizeGlossary(glossary)) {
    const next = termsText ? `${termsText}，${term}` : term;
    if (!withPart(next)) break;
    termsText = next;
  }
  if (termsText) parts.push(termsText);
  return parts.join(" ");
}

/**
 * 把用户配置的语言转成可直接交给引擎的值。
 * auto / 空值必须变成空串：whisper.cpp 接受 -l auto，但 Python Whisper 会把
 * "auto" 当成非法语言代码、远程接口会把 language=auto 直接 400。空串让各引擎
 * 自行检测，再由 resolveChunkLanguage 从首块结果锁定语种。
 */
export function transcriptionLanguageForEngine(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto" || raw === "detect" || raw === "auto-detect") return "";
  return raw;
}

/** 只接受引擎能识别的语种值；auto / 未知一律归一为空串。 */
export function normalizeLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.startsWith("zh") || raw === "chinese" || raw === "mandarin") return "zh";
  if (raw.startsWith("en") || raw === "english") return "en";
  return "";
}

/** 从识别文本粗判语种，用于引擎不返回 language 字段时的兜底。文本太短不下结论。 */
export function inferLanguageFromText(text = "") {
  const value = String(text ?? "");
  const cjk = (value.match(CJK) ?? []).length;
  const latin = (value.match(LATIN) ?? []).length;
  if (cjk + latin < 4) return "";
  if (cjk / (cjk + latin) >= 0.15) return "zh";
  return latin > 0 ? "en" : "";
}

/**
 * 单个音频块实际使用的语言：
 * - 用户显式指定（zh/en）永远优先，不做自动改写；
 * - auto 模式下，一旦此前已锁定语言就固定沿用，避免每块重新检测漂移；
 * - 首块优先采信引擎返回的 language，缺失时从识别文本推断。
 * 返回值写回任务后，后续块都会带上它。
 */
export function resolveChunkLanguage({ configured = "", detected = "", resultLanguage = "", text = "" } = {}) {
  const explicit = normalizeLanguage(configured);
  if (explicit) return explicit;
  const locked = normalizeLanguage(detected);
  if (locked) return locked;
  return normalizeLanguage(resultLanguage) || inferLanguageFromText(text);
}
