/**
 * 动态会议热词引擎（纯函数，无 Electron 依赖，可被 vitest 直测）。
 *
 * 从多个层级收集并按相关性打分筛选热词，避免无差别塞入大量词汇造成 Whisper 识别偏置：
 *  1. 全局自定义术语表（用户显式维护）
 *  2. 本场会议参会人真实姓名（过滤「我 / 发言人N / 待识别」等占位名）
 *  3. 会议标题、目标与笔记中的英文缩写/产品代号/中英混合专名（如 SKU、API、WebRTC、Q3）
 *  4. 标题与笔记中的引号/书名号专名（如「登录改版」、《合规清单》）
 *  5. 标题与目标中的高信息量中文核心短语（过滤常见停用词）
 *
 * 产出供两处复用：
 *  - 转写阶段（buildTranscriptionPrompt）：按 220 字预算优先注入高权热词；
 *  - 后处理纠错阶段（transcript-correction.mjs）：提供完整热词清单辅助同音/专名修复。
 */
import { normalizeGlossary } from "./transcription-prompt.mjs";
import { collectDomainHotwords, detectHotwordDomains, parseGlossaryEntry } from "../../shared/hotword-domains.mjs";

const PLACEHOLDER_PARTICIPANT = /^(?:我|待识别|远端发言人|未分离|发言人\d*(?:\s*·\s*待校准)?)$/;

/** 高频泛词，不作为热词注入（避免诱导 ASR 偏置）。 */
const STOP_PHRASES = new Set([
  "会议", "讨论", "同步", "评审", "复盘", "周会", "例会", "沟通", "对齐", "汇报",
  "计划", "方案", "问题", "优化", "进展", "确认", "需要", "大家", "我们", "你们",
  "他们", "今天", "明天", "本周", "下周", "目前", "现在", "后续", "主要", "相关",
  "进行", "完成", "处理", "安排", "目标", "内容", "情况", "记录", "项目", "团队"
]);

const ENGLISH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "will", "about",
  "note", "notes", "todo", "meeting", "review", "sync", "update", "plan", "action",
  "item", "items", "week", "today", "tomorrow", "next", "status", "summary"
]);

/** 英文缩写、驼峰产品名、首字母大写专有名词（如 Kafka/Redis/Docker）、带数字代号（如 Q3/GPT-5/WebRTC/SKU/API）。 */
const TECH_TOKEN_PATTERN = /\b(?:[A-Z]{2,}[A-Za-z0-9._-]*|[A-Z][a-z]+[A-Z][A-Za-z0-9._-]*|[A-Z][a-z]{2,}[A-Za-z0-9._-]*|[A-Za-z]+[-_]?\d+[A-Za-z0-9._-]*)\b/g;

/** 引号/书名号内常为产品名、模块名或专有概念。 */
const QUOTED_TERM_PATTERN = /[「《“"【]([^」》”"】]{2,20})[」》”"】]/g;

/** 按标点/空白切分中文标题/目标片段。 */
const PHRASE_SPLIT_PATTERN = /[\s，。！？、,.!?;；:：/\\|()（）\-—·]+/;

function addCandidate(map, rawTerm, weight, source) {
  const term = String(rawTerm ?? "").trim();
  if (!term || term.length < 2 || term.length > 32) return;
  if (/^\d+$/.test(term)) return;
  if (STOP_PHRASES.has(term)) return;
  const key = term.toLowerCase();
  if (ENGLISH_STOP_WORDS.has(key)) return;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { term, weight, sources: new Set([source]) });
    return;
  }
  existing.sources.add(source);
  // 同一词多源命中时抬升权重，且优先保留含大写字母的标准拼写（如 API 优于 api）。
  const hasMoreUpper = (term.match(/[A-Z]/g)?.length ?? 0) > (existing.term.match(/[A-Z]/g)?.length ?? 0);
  if (hasMoreUpper || weight > existing.weight) existing.term = term;
  existing.weight = Math.max(existing.weight, weight) + 4;
}

function extractTechAndQuoted(map, texts, baseWeight, source) {
  for (const raw of texts) {
    const text = String(raw ?? "");
    if (!text.trim()) continue;
    for (const match of text.matchAll(TECH_TOKEN_PATTERN)) {
      addCandidate(map, match[0], baseWeight, source);
    }
    for (const match of text.matchAll(QUOTED_TERM_PATTERN)) {
      addCandidate(map, match[1], baseWeight - 2, source);
    }
  }
}

function extractCoreChinesePhrases(map, texts, baseWeight, source) {
  for (const raw of texts) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    for (const piece of text.split(PHRASE_SPLIT_PATTERN)) {
      const cleaned = piece.trim();
      if (!cleaned || cleaned.length < 2 || cleaned.length > 10) continue;
      // 必须包含中文且不能全是停用词。
      if (!/[\u4e00-\u9fff]/.test(cleaned)) continue;
      if (STOP_PHRASES.has(cleaned)) continue;
      addCandidate(map, cleaned, baseWeight, source);
    }
  }
}

