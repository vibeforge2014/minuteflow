/**
 * 受控 LLM 语义纠错引擎（服务层，纯逻辑可直测）。
 *
 * 设计原则：
 * 1. 只修同音错别字、专业术语拼写、人名/产品名误识别与明显断句标点；绝不润色改写风格或补充未提及事实。
 * 2. 强安全护栏（validateCorrectionSafety）：
 *    - 数字 / 百分比 / 金额 / 日期 / 版本号等数值记号不得变动；
 *    - 否定极性（不/没/没有/未/非/无/禁止/拒绝/无法/不能/不是/取消等）不得翻转或丢失；
 *    - 文本长度不得异常膨胀或大幅删减。
 * 3. 保留原稿（rawText）：每次应用纠错都在段落上保留原始 ASR 文本，支持 UI 随时对照与一键恢复。
 * 4. 滑窗 + 前文上下文：每次发送最多 20 段（约 2200 字），附带 3 段只读前文保持跨窗实体连续性；
 *    对低置信度段落显式标注 [低置信] 引导模型重点排查。
 */
import { extractMeetingHotwordPack } from "./hotwords.mjs";
import { requestStructuredJson } from "./providers.mjs";
import { simplifyChinese } from "./chinese.mjs";

const LOW_CONFIDENCE_THRESHOLD = 0.55;

const CHINESE_NUMERAL_PATTERN = /[零〇一二两三四五六七八九十百千万亿]+(?:\s*(?:个|次|天|周|月|年|小时|分钟|秒|点|分|元|块|万|亿|千|百|倍|成|折|家|人|项|条|期|版|季度|楼|号))?/g;
const ARABIC_NUMERAL_PATTERN = /\d+(?:[.,:/-]\d+)*(?:\s*(?:%|‰|个|次|天|周|月|年|小时|分钟|秒|点|分|元|块|万|亿|千|百|k|K|m|M|ms|s|GB|MB|KB|TB|QPS|TPS|FPS))?/g;

const NEGATION_PATTERN = /(?:不能|不得|不可|不会|不要|不是|不再|没有|尚未|无法|无需|无须|禁止|拒绝|并非|切勿|切忌|取消|不|没|未|非|无|别|否)/g;

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

/** 将常见中文数字转为阿拉伯数值字符串，减少「三天」与「3天」被误判为数值漂移。 */
function normalizeChineseNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  // 含单位后缀时拆分核心中文数字与后缀，保留后缀避免「三万」和「三天」混淆。
  const match = text.match(/^([零〇一二两三四五六七八九十百千万亿]+)(.*)$/);
  if (!match) return text;
  const [, body, suffix] = match;
  // 纯年份/编号式（如二零二六）逐位转数字。
  if (!/[十百千万亿]/.test(body) && body.length >= 2) {
    const digits = [...body].map((ch) => CN_DIGITS[ch]).join("");
    return `${digits}${suffix.trim()}`;
  }
  let total = 0;
  let section = 0;
  let current = 0;
  for (const ch of body) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit >= 10000) {
        section = (section + current) * unit;
        total += section;
        section = 0;
        current = 0;
      } else {
        if (current === 0 && unit === 10) current = 1;
        section += current * unit;
        current = 0;
      }
    }
  }
  const value = total + section + current;
  return `${value}${suffix.trim()}`;
}

/** 提取一段话中的标准化数值记号列表（用于校验纠错是否误改数字/金额/比例/日期）。 */
export function extractNumericTokens(text) {
  const source = String(text ?? "");
  const tokens = [];
  for (const match of source.matchAll(ARABIC_NUMERAL_PATTERN)) {
    tokens.push(match[0].replace(/\s+/g, "").replace(/,/g, "").toLowerCase());
  }
  for (const match of source.matchAll(CHINESE_NUMERAL_PATTERN)) {
    const raw = match[0].trim();
    // 排除「一般/一起/一直/一下/一点/一定/一个劲/一些/十分/不同/万一」等非数量副词/高频惯用语，
    // 避免把修辞词错当数值；但「一万/三天/百分之十」等明确数量保留。
    if (/^[一]$/.test(raw) && !/[0-9]/.test(raw)) continue;
    const normalized = normalizeChineseNumber(raw);
    if (normalized) tokens.push(normalized.toLowerCase());
  }
  return tokens;
}

/** 提取文本中的否定极性记号数量（捕获肯定↔否定翻转）。 */
export function extractNegationSignature(text) {
  const source = String(text ?? "");
  const matches = source.match(NEGATION_PATTERN) ?? [];
  return matches.length;
}

/**
 * 计算中英混合文本的语义单元长度：
 * 每个中文汉字/标点计 1 单元，连续英文单词（如 WebRTC、DeepSeek、Kubernetes）计 2 单元，
 * 避免「欧拉马→Ollama」「迪普西克→DeepSeek」这类合法中英专名纠错因字母数翻倍被误拦。
 */
