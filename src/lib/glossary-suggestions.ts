/**
 * 识别后术语纠错建议（纯函数，绝不静默改字）。
 *
 * Whisper 的 initial_prompt 只能「引导」用词，遇到生僻产品名、人名、项目代号仍会
 * 写成同音字或多/少一个字母。直接按术语表全局替换风险很高（可能把正常句子里的
 * 常用词改坏），因此这里只找出**可解释的近似片段**，交给用户在逐字稿上逐条确认。
 *
 * 两类建议：
 * - format：归一化后完全相同，只是空格/大小写/全半角不同（如 "Minute Flow" → "MinuteFlow"）；
 * - typo：编辑距离为 1 的近似写法（如「Q3 复潘」→「Q3 复盘」、「Minuteflow」→「MinuteFlow」）。
 * 中文与拉丁文使用不同的最小长度门槛，避免两字词在长段落里刷屏误报。
 */

export interface GlossarySuggestion {
  /** 稳定 id：段落 id + 原文位置 + 目标术语。 */
  id: string;
  /** 原文中被建议替换的区间 [start, end)。 */
  start: number;
  end: number;
  /** 原文片段。 */
  original: string;
  /** 术语表中的标准写法。 */
  replacement: string;
  kind: "format" | "typo";
}

/** 单段最长扫描字符数；超长段落跳过建议，避免长会议逐字稿卡顿。 */
export const MAX_SUGGESTION_TEXT_CHARS = 400;
/** 参与匹配的术语上限（与设置页提示的「20 条以内生效」对齐并留余量）。 */
export const MAX_SUGGESTION_TERMS = 24;

const SKIPPED_CHARS = /[\s\u3000·・\-_.、，,;；:：/\\]/u;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** 术语表清洗：去空、去过长误粘贴段落、按原样去重、限容量。 */
export function normalizeGlossaryTerms(glossary: string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of Array.isArray(glossary) ? glossary : []) {
    const term = String(raw ?? "").trim();
    if (!term || term.length > 40 || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
    if (result.length >= MAX_SUGGESTION_TERMS) break;
  }
  return result;
}

interface FoldedChar {
  folded: string;
  originalIndex: number;
}

/** 逐字符折叠：去分隔符、小写化；保留下标映射以便把命中位置还原到原文。 */
function foldWithMap(value: string): FoldedChar[] {
  const result: FoldedChar[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (SKIPPED_CHARS.test(char)) continue;
    const normalized = char.normalize("NFKC").toLowerCase();
    const folded = normalized[0] ?? "";
    if (folded && !SKIPPED_CHARS.test(folded)) result.push({ folded, originalIndex: index });
  }
  return result;
}

const fold = (value: string) => foldWithMap(value).map((item) => item.folded).join("");

/** 带上限的 Levenshtein；只需知道是否「恰好差一个字符」。 */
function editDistanceWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return Math.min(previous[b.length], max + 1);
}

interface RankedSuggestion extends GlossarySuggestion {
  rank: number;
}

/**
 * 找出一段转写文本里的术语疑似误写。返回的建议按「格式差异优先、位置靠前优先」排序，
 * 且互不重叠；同一个术语最多给一条建议。调用方负责展示与确认，本函数不修改文本。
 */
export function findGlossarySuggestions(text: string, glossary: string[] = [], limit = 3): GlossarySuggestion[] {
  const source = String(text ?? "");
  if (!source || source.length > MAX_SUGGESTION_TEXT_CHARS || limit <= 0) return [];
  const foldedChars = foldWithMap(source);
  const foldedSource = foldedChars.map((item) => item.folded).join("");
  if (!foldedSource) return [];

  const toSuggestion = (
    startFold: number,
    endFold: number,
    term: string,
    kind: GlossarySuggestion["kind"],
    rank: number
  ): RankedSuggestion | null => {
    const first = foldedChars[startFold];
    const last = foldedChars[endFold - 1];
    if (!first || !last) return null;
    const start = first.originalIndex;
    const end = last.originalIndex + 1;
    const original = source.slice(start, end);
    if (!original.trim() || original === term) return null;
    return {
      id: `${start}:${end}:${term}`,
      start,
      end,
      original,
      replacement: term,
      kind,
      rank
    };
  };

  const candidates: RankedSuggestion[] = [];
  for (const term of normalizeGlossaryTerms(glossary)) {
    // 标准写法已经原样出现：不需要任何建议。
    if (source.includes(term)) continue;
    const foldedTerm = fold(term);
    if (foldedTerm.length < 2 || foldedTerm.length > 32) continue;

    const exactAt = foldedSource.indexOf(foldedTerm);
    if (exactAt >= 0) {
      const found = toSuggestion(exactAt, exactAt + foldedTerm.length, term, "format", 0);
      if (found) candidates.push(found);
      continue;
    }

    // 中文 3 字 / 拉丁 5 字符以上才做近似匹配，短词误报率过高。
    const minTypoLength = CJK.test(foldedTerm) ? 3 : 5;
    if (foldedTerm.length < minTypoLength) continue;
    // 廉价预筛：绝大多数滑动窗口与专名没有任何共同字符，先按字符重合度排除，
    // 只有极少数候选才进入 O(L²) 的编辑距离，长段落里不会拖慢逐字稿渲染。
    const termChars = new Set(foldedTerm);
    const minShared = Math.max(1, foldedTerm.length - 2);
    let best: RankedSuggestion | null = null;
    for (let length = foldedTerm.length - 1; length <= foldedTerm.length + 1; length += 1) {
      if (length < 2) continue;
      for (let startFold = 0; startFold + length <= foldedSource.length; startFold += 1) {
        const part = foldedSource.slice(startFold, startFold + length);
        if (part === foldedTerm || foldedTerm.includes(part) || part.includes(foldedTerm)) continue;
        let shared = 0;
        for (const char of part) {
          if (termChars.has(char)) shared += 1;
          if (shared >= minShared) break;
        }
        if (shared < minShared) continue;
        if (editDistanceWithin(part, foldedTerm, 1) !== 1) continue;
        const found = toSuggestion(startFold, startFold + length, term, "typo", 1 + startFold / 1000);
        if (found && (!best || found.rank < best.rank)) best = found;
      }
    }
    if (best) candidates.push(best);
  }

  candidates.sort((left, right) => left.rank - right.rank || left.start - right.start);
  const selected: GlossarySuggestion[] = [];
  for (const candidate of candidates) {
    if (selected.some((chosen) => candidate.start < chosen.end && candidate.end > chosen.start)) continue;
    selected.push({
      id: candidate.id,
      start: candidate.start,
      end: candidate.end,
      original: candidate.original,
      replacement: candidate.replacement,
      kind: candidate.kind
    });
    if (selected.length >= limit) break;
  }
  return selected;
}

/** 用户确认后才调用：把建议的术语写回文本。 */
export function applyGlossarySuggestion(text: string, suggestion: GlossarySuggestion): string {
  const source = String(text ?? "");
  if (source.slice(suggestion.start, suggestion.end) !== suggestion.original) return source;
  return source.slice(0, suggestion.start) + suggestion.replacement + source.slice(suggestion.end);
}