/**
 * 为一场会议生成完整的热词包：
 * - hotwords: 按优先级排序的去重热词（用户术语 > 参会人 > 标题/目标/笔记专名 > 内置领域热词）
 * - domains: 本次激活的内置领域 ID 列表
 * - aliasHints: 命中的同音误识别别名提示（[{ alias, canonical, matchedInText }]），供 LLM 语义纠错使用
 */
export function extractMeetingHotwordPack({
  title = "",
  participants = [],
  goals = [],
  notes = [],
  notesMarkdown = "",
  transcript = [],
  globalGlossary = [],
  extraGlossary = [],
  selectedDomains = [],
  autoDetectDomains = true,
  maxCount = 24
} = {}) {
  const candidates = new Map();

  // 1. 用户显式配置的术语表（最高权重，保持用户排序微差，同时提取用户自定义同音别名）。
  const rawExplicit = [...(extraGlossary ?? []), ...(globalGlossary ?? [])];
  const userAliases = [];
  const explicit = normalizeGlossary(rawExplicit);
  explicit.forEach((term, index) => {
    addCandidate(candidates, term, 120 - Math.min(index, 20) * 0.5, "glossary");
  });
  for (const rawEntry of rawExplicit) {
    const parsed = parseGlossaryEntry(rawEntry);
    if (!parsed?.aliases.length) continue;
    for (const alias of parsed.aliases) {
      userAliases.push({ alias, canonical: parsed.term, domainId: "custom" });
    }
  }

  // 2. 参会人真实姓名（去除括号角色说明后的主姓名 + 原始名）。
  for (const rawName of Array.isArray(participants) ? participants : []) {
    const name = String(rawName ?? "").trim();
    if (!name || PLACEHOLDER_PARTICIPANT.test(name)) continue;
    const primary = name.replace(/[（(][^）)]*[）)]/g, "").trim();
    if (primary && !PLACEHOLDER_PARTICIPANT.test(primary)) {
      addCandidate(candidates, primary, 102, "participant");
    }
  }

  // 3. 标题、目标、笔记中的英文缩写/产品代号与引号内专名。
  const noteLines = [
    ...(Array.isArray(notes) ? notes : []),
    ...(notesMarkdown ? String(notesMarkdown).split("\n").slice(0, 40) : [])
  ];
  extractTechAndQuoted(candidates, [title], 96, "title");
  extractTechAndQuoted(candidates, Array.isArray(goals) ? goals : [], 90, "goals");
  extractTechAndQuoted(candidates, noteLines, 84, "notes");

  // 4. 标题与目标里的中文核心短语（笔记正文过长容易带入普通口语，只从标题/目标抽）。
  extractCoreChinesePhrases(candidates, [title], 78, "title");
  extractCoreChinesePhrases(candidates, Array.isArray(goals) ? goals : [], 68, "goals");

  // 5. 内置领域热词与同音别名：仅按会议相关性或用户显式勾选激活，绝不挤占高权自定义词。
  const domains = detectHotwordDomains({
    title,
    goals,
    notes,
    notesMarkdown,
    transcript,
    selectedDomains,
    autoDetect: autoDetectDomains
  });
  const contextText = [
    title,
    ...(Array.isArray(goals) ? goals : []),
    ...noteLines,
    ...(Array.isArray(transcript) ? transcript : [])
      .filter((seg) => seg && seg.status !== "provisional" && typeof seg.text === "string")
      .slice(0, 80)
      .map((seg) => seg.text)
  ].join("\n");
  const domainPack = domains.length
    ? collectDomainHotwords(domains, { contextText, maxTerms: Math.max(24, maxCount) })
    : { terms: [], aliases: [] };
  for (const item of domainPack.terms) {
    // 领域词上限压在 94 以下，确保永远不覆盖用户自定义术语（120）和参会人姓名（102）。
    addCandidate(candidates, item.term, Math.min(94, item.weight), `domain:${item.domainId}`);
  }

  const hotwords = [...candidates.values()]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, Math.max(1, maxCount))
    .map((entry) => entry.term);

  const lowerContext = contextText.toLowerCase();
  const customAliasHints = userAliases.map((entry) => ({
    ...entry,
    matchedInText: lowerContext.includes(entry.alias.toLowerCase())
  })).sort((a, b) => Number(b.matchedInText) - Number(a.matchedInText));

  return {
    hotwords,
    domains,
    aliasHints: [...customAliasHints, ...domainPack.aliases]
  };
}

/**
 * 为一场会议生成按相关性排序的动态热词表（extractMeetingHotwordPack 的精简封装）。
 * @returns {string[]} 按优先级排序的去重热词数组
 */
export function extractMeetingHotwords(options = {}) {
  return extractMeetingHotwordPack(options).hotwords;
}