function semanticUnitLength(text) {
  const cleaned = String(text ?? "").replace(/\s+/g, "");
  let units = 0;
  let index = 0;
  while (index < cleaned.length) {
    const rest = cleaned.slice(index);
    const asciiWord = rest.match(/^[A-Za-z0-9._/-]+/);
    if (asciiWord) {
      units += Math.min(3, Math.max(1, Math.ceil(asciiWord[0].length / 4)));
      index += asciiWord[0].length;
    } else {
      units += 1;
      index += 1;
    }
  }
  return units;
}

/**
 * 校验单条纠错结果是否安全可采纳：
 * 拒绝任何数值改动、否定极性翻转或异常长度变化，确保纠错只做同音/术语/标点修正。
 */
export function validateCorrectionSafety(original, corrected) {
  const raw = String(original ?? "").trim();
  const next = String(corrected ?? "").trim();
  if (!raw || !next) return { accepted: false, reason: "empty" };
  if (raw === next) return { accepted: false, reason: "unchanged" };

  // 1. 语义单元长度比例检查：防止模型总结/扩写/删句，同时兼容中文音译改英文专名。
  const rawLen = semanticUnitLength(raw);
  const nextLen = semanticUnitLength(next);
  if (rawLen >= 10) {
    const ratio = nextLen / rawLen;
    if (ratio < 0.65 || ratio > 1.35) {
      return { accepted: false, reason: "length_drift" };
    }
  } else if (nextLen > rawLen + 6 || nextLen < Math.max(1, rawLen - 4)) {
    return { accepted: false, reason: "length_drift" };
  }

  // 2. 数值一致性检查（阿拉伯数字 + 明确中文数量词）。
  const rawNums = extractNumericTokens(raw);
  const nextNums = extractNumericTokens(next);
  if (rawNums.length !== nextNums.length || rawNums.some((token, index) => token !== nextNums[index])) {
    return { accepted: false, reason: "numeric_mismatch" };
  }

  // 3. 否定极性一致性检查（防止把「不上线」误改「上线」或反之）。
  if (extractNegationSignature(raw) !== extractNegationSignature(next)) {
    return { accepted: false, reason: "negation_flip" };
  }

  return { accepted: true };
}

/**
 * 将定稿转写段落切分为滑窗批次；每批附带前序若干段作为只读上下文。
 */
export function buildCorrectionWindows(segments = [], {
  maxSegments = 20,
  maxChars = 2_200,
  overlapSegments = 3
} = {}) {
  const eligible = (Array.isArray(segments) ? segments : []).filter(
    (segment) => segment && segment.status !== "provisional" && typeof segment.text === "string" && segment.text.trim()
  );
  if (!eligible.length) return [];

  const windows = [];
  let cursor = 0;
  while (cursor < eligible.length) {
    const target = [];
    let chars = 0;
    while (cursor < eligible.length && target.length < maxSegments) {
      const seg = eligible[cursor];
      const segLen = seg.text.length + 24;
      if (target.length > 0 && chars + segLen > maxChars) break;
      target.push(seg);
      chars += segLen;
      cursor += 1;
    }
    const startIndex = cursor - target.length;
    const context = eligible.slice(Math.max(0, startIndex - overlapSegments), startIndex);
    windows.push({ context, target });
  }
  return windows;
}

/** 找出当前滑窗文本中命中的同音误识别别名提示（优先带入实际出现的别名，其次补少量高频别名）。 */
export function selectWindowAliasHints(windowSegments = [], aliasHints = [], maxHints = 24) {
  if (!Array.isArray(aliasHints) || !aliasHints.length) return [];
  const joined = windowSegments.map((seg) => String(seg?.text ?? "")).join("\n").toLowerCase();
  const matched = [];
  const rest = [];
  const seen = new Set();
  for (const item of aliasHints) {
    if (!item?.alias || !item?.canonical) continue;
    const key = `${item.alias.toLowerCase()}=>${item.canonical.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (joined.includes(item.alias.toLowerCase())) {
      matched.push(item);
    } else if (item.matchedInText) {
      rest.unshift(item);
    } else {
      rest.push(item);
    }
  }
  return [...matched, ...rest].slice(0, maxHints);
}

function buildCorrectionPrompt({ meeting, hotwords, aliasHints = [], window }) {
  const formatLine = (segment, includeConfidence = false) => {
    const lowConf = includeConfidence && typeof segment.confidence === "number" && segment.confidence < LOW_CONFIDENCE_THRESHOLD
      ? " [低置信]"
      : "";
    return `[${segment.id}]${lowConf} ${segment.speakerName || "发言人"}: ${segment.text}`;
  };
  const windowAliases = selectWindowAliasHints(window.target, aliasHints, 24);
  return [
    "你是严谨的中文/中英混合语音转写校对员。请对下方「待校对段落」做最小化纠错，只修复明显的语音识别错误。",
    "严格遵守以下规则：",
    "1. 只允许修复：同音错别字、专业术语/产品名/人名拼写错误、英文缩写大小写、明显遗漏或错位的标点。",
    "2. 严禁修改任何数字、金额、百分比、日期、版本号与时间（包括中文数字）。",
    "3. 严禁改变否定含义（如「不/没/未/无/禁止/取消」等绝对不能增删或翻转）。",
    "4. 严禁润色口语、删减内容、合并句子或补充说话人没有说过的信息。没有明显识别错误的段落不要出现在结果中。",
    "5. 标注 [低置信] 的段落最可能存在同音误识别，请结合前后文与参考热词重点核对。",
    `会议主题：${meeting.title || "未命名会议"}`,
    ...(Array.isArray(meeting.participants) && meeting.participants.length
      ? [`参会人：${meeting.participants.join("、")}`]
      : []),
    ...(hotwords.length ? [`参考热词（优先采用这些标准写法）：${hotwords.join("、")}`] : []),
    ...(windowAliases.length
      ? [`常见同音误识别对照（结合语境确认为误听时，优先将左侧改为右侧标准词）：${windowAliases.map((a) => `${a.alias}→${a.canonical}`).join("；")}`]
      : []),
    ...(window.context.length
      ? [`前文上下文（仅供理解指代，请勿修改）：\n${window.context.map((seg) => formatLine(seg, false)).join("\n")}`]
      : []),
    `待校对段落：\n${window.target.map((seg) => formatLine(seg, true)).join("\n")}`,
    '只输出一个 JSON 对象，格式严格为：{"corrections":[{"id":"原段落id","text":"修正后的完整文本"}]}。若全部无需修改，输出 {"corrections":[]}。'
  ].join("\n\n");
}

/**
 * 对整场会议的定稿转写执行受控 LLM 语义纠错。
 * @returns {Promise<{ transcript: object[], correctedCount: number, rejectedCount: number, llmCalls: number, durationMs: number, domains: string[] }>}
 */
export async function correctTranscriptWithLLM(profile, apiKey, meeting, {
  hotwords,
  aliasHints,
  selectedDomains = [],
  globalGlossary = [],
  signal,
  onProgress,
  requestJson = requestStructuredJson
} = {}) {
  const startedAt = Date.now();
  const transcript = Array.isArray(meeting?.transcript) ? meeting.transcript : [];
  const windows = buildCorrectionWindows(transcript);
  if (!windows.length) {
    return { transcript, correctedCount: 0, rejectedCount: 0, llmCalls: 0, durationMs: 0, domains: [] };
  }

  const pack = extractMeetingHotwordPack({
    title: meeting?.title,
    participants: meeting?.participants,
    goals: meeting?.goals,
    notes: meeting?.notes,
    notesMarkdown: meeting?.notesMarkdown,
    transcript,
    globalGlossary,
    selectedDomains,
    maxCount: 48
  });
  const resolvedHotwords = Array.isArray(hotwords) && hotwords.length ? hotwords : pack.hotwords;
  const resolvedAliases = Array.isArray(aliasHints) && aliasHints.length ? aliasHints : pack.aliasHints;

  const edits = new Map();
  let rejectedCount = 0;
  let llmCalls = 0;

  for (let index = 0; index < windows.length; index += 1) {
    signal?.throwIfAborted?.();
    onProgress?.({ current: index + 1, total: windows.length });
    const window = windows[index];
    const targetById = new Map(window.target.map((seg) => [seg.id, seg]));
    const prompt = buildCorrectionPrompt({ meeting, hotwords: resolvedHotwords, aliasHints: resolvedAliases, window });
    llmCalls += 1;
    const response = await requestJson(profile, apiKey, {
      systemPrompt: "你是严谨的语音转写校对员，只输出可解析的 JSON。",
      userPrompt: prompt,
      temperature: 0.1,
      maxTokens: 4_096,
      signal,
      label: "转写语义校对失败"
    });
    const list = Array.isArray(response?.corrections) ? response.corrections : [];
    for (const item of list) {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string") continue;
      const originalSegment = targetById.get(item.id);
      if (!originalSegment) continue;
      const candidate = simplifyChinese(item.text.trim());
      const verdict = validateCorrectionSafety(originalSegment.text, candidate);
      if (verdict.accepted) {
        edits.set(originalSegment.id, candidate);
      } else if (verdict.reason !== "unchanged") {
        rejectedCount += 1;
      }
    }
  }

  const nextTranscript = transcript.map((segment) => {
    const correctedText = edits.get(segment.id);
    if (!correctedText) return segment;
    return {
      ...segment,
      rawText: segment.rawText ?? segment.text,
      text: correctedText,
      corrected: true
    };
  });

  return {
    transcript: nextTranscript,
    correctedCount: edits.size,
    rejectedCount,
    llmCalls,
    durationMs: Date.now() - startedAt,
    domains: pack.domains
  };
}
