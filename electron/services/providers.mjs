import { transcriptionComputeMode, transcriptionDecodingOptions, transcriptionGpuBackend, whisperCliDecodingArgs, whisperCpuThreads, pythonDecodingOptions } from "../../shared/transcription-options.mjs";
import { summaryTemplateById } from "../../shared/summary-templates.mjs";
/**
 * 转录与纪要的模型调用层（Electron 主进程 / 服务层）。
 * 封装三类能力：远程 OpenAI 兼容接口的转录与纪要（含 New API 网关预设、
 * Anthropic / Gemini 原生协议）、本地 whisper.cpp / Python Whisper / faster-whisper /
 * mlx-whisper 转录，以及无 LLM 时的本地规则纪要与模型连通性测试。
 * 主要导出：resolveProviderEndpoint、validateSummary、buildSummaryPrompt、
 * summarizeWithOpenAICompatible、summarizeLocally、transcribeWithFasterWhisper、
 * transcribeWithMlxWhisper、transcribeRemote、transcribeWithPythonWhisper、
 * transcribeWithWhisperCpp、testModelProfile。
 * 被 main.mjs（transcription:chunk / summary:generate / models:test 通道）与
 * services/import-queue.mjs（导入流水线）调用。
 * 副作用：网络请求、拉起子进程（whisper.cpp / python / ffmpeg）、读写临时文件。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { initWhisper, loadWhisperModule } from "@fugood/whisper.node";
import { buildBasicKeyPoints, isStandaloneSummaryText, simplifySummary } from "./chinese.mjs";
import { testAppleSpeech, appleSpeechFixturePath } from "./apple-speech.mjs";
import { decodeWithSherpaAsr } from "./asr-runtime.mjs";
import { buildTranscriptionPrompt } from "./transcription-prompt.mjs";
import { parsePcmWav } from "./audio-quality.mjs";

function modelTranscriptionPrompt(profile, language, glossary, previousText) {
  return buildTranscriptionPrompt({
    language,
    glossary,
    previousText: profile.options?.usePreviousText === false ? undefined : previousText,
    initialPrompt: profile.options?.initialPrompt
  });
}

// ESM 下按需加载 CJS 原生模块（sherpa-onnx-node）。
const require = createRequire(import.meta.url);

/** 会议纪要 JSON 的 zod 校验 schema：模型输出先经它归一化（缺省字段补默认值）再进库。 */
const summarySchema = z.object({
  overview: z.string().optional(),
  discussionSections: z.array(z.object({
    title: z.string(),
    table: z.unknown().optional(),
    points: z.array(z.object({
      heading: z.string().optional(),
      text: z.string(),
      evidenceSegmentId: z.string().optional()
    }))
  })).optional(),
  topics: z.array(z.string()).default([]),
  // 关键结论兼容三种形态：纯字符串 / {text} / {text, headline?, evidenceTime|timeMs}；
  // validateSummary 里统一归一为字符串数组 + 平行的 keyPointTimes / keyPointHeadlines。
  keyPoints: z.array(z.union([
    z.string(),
    z.object({
      text: z.string(),
      headline: z.string().optional(),
      evidenceTime: z.string().optional(),
      timeMs: z.number().optional()
    })
  ])).default([]),
  decisions: z.array(z.string()).default([]),
  actionItems: z.array(z.object({
    id: z.string().optional(),
    title: z.string(),
    owner: z.string().optional().default("待确认"),
    dueDate: z.string().optional().default("待确认"),
    status: z.enum(["todo", "in_progress", "done"]).optional().default("todo"),
    done: z.boolean().optional().default(false),
    evidenceSegmentIds: z.array(z.string()).optional().default([])
  })).default([]),
  openQuestions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([])
});

const plainVisualText = (maximum = 240) => z.string().trim().min(1).max(maximum).refine(
  (value) => !/(?:<[^>]+>|```|https?:\/\/|^\s{0,3}#{1,6}\s)/im.test(value),
  "必须是纯文本，不能包含 HTML、Markdown 标题、代码围栏或 URL"
);

const visualCardSchema = z.object({
  title: plainVisualText(),
  status: plainVisualText(32).optional(),
  bullets: z.array(plainVisualText()).max(4).default([]),
  takeaway: plainVisualText().optional()
});

const visualSectionSchema = z.object({
  id: z.string().trim().min(1).max(48),
  // MiniMax 等兼容网关的模型常把序号序列化成字符串（"1"/"01"）；序号只是模型自报的
  // 展示顺序提示，校验后一律按数组顺序重排（见 validateVisualSummary），所以宽松接受，
  // 无法解析时兜底为 1，不为这种无害偏差拒绝整个视觉纪要。
  number: z.coerce.number().int().min(1).max(5).catch(1),
  title: plainVisualText(80),
  tone: z.enum(["coral", "amber", "violet", "green"]),
  layout: z.enum(["table", "cards", "callout"]),
  table: z.object({
    columns: z.array(plainVisualText(40)).min(2).max(4),
    rows: z.array(z.array(plainVisualText(160)).min(2).max(4)).max(5)
  }).optional(),
  cards: z.array(visualCardSchema).min(1).max(4).optional(),
  callout: plainVisualText().optional()
}).superRefine((section, context) => {
  if (section.layout === "table") {
    if (!section.table) context.addIssue({ code: "custom", message: "table 章节缺少 table 数据" });
    else if (section.table.rows.some((row) => row.length !== section.table.columns.length)) {
      context.addIssue({ code: "custom", message: "table 行列数量不一致" });
    }
  }
  if (section.layout === "cards" && !section.cards?.length) {
    context.addIssue({ code: "custom", message: "cards 章节缺少卡片" });
  }
  if (section.layout === "callout" && !section.callout) {
    context.addIssue({ code: "custom", message: "callout 章节缺少结论" });
  }
});

const visualSummarySchema = z.object({
  // schemaVersion 同样容忍字符串形态的 "1"；真正的版本错配（如 2）仍然拒绝。
  schemaVersion: z.coerce.number().pipe(z.literal(1)).default(1),
  title: plainVisualText(100),
  subtitle: plainVisualText(180),
  sections: z.array(visualSectionSchema).min(1).max(5)
});

/** 视觉纪要能力的稳定配置指纹；不包含密钥。 */
export function visualSummaryProfileFingerprint(profile) {
  return JSON.stringify({
    transport: profile.transport,
    baseUrl: normalizeBaseUrl(String(profile.baseUrl ?? "")),
    model: String(profile.model ?? "").trim(),
    apiFlavor: profile.options?.apiFlavor ?? "openai",
    chatEndpoint: profile.options?.chatEndpoint ?? ""
  });
}

/** 只有用户显式开启、成功验证且配置未变化时才允许第二阶段视觉请求。 */
export function isVisualSummaryProfileVerified(profile) {
  return Boolean(
    profile?.options?.visualSummaryEnabled
    && profile.options.visualSummaryVerifiedAt
    && profile.options.visualSummaryVerifiedFingerprint === visualSummaryProfileFingerprint(profile)
  );
}

/** 校验并规范视觉纪要 JSON，章节序号由校验层按显示顺序重排。 */
export function validateVisualSummary(value, metadata = {}) {
  const result = visualSummarySchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "根对象"} ${issue.message}`)
      .join("；");
    throw new Error(`模型返回的视觉纪要结构不合法（${issues}）。`);
  }
  const generatedAt = metadata.generatedAt ?? new Date().toISOString();
  const normalized = simplifySummary({ visualSummary: result.data }).visualSummary;
  return {
    ...normalized,
    sections: normalized.sections.map((section, index) => ({ ...section, number: index + 1 })),
    generatedAt,
    sourceSummaryUpdatedAt: metadata.sourceSummaryUpdatedAt ?? generatedAt,
    stale: false,
    providerProfileId: metadata.providerProfileId
  };
}

/** 去除 baseUrl 尾部斜杠（兼容用户把带 / 或不带 / 的地址粘进配置）。 */
const normalizeBaseUrl = (value) => value.trim().replace(/\/+$/, "");

/**
 * 解析 OpenAI 兼容接口的完整请求 URL。
 * 兼容性兜底：override（用户自定义端点）可以是完整 URL 或相对路径；
 * baseUrl 可能已经带上了端点路径或 /v1 前缀，均不做二次拼接；
 * 普通情况自动补 /v1 段（v1/v1beta/openai/v1 视为已有前缀）。
 */
function apiUrl(profile, endpoint, override) {
  if (override) {
    if (/^https?:\/\//i.test(override)) return override;
    return `${normalizeBaseUrl(profile.baseUrl)}/${override.replace(/^\/+/, "")}`;
  }
  const raw = normalizeBaseUrl(profile.baseUrl);
  const endpointPath = endpoint.replace(/^\/+/, "");
  if (raw.endsWith(`/${endpointPath}`)) return raw;
  const url = new URL(raw);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/(v\d+(?:beta)?|openai\/v\d+)$/i.test(pathname)) pathname += "/v1";
  url.pathname = `${pathname}/${endpointPath}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

/** 把 apiUrl 以 resolveProviderEndpoint 名称导出（供测试/其他模块复用端点解析逻辑）。 */
export const resolveProviderEndpoint = apiUrl;
/**
 * 构造鉴权请求头：Azure OpenAI 使用 api-key 头而非 Bearer Token（兼容性差异），
 * 其余 OpenAI 兼容服务统一走 Authorization: Bearer。
 */
const authorizationHeaders = (profile, apiKey) => {
  if (!apiKey) return {};
  return profile.baseUrl.includes(".openai.azure.com")
    ? { "api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
};

/** 解析 Anthropic / Gemini 原生协议的请求 URL（不做 /v1 自动补全，路径由协议规定）。 */
function nativeProviderEndpoint(profile, pathname, override) {
  if (override) {
    if (/^https?:\/\//i.test(override)) return override;
    return `${normalizeBaseUrl(profile.baseUrl)}/${override.replace(/^\/+/, "")}`;
  }
  return `${normalizeBaseUrl(profile.baseUrl)}/${pathname.replace(/^\/+/, "")}`;
}

/** 合并外部取消信号与超时：任一触发即中止 fetch。 */
function requestSignal(signal, timeoutMs) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

/** 调用 Anthropic Messages API（x-api-key 头 + anthropic-version），副作用：网络请求。
    extraBody.stream=true 时返回原始 Response（SSE 流），由调用方逐行读取。 */
async function requestAnthropic(profile, apiKey, prompt, maxTokens = 8_192, signal, extraBody = {}, label = "总结模型请求失败") {
  const response = await fetch(nativeProviderEndpoint(profile, "v1/messages", profile.options?.chatEndpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...(profile.options?.headers ?? {})
    },
    body: JSON.stringify({
      model: profile.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      system: "只输出可解析的 JSON。",
      messages: [{ role: "user", content: prompt }],
      ...extraBody
    }),
    signal: requestSignal(signal, profile.options?.timeoutMs ?? (extraBody.stream ? 300_000 : 60_000))
  });
  if (!response.ok) throw new Error(`${label}：${friendlyHttpError(
    response.status,
    await response.text(),
    response.headers?.get?.("x-request-id") ?? response.headers?.get?.("request-id")
  )}`);
  return extraBody.stream ? response : response.json();
}

/** 调用 Gemini generateContent API（x-goog-api-key 头，强制 JSON MIME 输出），副作用：网络请求。
    extraBody.stream=true 时改走 streamGenerateContent?alt=sse 并返回原始 Response。 */
async function requestGemini(profile, apiKey, prompt, maxTokens = 8_192, signal, extraBody = {}, label = "总结模型请求失败") {
  const model = encodeURIComponent(profile.model);
  const action = extraBody.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const response = await fetch(nativeProviderEndpoint(profile, `v1beta/models/${model}:${action}`, profile.options?.chatEndpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      ...(profile.options?.headers ?? {})
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "只输出可解析的 JSON。" }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json"
      }
    }),
    signal: requestSignal(signal, profile.options?.timeoutMs ?? (extraBody.stream ? 300_000 : 60_000))
  });
  if (!response.ok) throw new Error(`${label}：${friendlyHttpError(
    response.status,
    await response.text(),
    response.headers?.get?.("x-request-id") ?? response.headers?.get?.("request-id")
  )}`);
  return extraBody.stream ? response : response.json();
}

/**
 * 用 zod schema 校验并归一化纪要 JSON，字段缺失补默认值，格式不符抛出用户可读的错误
 * （原始 ZodError 是结构化对象，直接透传会得到一坨无法阅读的 JSON）。
 */
/** "12:34" / "1:02:03" 证据时间（转录行开头的时间戳）→ 毫秒；解析不了返回 null。 */
export function parseEvidenceTimeMs(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;
  const [hours, minutes, seconds] = parts.length === 3 ? numbers : [0, ...numbers];
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** 把「要点标题｜结论正文」的行内约定拆成 { headline, text }：
 *  没有竖线、标题为空/超长（>24 字）或正文为空时原样返回（headline 为 null）。 */
export function splitKeyPointHeadline(text) {
  const bar = text.indexOf("｜");
  if (bar < 0) return { headline: null, text };
  const headline = text.slice(0, bar).trim();
  const rest = text.slice(bar + 1).trim();
  if (!headline || !rest || headline.length > 24) return { headline: null, text };
  return { headline, text: rest };
}

/** 把模型返回的混合形态关键结论归一为 { texts, times, headlines }
 *  （times/headlines 与 texts 逐位对齐，无对应值时为 null；显式 headline 字段优先，
 *  否则解析 text 里的「标题｜正文」约定）。 */
function normalizeKeyPointDrafts(drafts) {
  const texts = [];
  const times = [];
  const headlines = [];
  const push = (rawText, explicitHeadline, timeMs, evidenceTime) => {
    const split = splitKeyPointHeadline(rawText);
    const headline = explicitHeadline?.trim() || split.headline || "";
    texts.push(split.text);
    times.push(timeMs ?? evidenceTime ?? null);
    headlines.push(headline && headline !== split.text.trim() ? headline.slice(0, 24) : null);
  };
  for (const draft of drafts) {
    if (typeof draft === "string") {
      push(draft, null, null, null);
      continue;
    }
    if (draft && typeof draft === "object" && typeof draft.text === "string") {
      push(draft.text, typeof draft.headline === "string" ? draft.headline : null,
        typeof draft.timeMs === "number" && draft.timeMs >= 0 ? draft.timeMs : null,
        parseEvidenceTimeMs(draft.evidenceTime));
    }
  }
  return { texts, times, headlines };
}

/** 模型偶尔把字符串列表项包成对象（{text|content|title|summary|description}）或塞 null：schema 校验前先归一成字符串数组。 */
function coerceStringList(value) {
  if (!Array.isArray(value)) return value;
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const text = item.text ?? item.content ?? item.title ?? item.summary ?? item.description ?? item.item;
        if (typeof text === "string") return text;
      }
      return null;
    })
    .filter((item) => typeof item === "string" && item.trim());
}

/** 行动项常见变体归一：标题别名、负责人别名、中文/英文状态值；无法辨认的字段落默认值。 */
function coerceActionItems(value) {
  if (!Array.isArray(value)) return value;
  const pickString = (item, keys) => {
    for (const key of keys) {
      const text = item?.[key];
      if (typeof text === "string" && text.trim()) return text.trim();
    }
    return null;
  };
  const statusMap = [
    [/^(done|finished|completed|已完成|完成)$/i, "done"],
    [/^(in_progress|doing|ongoing|进行中|办理中)$/i, "in_progress"]
  ];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const title = pickString(item, ["title", "text", "content", "task", "action", "item"]);
      if (!title) return null;
      const rawStatus = pickString(item, ["status", "state"]);
      const status = statusMap.find(([pattern]) => pattern.test(rawStatus ?? ""))?.[1] ?? "todo";
      return {
        ...item,
        title,
        owner: pickString(item, ["owner", "assignee", "person", "负责人"]) ?? "待确认",
        dueDate: pickString(item, ["dueDate", "due", "deadline", "期限", "时间"]) ?? "待确认",
        status
      };
    })
    .filter(Boolean);
}

export function validateSummary(value) {
  const result = summarySchema.safeParse({
    ...value,
    overview: typeof value?.overview === "string" ? value.overview : undefined,
    discussionSections: summarySchema.shape.discussionSections.safeParse(value?.discussionSections).data,
    topics: coerceStringList(value?.topics),
    decisions: coerceStringList(value?.decisions),
    openQuestions: coerceStringList(value?.openQuestions),
    risks: coerceStringList(value?.risks),
    nextSteps: coerceStringList(value?.nextSteps),
    actionItems: coerceActionItems(value?.actionItems)
  });
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "根对象"} ${issue.message}`)
      .join("；");
    throw new Error(`模型返回的纪要结构不合法（${issues}），请重试或换用兼容性更好的模型。`);
  }
  // 本机归纳（summarizeLocally）已经在输入里带好平行的 keyPointTimes / keyPointHeadlines；
  // zod 会剥掉未知字段，所以从原始输入取回，预置值优先，模型返回只补空位。
  const presetTimes = Array.isArray(value?.keyPointTimes) ? value.keyPointTimes : null;
  const presetHeadlines = Array.isArray(value?.keyPointHeadlines) ? value.keyPointHeadlines : null;
  const { texts, times, headlines } = normalizeKeyPointDrafts(result.data.keyPoints);
  const keyPointTimes = texts.map((_, index) => {
    if (presetTimes && typeof presetTimes[index] === "number" && presetTimes[index] >= 0) {
      return presetTimes[index];
    }
    return times[index];
  });
  const keyPointHeadlines = texts.map((_, index) => {
    if (presetHeadlines && typeof presetHeadlines[index] === "string" && presetHeadlines[index].trim()) {
      return String(presetHeadlines[index]).trim().slice(0, 24);
    }
    return headlines[index];
  });
  // 本机归纳没有标题层：全空时不写数组，行渲染保持单行形态。
  const summaryExtras = keyPointHeadlines.some(Boolean) ? { keyPointHeadlines } : {};
  return simplifySummary({ ...result.data, keyPoints: texts, keyPointTimes, ...summaryExtras });
}

/**
 * 在线纪要的最小内容下限：结构合法但所有条目为空视为模型没有完成任务，
 * 抛错走本机兜底，绝不用空结果清掉已有纪要。
 */
function validateOnlineSummary(value, sources) {
  const summary = validateSummary(value);
  const ids = new Map(sources.filter((source) => source.id).flatMap(({ id, label }) => [[label, id], [id, id]]));
  summary.discussionSections = summary.discussionSections?.map((section) => ({
    ...section,
    points: section.points.map((point) => ({
      ...point,
      evidenceSegmentId: ids.get(point.evidenceSegmentId ?? "")
    }))
  }));
  summary.actionItems = summary.actionItems.map((item) => ({
    ...item,
    evidenceSegmentIds: [...new Set(item.evidenceSegmentIds.map((reference) => ids.get(reference.trim())).filter(Boolean))]
  }));
  const times = new Map();
  for (const { time, timeMs } of sources) {
    const second = parseEvidenceTimeMs(time);
    if (second !== null && timeMs !== null && !times.has(second)) times.set(second, timeMs);
  }
  summary.keyPointTimes = summary.keyPointTimes?.map((time) =>
    typeof time === "number" ? times.get(Math.floor(time / 1000) * 1000) ?? null : null
  );
  for (const field of ["risks", "nextSteps"]) {
    summary[field] = summary[field].filter((item) => !isTranscriptReviewBoilerplate(item));
  }
  const hasContent = Boolean(summary.overview || summary.discussionSections?.length)
    || ["keyPoints", "decisions", "actionItems", "openQuestions", "nextSteps", "risks"]
      .some((key) => (summary[key] ?? []).length > 0);
  if (!hasContent) {
    const snippet = String(JSON.stringify(value)).slice(0, 100);
    console.error(`[summary] 模型返回了全空纪要，原始片段：${String(JSON.stringify(value)).slice(0, 300)}`);
    throw new Error(`总结模型返回了空纪要（所有条目为空），模型输出开头：${snippet}`);
  }
  return summary;
}

function isTranscriptReviewBoilerplate(item) {
  return /^(?:录音(?:转录|转写)?|转录|转写)(?:内容|文本)?(?:过于|较为)?(?:简短|不完整|不清晰|信息不足)|^关键主体、事项和依据未明确|^(?:补充或重听|重新听取|补齐)(?:会议)?录音|^在关键信息明确前.{0,16}(?:正式决策|正式依据)/.test(item.trim());
}

const MAX_TRANSCRIPT_PROMPT_CHARS = 30_000;
const SUMMARY_CONTEXT_FIELDS = ["topics", "keyPoints", "decisions", "actionItems", "openQuestions", "risks", "nextSteps"];

function selectSummaryTranscript(lines, keepTimeline) {
  if (lines.reduce((length, line) => length + line.text.length + 1, 0) <= MAX_TRANSCRIPT_PROMPT_CHARS) {
    return { lines, notice: "" };
  }

  // 长会分布取样留出更多中段入口，避免逐组汇报只剩少数时段的开头。
  const windowCount = keepTimeline ? Math.min(18, lines.length) : 1;
  const budget = Math.floor((MAX_TRANSCRIPT_PROMPT_CHARS - 100) / windowCount);
  const selected = [];
  for (let window = 0; window < windowCount; window += 1) {
    const group = lines.slice(Math.floor(lines.length * window / windowCount), Math.floor(lines.length * (window + 1) / windowCount));
    const fromEnd = window === windowCount - 1;
    if (fromEnd) group.reverse();
    let remaining = budget;
    const excerpt = [];
    for (const line of group) {
      if (remaining <= 1) break;
      if (line.text.length + 1 > remaining && excerpt.length) break;
      // 窗口首行超预算时会被截断：必须按「实际压入的长度」扣减预算，
      // 用原始长度会把 remaining 扣成负数，导致这一窗口后续证据行全被丢掉。
      const clipped = line.text.slice(0, remaining - 1);
      excerpt.push({ ...line, text: clipped });
      remaining -= clipped.length + 1;
    }
    if (fromEnd) excerpt.reverse();
    selected.push(...excerpt);
  }
  const notice = keepTimeline
    ? "（转录过长，以下为会议前、中、后各阶段摘录。只归纳可见证据。）"
    : "（转录过长，以下为最近一段转录。较早的进展可参考上一版纪要。）";
  return { lines: selected, notice };
}

/** 只传有助于本次归纳的普通纪要条目，避免视觉纪要与旧的草稿措辞污染终稿。 */
function summaryDraftContext(previous = {}, onlyLocked = false) {
  const locks = new Set(Array.isArray(previous.manualLocks) ? previous.manualLocks : []);
  return Object.fromEntries(SUMMARY_CONTEXT_FIELDS.flatMap((field) => {
    const values = Array.isArray(previous[field]) ? previous[field] : [];
    const kept = values.filter((value, index) => {
      if (!onlyLocked) return typeof value !== "string" || !isTranscriptReviewBoilerplate(value);
      if (field === "topics") return locks.has("topics");
      if (field === "actionItems") return locks.has(`action:${value?.id}`);
      return locks.has(`${field}:${index}`);
    });
    return kept.length ? [[field, kept.slice(0, 12)]] : [];
  }));
}

function buildSummaryRequest(input, final) {
  const source = input.transcript.flatMap((segment, index) => {
    if (!segment.text.trim() || segment.status === "provisional") return [];
    const label = `S${index + 1}`;
    const time = formatTime(segment.startMs);
    return [{
      id: segment.id,
      label,
      time,
      timeMs: Number.isFinite(segment.startMs) ? segment.startMs : null,
      text: `[${label} ${time}] ${segment.speakerName || "发言人"}: ${segment.text}`
    }];
  });
  const previous = summaryDraftContext(input.previousSummary);
  const hasDraft = Object.keys(previous).length > 0;
  const transcript = selectSummaryTranscript(source, final || !hasDraft);
  const locked = summaryDraftContext(input.previousSummary, true);
  const template = summaryTemplateById(input.template);
  const prompt = [
    "你在为没有参加会议的同事写简体中文纪要。读完应能直接回答：哪个事项到了什么状态，定下了什么，还卡在哪里，接下来谁做什么。",
    final
      ? "生成会后纪要。按事项合并各时段的讨论，将最重要的结果、变化和阻塞排在前面。"
      : "请只根据新增内容更新滚动纪要。合并对同一事项的重复汇报，已明确的新状态替换旧状态，仍有效的结论继续保留。",
    `本次纪要模板：${template.label}。${template.guidance}`,
    "每条写成可独立读懂的句子。写出项目、指标或交付物的名称，用具体动作和结果代替「这个、这块、相关工作、持续推进」。保留能说明变化的基线、现值、数量、单位、口径和日期。只有上下文能明确指代时才补出名称。听不清的专名、数字或单位不得猜测；不确定且重要的事实放入未决问题。",
    "只输出一个 JSON 对象。结构：topics, keyPoints, decisions, actionItems, openQuestions, risks, nextSteps。这七个字段是数组，有依据才填写，避免同一句在各节重复。",
    "可增加 overview 字符串：一到两句交代会议范围、整体结果和最重要的限制，省略寒暄、过程性套话与纯议程复述。",
    ...(final ? [
      '会后另输出 discussionSections 数组，格式为 [{"title":"议题","points":[{"heading":"对象或小结","text":"可独立读懂的事实和背景","evidenceSegmentId":"S12"}]}]。章节按讨论主题组织，短会内容稀少可省略。多单位逐一汇报时，请在同一章节中为每个有实质内容的单位单列小结，不能把不同单位的完成值、预计值或缺口合并。复用同一单位小结保留关键指标、口径、卡点与时间；多个独立事项可以拆开。证据编号只从下方转录行复制，没有证据时省略该字段。',
      "按实际讨论命名章节与小结。访谈优先呈现观察、困难和待验证问题；项目会议区分已完成、预计、目标与缺口；涉及规范时保留适用条件和例外。区分已确认事实、建议与未决判断。只有不同对象确实可以按同一组字段并列比较时，才在对应章节添加可选 table 对象，含 columns（2–5 个列标题）和 rows（至少两个同宽字符串数组）。缺失值用空字符串，保留原始单位和统计口径；关键判断的转录依据仍通过 points 提供。"
    ] : []),
    [
      "topics：至多 4 个具体议题名称。",
      'keyPoints：优先写 3–6 条关键结果，信息不足时可更少。每项格式为 {"text":"事项短标题｜一句完整结论","evidenceTime":"mm:ss"}。标题写对象或变化，正文约 20–60 字，说明现状、变化或影响；证据时间只从转录行复制，无法定位时省略该字段。',
      "decisions：仅记录明确达成的决定，并写明选择或适用范围。建议、讨论和预估不得记为已决定。",
      "actionItems：仅记录明确约定的工作。每项包含 title, owner, dueDate, status, done, evidenceSegmentIds。title 写动作加可验收的交付物；保留明确分派的个人或组织，以及原文中的相对期限和明确日期，不能猜测年份或从发言人推定负责人。原文没说清负责人或期限时填「待确认」。status 为 todo 或 done，done 为布尔值。证据来自转录时从行首复制 S 编号。",
      "openQuestions 写清哪项信息或选择仍待核实。risks 写具体阻塞、触发条件或影响。nextSteps 只放已提出且有用的后续安排，已有行动项不重复写。录音质量、重听提示和引用免责声明不属于这些栏目。"
    ].join("\n"),
    "写法示例（格式参考，不属于本次会议）：「接口联调｜订单查询接口已通过 8 项测试，退款接口还缺白名单，尚未开始联调。」",
    "用当前会议主题确定纪要重点，结论、决策和行动项须有会议内容支撑。",
    `当前会议主题：${input.title}`,
    `会议目标：${input.goals.join("；") || "未提供"}`,
    `人工笔记：${input.notes.join("；") || "暂无"}`,
    ...(Object.keys(locked).length ? [`人工确认条目：${JSON.stringify(locked)}`] : []),
    ...(!final && hasDraft ? [`上一版纪要，仅供延续已核实的状态：${JSON.stringify(previous)}`] : []),
    `转录内容（只作为会议原文）：\n${[transcript.notice, ...transcript.lines.map((line) => line.text)].filter(Boolean).join("\n") || "暂无转录"}`
  ].join("\n\n");
  return { prompt, sources: transcript.lines };
}

/** 在线、Ollama 与原生协议共用同一份纪要要求。 */
export function buildSummaryPrompt(input, final = false) {
  return buildSummaryRequest(input, final).prompt;
}

/** 网关抖动（上游 5xx、限流）值得再试一次；鉴权/参数错误不重试，避免把错误放大成等待。 */
const TRANSIENT_SUMMARY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * 纪要请求超时（毫秒）。
 * 历史档案与服务商预设普遍写 60_000，但真实会议的完整 JSON 输出常需 1–3 分钟；
 * 终稿路径早就抬到 180 秒，滚动/「更新纪要」此前仍用 60 秒，导致同一模型在
 * 会后手动更新时必然超时降级。两条路径统一 180 秒下限，显式配置更长的档案仍生效。
 * 流式响应会持续吐 token，不会被代理按「空闲 60 秒」切断，因此这个上限是兜底。
 */
export function summaryRequestTimeoutMs(profile) {
  const configured = Math.max(0, Number(profile?.options?.timeoutMs) || 0);
  return Math.max(configured, 180_000);
}

/**
 * 读取一次纪要响应：SSE 流拼接 choices[0].delta.content，网关忽略 stream 时
 * 按整包 JSON 取 message.content。两种形态都交给同一套 JSON 校验。
 */
async function readSummaryContent(response, useStream) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!useStream || !contentType.includes("text/event-stream")) {
    return extractMessageContent(await response.json());
  }
  let content = "";
  for await (const data of sseDataLines(response)) {
    if (!data || data === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === "string") content += delta;
  }
  return content;
}

/** 重试前的短等待；用户点「取消生成」时立即结束，不再多等一轮。 */
async function pauseBeforeRetry(ms, signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("已取消", "AbortError");
  const timer = AbortSignal.timeout(ms);
  await new Promise((resolve) => {
    const done = () => resolve();
    timer.addEventListener("abort", done, { once: true });
    signal?.addEventListener("abort", done, { once: true });
  });
  if (signal?.aborted) throw signal.reason ?? new DOMException("已取消", "AbortError");
}

/**
 * 调用在线模型生成会议纪要（summary:generate 与导入流水线调用）。副作用：网络请求。
 * apiFlavor 为 anthropic / gemini 时走原生协议，其余走 OpenAI 兼容 chat/completions。
 *
 * OpenAI 兼容路径默认用 SSE 流式：不少企业网关（本次实测的内网 aistore 即如此）
 * 对「整包等响应」有 60 秒硬上限，长会议必然在 60 秒被切成 504；流式响应会持续
 * 吐 token，连接不会被代理按空闲切断（同一提示词实测非流式 504、流式 200/91 秒）。
 * 网关不支持 stream / response_format / max_tokens 时按报错信息逐个去掉并重试；
 * 5xx/429/连接抖动原样重试一次；不认 SSE 但返回整包 JSON 的网关也能兜住。
 * @param {object} profile LLM 模型档案
 * @param {string} apiKey 经 secrets.mjs 解出的密钥
 * @param {object} input 会议上下文
 * @returns {Promise<object>} 经 validateSummary 归一化后的纪要对象
 */
export async function summarizeWithOpenAICompatible(profile, apiKey, input, final = false, signal) {
  const { prompt, sources } = buildSummaryRequest(input, final);
  if (profile.options?.apiFlavor === "anthropic" || profile.options?.apiFlavor === "gemini") {
    const payload = profile.options.apiFlavor === "anthropic"
      ? await requestAnthropic(profile, apiKey, prompt, 8_192, signal)
      : await requestGemini(profile, apiKey, prompt, 8_192, signal);
    const content = extractMessageContent(payload);
    if (!content) throw new Error("总结模型没有返回内容。");
    return validateOnlineSummary(JSON.parse(extractJson(content)), sources);
  }
  const endpoint = apiUrl(profile, "chat/completions", profile.options?.chatEndpoint);
  const timeoutMs = summaryRequestTimeoutMs(profile);
  let useStream = true;
  let useResponseFormat = true;
  let transientRetries = 0;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = {
        model: profile.model,
        temperature: 0.2,
        // 不给输出设上限：推理型模型会把思维链一起计入 max_tokens，截断后
        // 拿到的就是半截 JSON。流式本身已解决 60 秒网关上限，无需再限长。
        ...(useStream ? { stream: true } : {}),
        messages: [
          { role: "system", content: "只输出可解析的 JSON。" },
          { role: "user", content: prompt }
        ]
      };
      if (useResponseFormat) body.response_format = { type: "json_object" };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 部分网关依据 Accept 决定是否走 SSE。
          ...(useStream ? { Accept: "text/event-stream" } : {}),
          ...authorizationHeaders(profile, apiKey),
          ...(profile.options?.headers ?? {})
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        const bodyText = await response.text();
        // 网关错误页常是整页 HTML（甚至内联 base64 图片），直接拼进错误会把几万字符
        // 塞进 Toast。统一走 friendlyHttpError：只留状态码、中文归因与可读摘要。
        const error = new Error(`总结模型请求失败：${friendlyHttpError(
          response.status,
          bodyText,
          response.headers?.get?.("x-request-id") ?? response.headers?.get?.("request-id")
        )}`);
        const unsupported = [400, 404, 422].includes(response.status)
          || /response_format|stream/i.test(bodyText);
        if (unsupported && (useStream || useResponseFormat)) {
          // 报错点名哪个参数就只去掉哪个；泛化的 400 一次退到最小请求体。
          if (/response_format/i.test(bodyText)) useResponseFormat = false;
          if (/stream/i.test(bodyText)) useStream = false;
          if (!/response_format|stream/i.test(bodyText)) {
            useStream = false;
            useResponseFormat = false;
          }
          error.retry = "immediate";
        } else if (TRANSIENT_SUMMARY_STATUSES.has(response.status) && transientRetries < 1) {
          transientRetries += 1;
          error.retry = "pause";
        }
        throw error;
      }
      const content = await readSummaryContent(response, useStream);
      if (!content) {
        // 声称支持 SSE 却一个 token 都不给：退回最小请求体再试一次。
        useStream = false;
        useResponseFormat = false;
        const empty = new Error("总结模型没有返回内容。");
        empty.retry = "immediate";
        throw empty;
      }
      return validateOnlineSummary(JSON.parse(extractJson(content)), sources);
    } catch (error) {
      if (signal?.aborted) throw error;
      // AbortSignal.timeout 抛的是 TimeoutError：已经等满上限，别再重试一次，
      // 但要把英文 DOMException 换成用户能看懂、能操作的提示。
      if (error?.name === "TimeoutError") {
        throw new Error(`总结模型请求超时（${Math.round(timeoutMs / 1000)} 秒）：请稍后重试，或在「设置 → AI 总结」换用响应更快的模型。`);
      }
      if (!error.retry && error instanceof TypeError
        && /fetch failed|network|ECONN|socket|timed out/i.test(String(error.message))
        && transientRetries < 1) {
        transientRetries += 1;
        error.retry = "pause";
      }
      if (!error.retry || attempt === 2) throw error;
      lastError = error;
      if (error.retry === "pause") await pauseBeforeRetry(900, signal);
    }
  }
  throw lastError;
}

/**
 * AI 问答的系统提示词：把会议元信息、纪要与转写压成上下文。
 * 转写文本由渲染层负责截断（只保留最近片段），这里不再二次裁剪。
 */
export function buildChatSystemPrompt(context) {
  return [
    "你是 MinuteFlow 的会议问答助手，根据下方会议材料回答用户关于这场会议的问题。",
    "要求：使用简体中文；优先依据会议内容作答，条目简短；引用发言时注明发言人；",
    "会议材料中没有的信息要明确说明“会议中没有提到”，不要编造。",
    "下方转写每行以 [mm:ss] 开头。回答涉及具体发言、决定或行动项时，在相应句子末尾附上原文时间戳，格式严格为 [mm:ss]（长会议可用 [h:mm:ss]），界面会把它们变成可点击的回链；只引用转写里真实出现过的时间戳，不要推测或编造。",
    "回答行动项时说明负责人与截止时间，材料里没写的用「待确认」标注。",
    "回答会按 Markdown 渲染：可用简短列表、加粗和小标题组织内容，不要输出表格、HTML 或长代码块。",
    `会议标题：${String(context.title ?? "")}`,
    `参与者：${Array.isArray(context.participants) ? context.participants.join("、") : ""}`,
    `会议目标：${Array.isArray(context.goals) ? context.goals.join("；") || "（未填写）" : ""}`,
    `个人笔记：${Array.isArray(context.notes) ? context.notes.join("\n") || "（无）" : ""}`,
    `当前会议纪要（JSON）：${JSON.stringify(context.summary ?? {})}`,
    "转写记录：",
    String(context.transcriptText ?? "")
  ].join("\n");
}

/**
 * AI 问答（chat:send 调用）：带最近几轮历史向模型提问，流式返回 { content, reasoning }。
 * onDelta 收到的是「可立即渲染」的增量片段（见 createChatStreamAccumulator）：
 * 正文增量已剔除内联 <think> 与半截标签，reasoning 增量覆盖 reasoning_content /
 * thinking_delta / thought 片段三种思维链形态。网关不支持 stream 时整包 JSON
 * 会作为一次增量下发，前端表现退化为一次性显示。
 * 与总结路径的关键差异：不做 JSON 解析、不带 response_format；
 * anthropic / gemini 原生协议没有多轮转发通道，把历史压成单条提示词文本。
 */
export async function chatWithMeetingContext(profile, apiKey, { question, history = [], context }, onDelta, signal) {
  const systemPrompt = buildChatSystemPrompt(context);
  const accumulator = createChatStreamAccumulator();
  const emit = (delta) => {
    if (!onDelta) return;
    const next = accumulator.push(delta);
    if (next.content || next.reasoning) onDelta(next);
  };
  // 流式问答给长思考模型更宽的窗口（5 分钟下限）。旧档案普遍存 60_000，
  // 那会把「思考 1 分钟以上」的模型整条流掐断；显式配置更长的档案仍生效。
  const streamTimeoutMs = Math.max(Number(profile.options?.timeoutMs) || 0, 300_000);
  const finishOrThrow = () => {
    const result = accumulator.finish();
    if (!result.content) throw new Error("问答模型没有返回内容。");
    return result;
  };

  if (profile.options?.apiFlavor === "anthropic" || profile.options?.apiFlavor === "gemini") {
    const prompt = [
      systemPrompt,
      ...history.map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.text}`),
      `用户：${question}`,
      "请直接回答最后一条用户问题。"
    ].join("\n\n");
    const isAnthropic = profile.options.apiFlavor === "anthropic";
    const response = isAnthropic
      ? await requestAnthropic(profile, apiKey, prompt, 2_048, signal, { stream: true }, "问答模型请求失败")
      : await requestGemini(profile, apiKey, prompt, 2_048, signal, { stream: true }, "问答模型请求失败");
    const contentType = response.headers.get("content-type") ?? "";
    const emitGeminiChunk = (chunk) => {
      for (const part of (chunk?.candidates ?? []).flatMap((candidate) => candidate?.content?.parts ?? [])) {
        if (typeof part?.text !== "string" || !part.text) continue;
        emit(part.thought === true ? { reasoning: part.text } : { content: part.text });
      }
    };
    if (contentType.includes("text/event-stream")) {
      for await (const data of sseDataLines(response)) {
        if (!data || data === "[DONE]") continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (isAnthropic) {
          if (payload?.type !== "content_block_delta") continue;
          const delta = payload.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") emit({ content: delta.text });
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") emit({ reasoning: delta.thinking });
        } else {
          emitGeminiChunk(payload);
        }
      }
    } else {
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (Array.isArray(payload)) {
        for (const chunk of payload) emitGeminiChunk(chunk);
      } else {
        const result = extractChatResponse(payload);
        emit({ content: result.content, reasoning: result.reasoning });
      }
    }
    return finishOrThrow();
  }

  const endpoint = apiUrl(profile, "chat/completions", profile.options?.chatEndpoint);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 部分网关依据 Accept 头决定是否走 SSE；显式声明避免被当普通 JSON 整包返回。
      "Accept": "text/event-stream",
      ...authorizationHeaders(profile, apiKey),
      ...(profile.options?.headers ?? {})
    },
    body: JSON.stringify({
      model: profile.model,
      temperature: 0.3,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((item) => ({ role: item.role, content: item.text })),
        { role: "user", content: question }
      ]
    }),
    signal: requestSignal(signal, streamTimeoutMs)
  });
  if (!response.ok) {
    throw new Error(`问答模型请求失败：${friendlyHttpError(
      response.status,
      await response.text(),
      response.headers.get("x-request-id") ?? response.headers.get("request-id")
    )}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for await (const data of sseDataLines(response)) {
      if (!data || data === "[DONE]") continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      const delta = payload?.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) emit({ reasoning });
      if (typeof delta.content === "string" && delta.content) emit({ content: delta.content });
    }
  } else {
    // 网关忽略 stream 参数时整包返回 JSON：作为一次增量下发，前端退化为一次性显示。
    const payload = await response.json();
    const result = extractChatResponse(payload);
    emit({ content: result.content, reasoning: result.reasoning });
  }
  return finishOrThrow();
}

/** 第二阶段视觉纪要提示词：只消费普通纪要和会议元信息，不重复上传转录或音频。 */
export function buildVisualSummaryPrompt(input) {
  return [
    "你是中文信息设计师。请把已经确认的结构化会议纪要整理成一张可由应用原生排版的视觉纪要。",
    "只输出 JSON，不要输出 Markdown、HTML、URL、CSS、图片或解释。所有文本必须是简体中文。",
    "schemaVersion 必须为 1；包含 title、subtitle、sections。sections 最多 5 个。",
    "每个 section 包含 id、number、title、tone、layout。tone 只能是 coral/amber/violet/green；layout 只能是 table/cards/callout。",
    "table: columns 2–4 个、rows 最多 5 行且列数一致。cards: 1–4 张，每张含 title、可选 status、bullets 最多 4 条、可选 takeaway。callout: 一句最终结论。",
    "不要为了套模板编造对比项、负责人、日期、状态或结论。没有自然对比时优先使用 cards。",
    `会议标题：${String(input.title ?? "")}`,
    `参与者：${Array.isArray(input.participants) ? input.participants.join("、") : ""}`,
    `普通纪要：${JSON.stringify(input.summary ?? {})}`
  ].join("\n\n");
}

/** 调用已验证的在线总结模型生成视觉纪要 schema。 */
export async function generateVisualSummaryWithOpenAICompatible(profile, apiKey, input, signal) {
  const prompt = buildVisualSummaryPrompt(input);
  let content;
  if (profile.options?.apiFlavor === "anthropic" || profile.options?.apiFlavor === "gemini") {
    const payload = profile.options.apiFlavor === "anthropic"
      ? await requestAnthropic(profile, apiKey, prompt, 8_192, signal)
      : await requestGemini(profile, apiKey, prompt, 8_192, signal);
    content = extractMessageContent(payload);
  } else {
    const endpoint = apiUrl(profile, "chat/completions", profile.options?.chatEndpoint);
    const timeoutMs = summaryRequestTimeoutMs(profile);
    // 与普通纪要共用流式策略：企业网关对整包响应常有 60 秒硬上限，视觉纪要
    // 也必须用 SSE 才能跑完。网关不支持 stream 时按报错回退到最小请求体。
    let useStream = true;
    let useResponseFormat = true;
    let transientRetries = 0;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const body = {
          model: profile.model,
          temperature: 0.15,
          ...(useStream ? { stream: true } : {}),
          messages: [
            { role: "system", content: "只输出符合要求的视觉纪要 JSON。" },
            { role: "user", content: prompt }
          ]
        };
        if (useResponseFormat) body.response_format = { type: "json_object" };
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(useStream ? { Accept: "text/event-stream" } : {}),
            ...authorizationHeaders(profile, apiKey),
            ...(profile.options?.headers ?? {})
          },
          body: JSON.stringify(body),
          signal: requestSignal(signal, timeoutMs)
        });
        if (!response.ok) {
          const bodyText = await response.text();
          const error = new Error(`视觉纪要模型请求失败：${friendlyHttpError(
            response.status,
            bodyText,
            response.headers?.get?.("x-request-id") ?? response.headers?.get?.("request-id")
          )}`);
          const unsupported = [400, 404, 422].includes(response.status)
            || /response_format|stream/i.test(bodyText);
          if (unsupported && (useStream || useResponseFormat)) {
            if (/response_format/i.test(bodyText)) useResponseFormat = false;
            if (/stream/i.test(bodyText) || !/response_format|stream/i.test(bodyText)) {
              useStream = false;
              useResponseFormat = false;
            }
            error.retry = "immediate";
          } else if (TRANSIENT_SUMMARY_STATUSES.has(response.status) && transientRetries < 1) {
            transientRetries += 1;
            error.retry = "pause";
          }
          throw error;
        }
        content = await readSummaryContent(response, useStream);
        if (content) break;
        useStream = false;
        useResponseFormat = false;
        const empty = new Error("视觉纪要模型没有返回内容。");
        empty.retry = "immediate";
        throw empty;
      } catch (error) {
        if (signal?.aborted || !error.retry || attempt === 2) throw error;
        lastError = error;
        if (error.retry === "pause") await pauseBeforeRetry(900, signal);
      }
    }
    if (!content && lastError) throw lastError;
  }
  if (!content) throw new Error("视觉纪要模型没有返回内容。");
  return validateVisualSummary(JSON.parse(extractJson(content)), {
    sourceSummaryUpdatedAt: input.summary?.updatedAt,
    providerProfileId: profile.id
  });
}

/** 按中英文句末标点（。！？!?…）切分句子，供本地规则纪要做句子级匹配。 */
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?…])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * 本地规则纪要兜底（无 LLM 配置、显式选择离线纪要或在线总结失败降级时使用，纯 CPU、无网络）。
 * 用关键词从最近 120 段转录里提取决策、行动、风险与未决问题。
 * @param {object} input 会议上下文
 * @returns {object} 经 validateSummary 归一化后的纪要对象
 */
export function summarizeLocally(input) {
  const recent = input.transcript.filter((segment) => segment.status === "final").slice(-120);
  const decisionPattern = /(?:^|[，,：:\s])(?:决定|決定|确认采用|同意|一致同意|确定采用|結論是|结论是)/;
  const actionPattern = /负责|負責|(?:将|要|需要|请|待|尽快|之前|以前)(?:.{0,16})(?:完成|跟进|跟進|提交|输出|輸出|整理|评估|評估|邀请|邀請)/;
  const questionPattern = /[？?]$/;
  const riskPattern = /(风险|風險|延期|阻塞|合规|合規|隐患|隱患|来不及|來不及)/;

  // Match at sentence granularity (split on Chinese/English terminal punctuation)
  // so a single long segment containing several points yields individual
  // decisions, actions, and questions instead of one undifferentiated block.
  const sentences = recent.flatMap((segment) =>
    splitSentences(segment.text).filter(isStandaloneSummaryText).map((sentence) => ({
      text: sentence,
      speakerName: segment.speakerName,
      segmentId: segment.id
    }))
  );

  const keyDrafts = buildBasicKeyPoints(recent);

  return validateSummary({
    topics: input.previousSummary?.topics?.length
      ? input.previousSummary.topics
      : input.goals.slice(0, 3),
    keyPoints: keyDrafts.map((draft) => draft.text).slice(-8),
    keyPointTimes: keyDrafts.map((draft) => draft.timeMs ?? null).slice(-8),
    decisions: Array.from(new Set([
      ...sentences.filter((unit) => !questionPattern.test(unit.text) && decisionPattern.test(unit.text)).map((unit) => unit.text)
    ])).slice(-5),
    actionItems: Array.from(new Map([
      ...sentences
        .filter((unit) => !questionPattern.test(unit.text) && actionPattern.test(unit.text))
        .slice(-3)
        .map((unit) => ({
          id: randomUUID(),
          title: unit.text,
          owner: unit.speakerName && (unit.text.startsWith(`${unit.speakerName}负责`)
            || unit.text.startsWith("我负责") && !/^发言人/.test(unit.speakerName)) ? unit.speakerName : "待确认",
          dueDate: "待确认",
          status: "todo",
          done: false,
          evidenceSegmentIds: [unit.segmentId]
        }))
    ].map((item) => [item.title, item])).values()).slice(-8),
    openQuestions: Array.from(new Set([
      ...sentences.filter((unit) => questionPattern.test(unit.text)).map((unit) => unit.text)
    ])).slice(-5),
    risks: Array.from(new Set([
      ...sentences.filter((unit) => riskPattern.test(unit.text) && !isTranscriptReviewBoilerplate(unit.text)).map((unit) => unit.text)
    ])).slice(-5),
    nextSteps: []
  });
}

// 以下两段是传给 Python 子进程的内置脚本：结果以 JSON 打印到 stdout 最后一行，由主进程解析。
// faster-whisper（CTranslate2）与 mlx-whisper 共用同一个执行框架 transcribeWithPythonPackage。
//
// faster-whisper (CTranslate2) and mlx-whisper both run as Python packages and
// accept either a local model directory or a Hugging Face repo id. They decode
// audio themselves, but converting to 16k mono WAV via FFmpeg first avoids a
// hard dependency on pyav/torchaudio being installed alongside the package.
const FASTER_WHISPER_SCRIPT = [
  "import json, sys",
  "from faster_whisper import WhisperModel",
  "device = {'cpu': 'cpu', 'gpu': 'cuda'}.get(sys.argv[6], 'auto')",
  "model = WhisperModel(sys.argv[1], device=device, compute_type='auto')",
  "options = json.loads(sys.argv[5])",
  "options.setdefault('vad_filter', True)",
  "segments, info = model.transcribe(sys.argv[2], language=sys.argv[3] or None, initial_prompt=sys.argv[4] or None, **options)",
  "materialized = [{'start': float(s.start), 'end': float(s.end), 'text': (s.text or '').strip(), 'avg_logprob': getattr(s, 'avg_logprob', None), 'no_speech_prob': getattr(s, 'no_speech_prob', None), 'compression_ratio': getattr(s, 'compression_ratio', None)} for s in segments]",
  "print(json.dumps({'text': ' '.join(s['text'] for s in materialized), 'language': getattr(info, 'language', None), 'segments': materialized}, ensure_ascii=False))"
].join("\n");

/** mlx-whisper（Apple Silicon 专用 MLX 后端）的 Python 内置脚本，输出格式与 faster-whisper 一致。 */
const MLX_WHISPER_SCRIPT = [
  "import json, sys",
  "import mlx_whisper",
  "if sys.argv[6] != 'auto':",
  "    import mlx.core as mx",
  "    mx.set_default_device(mx.gpu if sys.argv[6] == 'gpu' else mx.cpu)",
  "options = json.loads(sys.argv[5])",
  "result = mlx_whisper.transcribe(sys.argv[2], path_or_hf_repo=sys.argv[1], language=sys.argv[3] or None, initial_prompt=sys.argv[4] or None, **options)",
  "segments = [{'start': float(s.get('start', 0)), 'end': float(s.get('end', 0)), 'text': (s.get('text') or '').strip(), 'avg_logprob': s.get('avg_logprob'), 'no_speech_prob': s.get('no_speech_prob'), 'compression_ratio': s.get('compression_ratio')} for s in result.get('segments', [])]",
  "print(json.dumps({'text': (result.get('text') or '').strip(), 'language': result.get('language'), 'segments': segments}, ensure_ascii=False))"
].join("\n");

/**
 * Qwen3-ASR（实验性）的 Python 内置脚本：qwen-asr 包（transformers 后端），
 * 输出格式与 faster-whisper 兼容（segments 留空，按整块出文）。模型路径是应用内
 * 下载的 bundle 目录；显式绑定到当前 Python 环境可用的 CUDA / MPS。
 */
const QWEN3_ASR_SCRIPT = [
  "import json, sys, torch",
  "from qwen_asr import Qwen3ASRModel",
  "lang_map = {'zh': 'Chinese', 'en': 'English', 'yue': 'Cantonese', 'ja': 'Japanese', 'ko': 'Korean'}",
  "raw_language = (sys.argv[3] or '').strip()",
  "language = lang_map.get(raw_language, raw_language) or None",
  "device = 'cuda:0' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else None",
  "if device is None: raise RuntimeError('Qwen3-ASR 需要 NVIDIA CUDA 或 Apple Silicon MPS。')",
  "model = Qwen3ASRModel.from_pretrained(sys.argv[1], dtype='auto', device_map=device)",
  "result = model.transcribe(audio=sys.argv[2], language=language)",
  "if isinstance(result, str):",
  "    text = result",
  "elif isinstance(result, (list, tuple)):",
  "    text = ' '.join((item.get('text') if isinstance(item, dict) else getattr(item, 'text', item if isinstance(item, str) else '')) or '' for item in result)",
  "else:",
  "    text = getattr(result, 'text', None) or (result.get('text') if isinstance(result, dict) else '') or str(result)",
  "print(json.dumps({'text': (text or '').strip(), 'language': raw_language or None, 'segments': []}, ensure_ascii=False))"
].join("\n");

/**
 * Python 系本地转录的公共执行流程（faster-whisper / mlx-whisper 共用）。
 * 副作用：写临时音频文件、拉起 ffmpeg 与 Python 子进程、结束前清理临时文件。
 * 流程：原始音频落临时文件 →（可选）FFmpeg 转 16k 单声道 WAV →
 * 运行内嵌 Python 脚本（模型路径、语言、术语表提示作为 argv 传入）→ 解析 JSON。
 * @returns {Promise<{text: string, segments: Array, duration?: number}>}
 */
async function transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, script, previousText = "") {
  const modelPath = profile.options?.modelPath;
  const pythonPath = profile.options?.pythonExecutablePath
    || profile.options?.executablePath
    || (process.platform === "win32" ? "python" : "python3");
  if (!modelPath) throw new Error("请先选择本地模型目录或填写 Hugging Face 仓库 ID。");
  const prompt = modelTranscriptionPrompt(profile, language, glossary, previousText);
  const inputPath = path.join(tmpdir(), `${randomUUID()}-${fileName}`);
  let wavePath = inputPath;
  await writeFile(inputPath, audioBuffer);
  const environment = { ...process.env };
  if (profile.options?.ffmpegPath) {
    environment.PATH = `${path.dirname(profile.options.ffmpegPath)}${path.delimiter}${environment.PATH ?? ""}`;
    wavePath = `${inputPath}.wav`;
    await runProcess(profile.options.ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath], { signal });
  }
  try {
    const { stdout } = await runProcess(pythonPath, [
      "-c", script, modelPath, wavePath, language ?? "", prompt,
      JSON.stringify(pythonDecodingOptions(profile)), transcriptionComputeMode(profile.options?.computeMode)
    ], { env: environment, signal });
    const payload = JSON.parse(stdout.trim().split("\n").pop());
    const segments = (payload.segments ?? [])
      .map((segment) => ({
        startMs: Math.round((Number(segment.start) || 0) * 1000),
        endMs: Math.round((Number(segment.end) || 0) * 1000),
        text: String(segment.text ?? "").trim(),
        // 原始置信度信号透传，由 withSegmentConfidence 统一折算成 0–1。
        avgLogprob: segment.avg_logprob,
        noSpeechProb: segment.no_speech_prob,
        compressionRatio: segment.compression_ratio
      }))
      .filter((segment) => segment.text);
    return {
      text: (payload.text ?? segments.map((segment) => segment.text).join(" ")).trim(),
      // 自动识别模式下把本块语种交给队列锁定，后续块不再逐块重新检测。
      language: payload.language ?? language,
      segments,
      duration: segments.length ? Math.max(...segments.map((segment) => segment.endMs)) / 1000 : undefined
    };
  } finally {
    await Promise.allSettled([unlink(inputPath), wavePath !== inputPath && unlink(wavePath)]);
  }
}

/** faster-whisper（CTranslate2）转录入口，委托 transcribeWithPythonPackage 执行。 */
export async function transcribeWithFasterWhisper(profile, audioBuffer, fileName, language = "zh", glossary = [], signal, previousText = "") {
  assertTranscriptionGpuSupported(profile);
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, FASTER_WHISPER_SCRIPT, previousText);
}

/** mlx-whisper 转录入口：仅 Apple Silicon macOS 可用，其余平台直接报错。 */
export async function transcribeWithMlxWhisper(profile, audioBuffer, fileName, language = "zh", glossary = [], signal, previousText = "") {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("MLX-Whisper 仅在 Apple Silicon macOS 上可用。");
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, MLX_WHISPER_SCRIPT, previousText);
}

/**
 * Qwen3-ASR（实验性）转录入口：Python + qwen-asr 运行时，需要 NVIDIA GPU（Windows）
 * 或 Apple Silicon MPS（macOS）；无 GPU 的场景已被 resolveLocalModelProfile 就绪检查挡下。
 */
export async function transcribeWithQwen3Asr(profile, audioBuffer, fileName, language = "zh", glossary = [], signal, previousText = "") {
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, QWEN3_ASR_SCRIPT, previousText);
}

/**
 * 可中断的退避等待：调用方取消（信号 abort）时立即以「任务已取消」拒绝，不再发起下一次尝试。
 */
function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("任务已取消。")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 远程转录在请求级重试耗尽后的断点续跑退避节奏：15s/30s/60s/120s，之后封顶 5 分钟。
 * 纯函数供导入队列（waiting_for_network 自动续跑）与测试复用；attempt 从 1 起计。
 */
export function nextTranscriptionResumeDelayMs(attempt) {
  return [15_000, 30_000, 60_000, 120_000][Math.max(1, attempt) - 1] ?? 300_000;
}

/**
 * 把非 2xx 响应转成可读错误文案：优先取 OpenAI 风格 error.message（New API 等网关
 * 会把内部数据库故障的 request id 写在里面），无法解析时保留响应原文。
 */
function describeTranscriptionFailure(response, bodyText) {
  let detail = String(bodyText ?? "").trim();
  try {
    const parsed = JSON.parse(detail);
    const error = parsed?.error ?? parsed;
    const message = typeof error === "string" ? error : (error?.message ?? error?.msg ?? "");
    if (message) detail = String(message).trim();
  } catch { /* 非 JSON 响应体，保留原文 */ }
  const requestId = response.headers?.get?.("x-request-id");
  if (requestId && !detail.includes(requestId)) detail += `（request id: ${requestId}）`;
  return `转录模型请求失败：${response.status} ${detail}`.trim();
}

/**
 * 远程转录（OpenAI 兼容 /audio/transcriptions 接口）。副作用：网络请求。
 * New API 是服务网关预设，仍使用同一 OpenAI 兼容端点，不存在独立的 New API 协议。
 * 响应形状做了容错（data/result 包裹、text/transcript 字段、JSON 或纯文本体均可）。
 * 自建网关偶发把瞬时数据库故障（如 SQLite 并发锁）包装成 500 返回：对 429/5xx/网络
 * 抖动做最多 3 次尝试（2s、8s 退避），避免一次瞬时错误暂停几百块的导入任务；
 * 4xx 配置类错误、调用方取消与 330 秒超时不重试。
 * @param {object} profile stt 模型档案
 * @param {string} apiKey 密钥（sherpa-onnx 等无密钥场景可为空）
 * @returns {Promise<{text: string, language?: string, duration?: number, segments: Array}>}
 */
export async function transcribeRemote(
  profile,
  apiKey,
  audioBuffer,
  fileName,
  language = "zh",
  glossary = [],
  signal,
  previousText = ""
) {
  // 远程语音识别可能需要等待冷启动或处理较长导入音频。应用端保证至少
  // 330 秒，比推荐的 DSM proxy_read_timeout=300s 多 30 秒缓冲；这也会覆盖旧档案中保存的 120s。
  const transcriptionTimeoutMs = Math.max(profile.options?.timeoutMs ?? 0, 330_000);
  const defaultResponseFormat = profile.options?.responseFormat
    ?? (profile.options?.apiFlavor === "new-api" || profile.model !== "whisper-1" ? "json" : "verbose_json");
  const extension = path.extname(String(fileName || "")).toLowerCase();
  const audioMimeType = ({
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac"
  })[extension] || "application/octet-stream";
  // 简体引导语 + 前文 + 术语表统一构造；此前远程链路只传术语表，中文用词的
  // 简繁与专名写法和本地引擎不一致。
  const prompt = modelTranscriptionPrompt(profile, language, glossary, previousText);
  const retryBackoffMs = [2_000, 8_000];
  let lastFailure;
  for (let attempt = 0; ; attempt += 1) {
    // FormData 每次尝试重建（Blob 可复用），保证前一次失败不会留下半消费的请求体。
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: audioMimeType }), fileName);
    form.append("model", profile.model);
    if (language) form.append("language", language);
    if (defaultResponseFormat !== "text") form.append("response_format", defaultResponseFormat);
    if (prompt) form.append("prompt", prompt);
    const decoding = transcriptionDecodingOptions(profile);
    if (decoding.temperature !== undefined) form.append("temperature", String(decoding.temperature));
    let response;
    try {
      response = await fetch(apiUrl(profile, "audio/transcriptions", profile.options?.transcriptionEndpoint), {
        method: "POST",
        headers: {
          ...authorizationHeaders(profile, apiKey),
          ...(profile.options?.headers ?? {})
        },
        body: form,
        signal: requestSignal(signal, transcriptionTimeoutMs)
      });
    } catch (error) {
      // 调用方取消（导入取消/退出）与 330 秒超时直接抛出；其余（fetch failed、
      // 连接重置等快速失败的网络抖动）进入退避重试。
      if (signal?.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") throw error;
      lastFailure = new Error(`转录模型请求失败：网络错误 ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response) {
      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        const payload = contentType.includes("json") ? await response.json() : { text: await response.text() };
        const result = payload.data ?? payload.result ?? payload;
        return {
          text: result.text ?? result.transcript ?? "",
          language: result.language ?? language,
          duration: result.duration,
          segments: (result.segments ?? []).map((segment) => ({
            startMs: Math.round((segment.start ?? 0) * 1000),
            endMs: Math.round((segment.end ?? segment.start ?? 0) * 1000),
            text: String(segment.text ?? "").trim(),
            avgLogprob: segment.avg_logprob,
            noSpeechProb: segment.no_speech_prob,
            compressionRatio: segment.compression_ratio
          })).filter((segment) => segment.text)
        };
      }
      lastFailure = new Error(describeTranscriptionFailure(response, await response.text()));
      // 4xx（鉴权/参数/额度配置）重试也不会成功，立即失败让用户去修配置。
      if (response.status !== 429 && response.status < 500) throw lastFailure;
    }
    if (attempt >= retryBackoffMs.length) {
      // retryable 标记供导入队列识别「值得自动断点续跑」的失败（4xx 配置类错误不带此标记）。
      lastFailure.retryable = true;
      lastFailure.message += `（已自动重试 ${attempt} 次仍失败）`;
      throw lastFailure;
    }
    await waitMs(retryBackoffMs[attempt], signal);
  }
}

/**
 * 拉起子进程并等待退出：超时强杀（默认 10 分钟，防挂死的 whisper 进程占住 IPC）、
 * 支持外部 AbortSignal（SIGTERM），stdout/stderr 全量收集用于解析或报错。
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runProcess(command, args, options = {}) {
  // Default to a generous bound so a wedged whisper process cannot hang the IPC
  // handler (and pile up audio blobs in the renderer) indefinitely. Callers
  // pass a smaller timeoutMs for quick checks like model tests.
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000;
  const { timeoutMs: _ignored, signal, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`本地模型进程超时（${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("任务已取消。"));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `本地模型进程退出，代码 ${code}`));
    });
  });
}

function assertTranscriptionGpuSupported(profile) {
  if (transcriptionComputeMode(profile.options?.computeMode) === "gpu"
    && !transcriptionGpuBackend(profile, process.platform, process.arch)) {
    throw new Error("当前引擎在此设备上不支持 GPU 模式。请在转录设置中切换到自动或 CPU。");
  }
}

/**
 * OpenAI Whisper 官方 Python 包的转录入口（.pt 检查点）。副作用：临时文件 + Python 子进程。
 * 强校验模型必须是 .pt 文件，与 whisper.cpp 的 GGML/GGUF 区分开；
 * ffmpegPath 配置时把其目录注入 PATH（whisper 依赖 ffmpeg 解码音频）。
 */
export async function transcribeWithPythonWhisper(
  profile,
  audioBuffer,
  fileName,
  language = "zh",
  glossary = [],
  signal,
  previousText = ""
) {
  assertTranscriptionGpuSupported(profile);
  const modelPath = profile.options?.modelPath;
  const pythonPath = profile.options?.pythonExecutablePath
    || profile.options?.executablePath
    || (process.platform === "win32" ? "python" : "python3");
  if (!modelPath) throw new Error("请先选择 OpenAI Whisper .pt 模型。");
  if (path.extname(modelPath).toLowerCase() !== ".pt") {
    throw new Error("Python Whisper 运行时需要 .pt 模型文件。");
  }
  const inputPath = path.join(tmpdir(), `${randomUUID()}-${fileName}`);
  await writeFile(inputPath, audioBuffer);
  const script = [
    "import json, sys, whisper",
    "mode = sys.argv[6]",
    "device = {'cpu': 'cpu', 'gpu': 'cuda'}.get(mode)",
    "if mode == 'gpu':",
    "    import torch",
    "    if not torch.cuda.is_available(): raise RuntimeError('GPU 模式需要支持 CUDA 的 PyTorch 和 NVIDIA 显卡驱动。')",
    "model = whisper.load_model(sys.argv[1], device=device) if device else whisper.load_model(sys.argv[1])",
    "options = {'verbose': False, 'fp16': False}",
    "if sys.argv[3]: options['language'] = sys.argv[3]",
    "if sys.argv[4]: options['initial_prompt'] = sys.argv[4]",
    "options.update(json.loads(sys.argv[5]))",
    "result = model.transcribe(sys.argv[2], **options)",
    "print(json.dumps({'text': result.get('text', ''), 'language': result.get('language'), 'segments': result.get('segments', [])}, ensure_ascii=False))"
  ].join("\n");
  const environment = { ...process.env };
  if (profile.options?.ffmpegPath) {
    environment.PATH = `${path.dirname(profile.options.ffmpegPath)}${path.delimiter}${environment.PATH ?? ""}`;
  }
  try {
    const { stdout } = await runProcess(pythonPath, [
      "-c",
      script,
      modelPath,
      inputPath,
      language,
      modelTranscriptionPrompt(profile, language, glossary, previousText),
      JSON.stringify(pythonDecodingOptions(profile)),
      transcriptionComputeMode(profile.options?.computeMode)
    ], { env: environment, signal });
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    const segments = (result.segments ?? []).map((segment) => ({
      startMs: Math.round(Number(segment.start ?? 0) * 1000),
      endMs: Math.round(Number(segment.end ?? segment.start ?? 0) * 1000),
      text: String(segment.text ?? "").trim(),
      avgLogprob: segment.avg_logprob,
      noSpeechProb: segment.no_speech_prob,
      compressionRatio: segment.compression_ratio
    })).filter((segment) => segment.text);
    return {
      text: String(result.text ?? "").trim(),
      language: result.language ?? language,
      segments,
      duration: segments.length ? Math.max(...segments.map((segment) => segment.endMs)) / 1000 : undefined
    };
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

/**
 * whisper.cpp 转录入口（外部可执行文件或应用托管运行时）。
 * 未配置 executablePath 时自动降级到 transcribeWithManagedWhisper（@fugood/whisper.node 进程内推理）。
 * 副作用：临时文件、ffmpeg/whisper 子进程。
 * @returns {Promise<{text: string, segments: Array, duration?: number}>}
 */
export async function transcribeWithWhisperCpp(
  profile,
  audioBuffer,
  fileName,
  language = "zh",
  glossary = [],
  signal,
  previousText = ""
) {
  const whisperPath = profile.options?.executablePath;
  const modelPath = profile.options?.modelPath;
  const ffmpegPath = profile.options?.ffmpegPath;
  if (!modelPath) {
    throw new Error("本地模型尚未就绪，请在转录设置中下载一个模型。");
  }
  if (!whisperPath) {
    return transcribeWithManagedWhisper(profile, audioBuffer, fileName, language, glossary, signal, previousText);
  }

  const inputPath = path.join(tmpdir(), `${randomUUID()}-${fileName}`);
  const wavePath = `${inputPath}.wav`;
  const outputBase = `${inputPath}-out`;
  await writeFile(inputPath, audioBuffer);
  try {
    // 先统一转成 16k 单声道 PCM WAV，这是 whisper.cpp 唯一可靠的输入格式；
    // 没有 ffmpeg 时只接受调用方已保证的 WAV 输入，其余直接报缺组件。
    if (ffmpegPath) {
      await runProcess(ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath], { signal });
    } else if (path.extname(fileName).toLowerCase() === ".wav") {
      await writeFile(wavePath, await readFile(inputPath));
    } else {
      throw new Error("音频处理组件尚未就绪，请重试或重新安装应用。");
    }
    const args = [
      "-m", modelPath,
      "-f", wavePath,
      // 空串代表「自动识别」：Python / 远程引擎接受空值，whisper.cpp 需要显式 auto。
      "-l", language || "auto",
      "-oj",
      "-of", outputBase
    ];
    // Whisper defaults to Traditional Chinese for Mandarin even with -l zh.
    // 简体引导语、前文上下文与术语表由统一模块按 token 预算组装，避免各引擎
    // 拼接顺序不一致，也避免长术语表把 prompt 撑爆后被 tokenizer 截断。
    const prompt = modelTranscriptionPrompt(profile, language, glossary, previousText);
    if (prompt) args.push("--prompt", prompt);
    if (transcriptionComputeMode(profile.options?.computeMode) === "cpu") args.push("--no-gpu");
    args.push(...whisperCliDecodingArgs(profile));
    await runProcess(whisperPath, args, { signal });
    const result = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
    const segments = (result.transcription ?? []).map((item) => ({
      startMs: Number(item.offsets?.from ?? item.start ?? 0),
      endMs: Number(item.offsets?.to ?? item.end ?? item.offsets?.from ?? 0),
      text: String(item.text ?? "").trim()
    })).filter((segment) => segment.text);
    return {
      text: segments.map((segment) => segment.text).join(" ").trim(),
      segments,
      duration: segments.length ? Math.max(...segments.map((segment) => segment.endMs)) / 1000 : undefined
    };
  } finally {
    await Promise.allSettled([
      unlink(inputPath),
      unlink(wavePath),
      unlink(`${outputBase}.json`)
    ]);
  }
}

/**
 * whisper.node 上下文按模型路径和设备常驻。此前每个 8/10 秒转录块都 initWhisper +
 * release，长会议会把几百 MB~数 GB 权重反复从磁盘载入上千次，补转队列永远追不上。
 * 同一上下文一次只能跑一个转录，用 promise 队列串行；空闲 5 分钟自动释放，
 * 避免模型常驻吃满内存。
 */
const WHISPER_IDLE_RELEASE_MS = 5 * 60 * 1000;
const whisperContexts = new Map();

function releaseWhisperContext(key, entry) {
  if (whisperContexts.get(key) !== entry || entry.pending || !entry.context) return;
  // 释放必须排进该 key 的任务队列，并等原生 release() 真正完成后才把 entry
  // 从表里移除：空闲计时触发与新任务进入之间有一个窗口，若先 delete 再异步
  // release，新任务会查不到 entry 而在旧 context 尚未释放时又 init 一份，
  // 同一模型的权重双份常驻，显存紧张时会 OOM。
  // 新任务若在释放期间进来，会排在释放之后执行并复用同一个 entry。
  const release = entry.queue.then(async () => {
    if (whisperContexts.get(key) !== entry || !entry.context) return;
    const context = entry.context;
    entry.context = null;
    await Promise.resolve(context?.release?.()).catch(() => {});
    // 只有原生释放彻底结束、期间无人复用，才允许删除表项。
    if (whisperContexts.get(key) === entry && !entry.context && !entry.pending) {
      whisperContexts.delete(key);
    }
  });
  entry.queue = release.then(() => {}, () => {});
}

function loadVulkanWhisper() {
  // whisper.node's public loader caches the first native variant process-wide.
  // Load Vulkan separately so switching from the default CPU library works without restarting.
  try {
    return require(`@fugood/node-whisper-win32-${process.arch}-vulkan`);
  } catch {
    throw new Error("无法加载 Whisper Vulkan。请检查显卡驱动，或在转录设置中切换到自动或 CPU。");
  }
}

async function withWhisperContext(profile, task) {
  const modelPath = profile.options.modelPath;
  const mode = transcriptionComputeMode(profile.options.computeMode);
  const backend = transcriptionGpuBackend(profile, process.platform, process.arch);
  const useGpu = mode === "gpu" || (mode === "auto" && backend === "metal");
  const useVulkan = useGpu && backend === "vulkan";
  const key = JSON.stringify([modelPath, useVulkan ? "vulkan" : useGpu ? "metal" : "cpu"]);
  let entry = whisperContexts.get(key);
  if (!entry) {
    entry = { context: null, queue: Promise.resolve(), pending: 0, idleTimer: null };
    whisperContexts.set(key, entry);
  }
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  entry.pending++;
  const run = entry.queue.then(async () => {
    if (!entry.context) {
      const options = { filePath: modelPath, useGpu, useFlashAttn: true };
      entry.context = useVulkan
        ? new (loadVulkanWhisper().WhisperContext)(options)
        : await initWhisper(options);
    }
    return task(entry.context);
  });
  entry.queue = run.then(() => {}, () => {});
  try {
    return await run;
  } finally {
    entry.pending--;
    if (!entry.pending) {
      entry.idleTimer = setTimeout(() => releaseWhisperContext(key, entry), WHISPER_IDLE_RELEASE_MS);
      entry.idleTimer.unref?.();
    }
  }
}

/**
 * 应用托管 whisper 运行时（@fugood/whisper.node）的进程内转录，零可执行文件配置。
 * 副作用：临时文件、ffmpeg 子进程、复用的进程内 whisper 上下文。
 * 支持取消：AbortSignal 触发时停止推理并抛"任务已取消"。
 */
async function transcribeWithManagedWhisper(profile, audioBuffer, fileName, language, glossary, signal, previousText = "") {
  assertTranscriptionGpuSupported(profile);
  const modelPath = profile.options?.modelPath;
  const ffmpegPath = profile.options?.ffmpegPath;
  if (!modelPath) throw new Error("本地模型尚未就绪，请在转录设置中下载一个模型。");
  await access(modelPath);

  const inputPath = path.join(tmpdir(), `${randomUUID()}-${fileName}`);
  const wavePath = `${inputPath}.wav`;
  const wave = parsePcmWav(audioBuffer);
  const pcm = wave?.sampleRate === 16_000 && wave.channels === 1
    ? audioBuffer.buffer.slice(audioBuffer.byteOffset + wave.start, audioBuffer.byteOffset + wave.start + wave.length - wave.length % 2)
    : undefined;
  let abort;
  try {
    if (!pcm) {
      if (ffmpegPath) {
        await writeFile(inputPath, audioBuffer);
        await runProcess(ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath], { signal });
      } else if (path.extname(fileName).toLowerCase() === ".wav") {
        await writeFile(wavePath, audioBuffer);
      } else {
        throw new Error("音频处理组件尚未就绪，请重试或重新安装应用。");
      }
    }

    const prompt = modelTranscriptionPrompt(profile, language, glossary, previousText);
    const decoding = transcriptionDecodingOptions(profile);
    const result = await withWhisperContext(profile, async (context) => {
      if (signal?.aborted) throw new Error("任务已取消。");
      const options = {
        // The native binding defaults to English when this option is omitted.
        language: language || "auto",
        prompt: prompt || undefined,
        // 未设置的参数沿用托管运行时默认值。原生绑定固定贪心策略，不暴露无效束宽。
        temperature: decoding.temperature,
        temperatureInc: decoding.temperatureStep,
        bestOf: decoding.bestOf,
        maxThreads: whisperCpuThreads(profile)
      };
      const job = pcm ? context.transcribeData(pcm, options) : context.transcribeFile(wavePath, options);
      abort = () => { void job.stop(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const value = await job.promise;
        if (signal?.aborted || value.isAborted) throw new Error("任务已取消。");
        return value;
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
        abort = undefined;
      }
    });
    const segments = (result.segments ?? []).map((segment) => ({
      // whisper.node already converts whisper.cpp's 10 ms units to milliseconds.
      startMs: Math.round(Number(segment.t0 ?? 0)),
      endMs: Math.round(Number(segment.t1 ?? segment.t0 ?? 0)),
      text: String(segment.text ?? "").trim()
    })).filter((segment) => segment.text);
    return {
      text: String(result.result ?? segments.map((segment) => segment.text).join(" ")).trim(),
      language: language || undefined,
      segments,
      duration: segments.length ? Math.max(...segments.map((segment) => segment.endMs)) / 1000 : undefined
    };
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    if (!pcm) await Promise.allSettled([unlink(inputPath), unlink(wavePath)]);
  }
}

/**
 * 测试模型档案是否可用（models:test 通道调用）。副作用：网络请求或子进程。
 * 各 transport 的就绪含义不同：本地运行时检查模型文件与组件可运行，
 * LLM 走一次最小请求确认连通，远程 stt 上传内置 WAV 确认真实转录端点。
 * @returns {Promise<{ok: true, message: string}>} 成功时带用户可读的提示
 */
/**
 * 网关 502/504 常返回整页 HTML（含内联 base64 图片、CSS、脚本），原样拼进错误消息会
 * 让 Toast 变成几万字符的乱码。这里只保留 <title> 与去标签后的可见文字，并丢掉长
 * base64 串；普通纯文本/JSON 响应走原路径。
 */
function readableErrorBody(bodyText) {
  const raw = String(bodyText ?? "").trim();
  if (!/^\s*(<!doctype|<html|<head|<body|<center|<h1)/i.test(raw)
    && !/<\/(html|body|head|title)>/i.test(raw)) return raw;
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  let visible = raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title && visible.startsWith(title)) visible = visible.slice(title.length).trim();
  return [title, visible].filter(Boolean).join(" · ").slice(0, 160);
}

/** 把 HTTP 错误响应翻译成可操作的中文提示：按状态码区分密钥/地址/限流/服务端四类常见原因，
 *  并尽量带上网关返回的 error.message 与 request id，方便用户拿着凭据去服务商侧排查。 */
export function friendlyHttpError(status, bodyText, requestId) {
  const advice = status === 401 || status === 403
    ? "密钥无效或无权限：请检查 API Key 是否正确，以及该密钥是否开通了所填模型"
    : status === 404
      ? "接口地址或模型名不存在：请检查 Base URL 与模型名"
      : status === 429
        ? "请求过于频繁或额度不足：请稍后重试，或检查账户余额与限流设置"
        : status >= 500
          ? "服务端暂时不可用：请稍后重试"
          : null;
  let detail = "";
  let extractedRequestId = requestId || null;
  if (typeof bodyText === "string" && bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText);
      const errorBody = parsed?.error;
      const message = typeof errorBody === "string" ? errorBody : errorBody?.message;
      if (message) detail = String(message);
      const bodyRequestId = parsed?.request_id || errorBody?.request_id;
      if (bodyRequestId) extractedRequestId = String(bodyRequestId);
    } catch {
      detail = readableErrorBody(bodyText);
    }
  }
  if (detail.length > 240) detail = `${detail.slice(0, 240)}…`;
  return [
    advice ? `${advice}（HTTP ${status}）` : `HTTP ${status}`,
    detail,
    extractedRequestId ? `请求标识 ${extractedRequestId}` : ""
  ].filter(Boolean).join(" · ");
}

/** 解析 OpenAI 兼容 /models 响应为模型 id 列表；容忍 data/models 包装与纯字符串项。 */
export function parseModelListPayload(payload) {
  const data = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
    : Array.isArray(payload) ? payload
    : [];
  return data
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        if (typeof item.id === "string") return item.id;
        if (typeof item.name === "string") return item.name;
      }
      return null;
    })
    .map((id) => (id || "").trim())
    .filter(Boolean)
    .slice(0, 200);
}

/** 拉取在线服务的可用模型列表（OpenAI 兼容与 Ollama 的 /models 同为 {data:[{id}]} 形状）。
 *  Anthropic/Gemini 原生协议返回 null，设置页据此退回静态推荐建议；
 *  网络/HTTP 失败抛出可读错误（含网关 request id）。 */
export async function listRemoteModels(profile, apiKey, signal) {
  if (profile.options?.apiFlavor === "anthropic" || profile.options?.apiFlavor === "gemini") return null;
  const response = await fetch(apiUrl(profile, "models"), {
    headers: {
      ...authorizationHeaders(profile, apiKey),
      ...(profile.options?.headers ?? {})
    },
    signal: requestSignal(signal, 10_000)
  });
  if (!response.ok) {
    throw new Error(friendlyHttpError(
      response.status,
      await response.text(),
      response.headers.get("x-request-id") ?? response.headers.get("request-id")
    ));
  }
  return parseModelListPayload(await response.json());
}

/** Ollama 专属：读取每个本地模型的磁盘体积（GET {base}/api/tags，尽力而为）。
 *  OpenAI 兼容的 /models 不带 size，只有 Ollama 原生端点提供；任何失败都返回空表，
 *  让设置页安静降级为「无大小标注」而不是报错。 */
export async function listOllamaModelSizes(profile, signal) {
  try {
    const base = (profile.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
    if (!/^https?:\/\//i.test(base)) return {};
    const response = await fetch(`${base}/api/tags`, { signal: requestSignal(signal, 4000) });
    if (!response.ok) return {};
    const payload = await response.json();
    const sizes = {};
    for (const model of Array.isArray(payload?.models) ? payload.models : []) {
      if (!model?.name || !Number.isFinite(model.size) || model.size <= 0) continue;
      sizes[model.name] = model.size;
      // Ollama 的 /v1/models 会把 "qwen3:4b:latest" 简写成 "qwen3:4b"，两种 id 都映射到同一体积。
      if (model.name.endsWith(":latest")) sizes[model.name.slice(0, -":latest".length)] = model.size;
    }
    return sizes;
  } catch {
    return {};
  }
}

/** 网络层错误（fetch failed/DNS/拒连/超时）翻译成可操作的中文提示，
 *  避免裸 TypeError 直接进设置页；LLM 测试与视觉纪要验证共用。 */
function rethrowFriendlyNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout|TIMEOUT/i.test(message)) {
    throw new Error("连接测试超时：请检查 Base URL 是否可达、密钥是否有效，或网络/代理设置。");
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(message)) {
    throw new Error("无法连接到该 Base URL：请检查地址是否正确、服务是否在线，以及网络/代理设置。");
  }
  throw error;
}

/** 在线 LLM 档案的连接测试主体：启用视觉纪要时先跑真实验证请求，
 *  否则按原生协议 / OpenAI 兼容聊天接口做最小探测。 */
async function testLlmProfileConnection(profile, apiKey) {
  if (profile.options?.visualSummaryEnabled) {
    await generateVisualSummaryWithOpenAICompatible(profile, apiKey, {
      title: "视觉纪要能力测试",
      participants: ["测试参与者"],
      summary: {
        topics: ["连接验证"],
        keyPoints: ["模型需要返回受限的视觉纪要 JSON。"],
        decisions: ["验证 schema 后启用视觉纪要。"],
        actionItems: [],
        openQuestions: [],
        risks: [],
        nextSteps: ["保存验证结果。"],
        updatedAt: new Date().toISOString()
      }
    });
    const visualSummaryVerifiedAt = new Date().toISOString();
    return {
      ok: true,
      message: "模型调用与视觉纪要结构验证均成功。",
      visualSummaryVerifiedAt,
      visualSummaryVerifiedFingerprint: visualSummaryProfileFingerprint(profile)
    };
  }
  if (profile.options?.apiFlavor === "anthropic" || profile.options?.apiFlavor === "gemini") {
    const payload = profile.options.apiFlavor === "anthropic"
      ? await requestAnthropic(profile, apiKey, "只回复 OK", 16)
      : await requestGemini(profile, apiKey, "只回复 OK", 16);
    if (!extractMessageContent(payload)) throw new Error("连接成功，但模型没有返回消息内容。");
    return { ok: true, message: "模型调用成功，原生接口可用。" };
  }
  const response = await fetch(apiUrl(profile, "chat/completions", profile.options?.chatEndpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeaders(profile, apiKey),
      ...(profile.options?.headers ?? {})
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: "user", content: "只回复 OK" }],
      max_tokens: 4,
      temperature: 0
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(friendlyHttpError(
      response.status,
      await response.text(),
      response.headers.get("x-request-id") ?? response.headers.get("request-id")
    ));
  }
  const payload = await response.json();
  if (!extractMessageContent(payload)) throw new Error("连接成功，但模型没有返回兼容的消息内容。");
  return { ok: true, message: "模型调用成功，接口兼容。" };
}

export async function testModelProfile(profile, apiKey) {
  if (profile.transport === "local-summary") {
    return { ok: true, message: "本机基础纪要已就绪，完全离线运行，无需联网或密钥。" };
  }
  if (profile.transport === "whisper-cpp") {
    if (!profile.options?.modelPath) {
      throw new Error("本地模型尚未就绪，请先下载一个模型。");
    }
    await access(profile.options.modelPath);
    if (!profile.options?.executablePath) {
      try {
        await loadWhisperModule();
      } catch (error) {
        throw new Error(`本地转写组件无法加载：${error instanceof Error ? error.message : "请重新安装应用。"}`);
      }
      if (!profile.options?.ffmpegPath) throw new Error("音频处理组件尚未就绪，请重试或重新安装应用。");
      await access(profile.options.ffmpegPath);
      return { ok: true, message: "本地模型与转写组件已就绪。" };
    }
    // Preserve compatibility with profiles created before the managed runtime.
    try {
      await runProcess(profile.options.executablePath, ["--help"], { timeoutMs: 8_000 });
    } catch (error) {
      throw new Error(`无法运行 whisper.cpp：${error instanceof Error ? error.message : "请检查可执行文件路径与权限。"}`);
    }
    return { ok: true, message: "本地模型与兼容转写组件已就绪。" };
  }
  if (profile.transport === "whisper-python") {
    const pythonPath = profile.options?.pythonExecutablePath
      || profile.options?.executablePath
      || (process.platform === "win32" ? "python" : "python3");
    if (!profile.options?.modelPath) throw new Error("请选择 .pt 模型文件。");
    await access(profile.options.modelPath);
    const result = await runProcess(pythonPath, ["-c", "import whisper; print(whisper.__version__)"], { timeoutMs: 15_000 });
    return { ok: true, message: `Python Whisper 已就绪（${result.stdout.trim() || "版本未知"}）。` };
  }
  if (profile.transport === "apple-speech") {
    // 真实识别测试：转录随包中文样例（对齐「连接测试必须跑真实请求」的约定），
    // 首次测试会触发系统「语音识别」授权弹窗（归属 MinuteFlow）。
    const fixturePath = appleSpeechFixturePath();
    if (!fixturePath) throw new Error("Apple 语音识别测试样例缺失，请重新安装应用。");
    const result = await testAppleSpeech(fixturePath, "zh-CN", {
      allowServer: profile.options?.allowServer === true
    });
    if (!result.available) throw new Error("Apple 语音识别组件缺失，请重新安装 MinuteFlow。");
    const preview = result.text.replace(/\s+/g, " ").slice(0, 24);
    return {
      ok: true,
      message: `Apple 语音识别已就绪（${result.onDeviceUsed ? "本机识别" : "在线识别"}，样例输出「${preview}…」）。`
    };
  }
  if (profile.transport === "sense-voice" || profile.transport === "parakeet-tdt") {
    // 真实识别测试：用内置中文样例跑一次完整解码（与 apple-speech 的「测试识别」
    // 同一约定——连接测试必须跑真实请求），同时验证 bundle 文件齐全与 worker 可用。
    const label = profile.transport === "sense-voice" ? "SenseVoice" : "Parakeet";
    if (!profile.options?.modelPath) throw new Error("本地模型尚未就绪，请先在转录设置中下载模型。");
    const fixturePath = appleSpeechFixturePath();
    if (!fixturePath) throw new Error("识别测试样例缺失，请重新安装应用。");
    const result = await decodeWithSherpaAsr(profile, fixturePath, {
      language: profile.transport === "sense-voice" ? "zh" : "",
      numThreads: 2
    });
    const preview = String(result?.text ?? "").replace(/\s+/g, " ").slice(0, 24);
    return {
      ok: true,
      message: `${label} 已就绪（样例输出「${preview || "（无文本）"}」）。`
    };
  }
  if (profile.transport === "qwen3-asr") {
    // 实验性引擎：测试 = Python 依赖 + GPU 设备 + 模型目录三项检查，不跑真实推理
    // （0.6B 模型首次加载需要数十秒，不适合放进设置页的同步测试）。
    if (!profile.options?.modelPath) throw new Error("本地模型尚未就绪，请先在转录设置中下载模型。");
    await access(profile.options.modelPath);
    const pythonPath = profile.options?.pythonExecutablePath
      || profile.options?.executablePath
      || (process.platform === "win32" ? "python" : "python3");
    try {
      await runProcess(pythonPath, ["-c", "import torch, qwen_asr"], { timeoutMs: 30_000 });
    } catch (error) {
      throw new Error(`未检测到 Qwen3-ASR 运行时，请先安装：pip install "qwen-asr" torch${error instanceof Error && error.message ? `（${error.message}）` : ""}`);
    }
    let device = "";
    try {
      const probe = await runProcess(pythonPath, ["-c", "import torch; print('cuda' if torch.cuda.is_available() else ('mps' if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available() else 'cpu'))"], { timeoutMs: 30_000 });
      device = probe.stdout.trim();
    } catch {
      device = "cpu";
    }
    if (device !== "cuda" && device !== "mps") {
      throw new Error("Qwen3-ASR 需要 GPU（NVIDIA CUDA 或 Apple Silicon）；当前 Python torch 仅 CPU 可用，无法启用。");
    }
    return {
      ok: true,
      message: `Qwen3-ASR 运行时就绪（${device === "cuda" ? "NVIDIA GPU" : "Apple Silicon MPS"}）。首次识别需要加载模型，会稍慢。`
    };
  }
  if (profile.transport === "faster-whisper" || profile.transport === "mlx-whisper") {
    const label = profile.transport === "faster-whisper" ? "faster-whisper" : "mlx-whisper";
    if (profile.transport === "mlx-whisper" && process.platform !== "darwin") {
      throw new Error("MLX-Whisper 仅在 Apple Silicon macOS 上可用。");
    }
    if (!profile.options?.modelPath) throw new Error("请选择本地模型目录或填写 Hugging Face 仓库 ID。");
    const pythonPath = profile.options?.pythonExecutablePath
      || profile.options?.executablePath
      || (process.platform === "win32" ? "python" : "python3");
    try {
      await runProcess(pythonPath, ["-c", `import ${label.replace("-", "_")}`], { timeoutMs: 20_000 });
    } catch (error) {
      throw new Error(`未检测到 ${label}，请先安装：pip install ${label}${error instanceof Error && error.message ? `（${error.message}）` : ""}`);
    }
    return { ok: true, message: `${label} 已就绪，模型路径已配置。` };
  }
  if (profile.transport === "sherpa-onnx") {
    // 实际运行时是进程内 sherpa-onnx-node npm 包（diarization.mjs），不存在外部可执行文件：
    // 测试 = npm 包可加载且两个模型文件真实存在，与运行路径完全一致。文案与零路径设置页一致，
    // 不出现“配置路径”字样。
    if (!profile.options?.segmentationModelPath || !profile.options?.embeddingModelPath) {
      const missing = [
        !profile.options?.segmentationModelPath && "说话人分离模型",
        !profile.options?.embeddingModelPath && "声纹识别模型"
      ].filter(Boolean);
      throw new Error(`${missing.join("和")}尚未就绪，请在声纹识别页下载或检测本机。`);
    }
    let sherpaOnnx;
    try {
      sherpaOnnx = require("sherpa-onnx-node");
    } catch {
      throw new Error("内置声纹引擎无法加载，请重新安装应用。");
    }
    if (!sherpaOnnx.OfflineSpeakerDiarization || !sherpaOnnx.readWave) {
      throw new Error("内置声纹引擎组件不完整，请重新安装应用。");
    }
    for (const [label, filePath] of [
      ["说话人分离模型", profile.options.segmentationModelPath],
      ["声纹识别模型", profile.options.embeddingModelPath]
    ]) {
      try {
        await access(filePath);
      } catch {
        throw new Error(`${label}文件不存在或已被移动，请重新下载或检测本机。`);
      }
    }
    return { ok: true, message: "声纹识别已就绪：内置引擎与两个模型均已加载。" };
  }
  if (profile.transport === "openai-audio") {
    // 连接测试必须快速失败：正式转录沿用 330 秒超时，但设置页点一下「测试连接」
    // 等五分半毫无反馈，等于"没反应"。20 秒内端点没返回就明确报超时。
    try {
      await transcribeRemote(
        profile,
        apiKey,
        createTranscriptionTestWave(),
        "minuteflow-connection-test.wav",
        "",
        [],
        AbortSignal.timeout(20_000)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout|TIMEOUT/i.test(message)) {
        throw new Error("连接测试超时（20 秒）：请检查 Base URL 是否可达、密钥是否有效，或网络/代理设置。");
      }
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(message)) {
        throw new Error("无法连接到该 Base URL：请检查地址是否正确、服务是否在线，以及网络/代理设置。");
      }
      throw error;
    }
    return { ok: true, message: "测试音频转录成功，接口可用。" };
  }
  if (profile.kind === "llm") {
    // 视觉纪要验证/聊天探测的网络层失败统一翻译，HTTP 层失败已在内部走 friendlyHttpError。
    return testLlmProfileConnection(profile, apiKey).catch(rethrowFriendlyNetworkError);
  }
  const response = await fetch(apiUrl(profile, "models"), {
    headers: {
      ...authorizationHeaders(profile, apiKey),
      ...(profile.options?.headers ?? {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(friendlyHttpError(
      response.status,
      await response.text(),
      response.headers.get("x-request-id") ?? response.headers.get("request-id")
    ));
  }
  return { ok: true, message: "连接成功。" };
}

/** 生成 1 秒 16kHz/16-bit/单声道 WAV 测试音，避免测试连接依赖用户文件或录音权限。 */
function createTranscriptionTestWave() {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const output = Buffer.alloc(44 + sampleCount * 2);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    output.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 1_200), 44 + index * 2);
  }
  return output;
}

/**
 * 从各种常见响应形状中提取模型回复文本（兼容性兜底）：
 * choices[].message.content / output_text / output[].content / content[] / candidates[]，
 * 以及网关常见的 data/result 包裹。返回纯文本，无法提取时返回空串。
 */
function extractMessageContent(payload, depth = 0) {
  // Bound the recursion so a malformed/cyclic gateway payload cannot overflow
  // the stack and crash the main process.
  if (depth > 8) return "";
  if (payload?.data && payload.data !== payload) return extractMessageContent(payload.data, depth + 1);
  if (payload?.result && payload.result !== payload) return extractMessageContent(payload.result, depth + 1);
  const content = payload.choices?.[0]?.message?.content ?? payload.output_text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => item?.text ?? item?.content ?? "").join("");
  }
  if (Array.isArray(payload.output)) {
    return payload.output.flatMap((item) => item?.content ?? [])
      .map((item) => item?.text ?? "")
      .join("");
  }
  if (Array.isArray(payload.content)) {
    return payload.content.map((item) => item?.text ?? "").join("");
  }
  if (Array.isArray(payload.candidates)) {
    return payload.candidates.flatMap((candidate) => candidate?.content?.parts ?? [])
      .map((part) => part?.text ?? "")
      .join("");
  }
  return "";
}

/** 剥掉 New API 等网关常见的 {data}/{result} 包装（与 extractMessageContent 同规则）。 */
function unwrapPayload(payload, depth = 0) {
  if (depth > 8) return payload ?? {};
  if (payload?.data && payload.data !== payload) return unwrapPayload(payload.data, depth + 1);
  if (payload?.result && payload.result !== payload) return unwrapPayload(payload.result, depth + 1);
  return payload ?? {};
}

/**
 * 把内联 <think>…</think>（vLLM/Qwen 系网关拼在 content 里）从正文中拆出；
 * 未闭合的 <think> 把其后全部内容视为思考过程，避免把思维链当答案渲染。
 */
function splitInlineThinking(text, thoughts) {
  return String(text ?? "").replace(/<think>([\s\S]*?)(<\/think>|$)/gi, (_, inner) => {
    thoughts.push(inner);
    return "";
  });
}

/**
 * 流式增量累积器：把逐段到达的 content/reasoning 增量整理为「可立即安全渲染」的增量。
 * - 每次push后对全文重新做 <think> 拆分，天然容忍标签被拆到多个分块的情况；
 * - 尾部疑似未闭合的标签片段（如 "<th"）先扣住不发，标签成形或流结束后再释放；
 * - reasoning 字段增量与内联思考按先后拼接，保证已发出的增量只增不减。
 */
export function createChatStreamAccumulator() {
  let raw = "";
  let fieldReasoning = "";
  let visibleLength = 0;
  let reasoningLength = 0;

  const parse = () => {
    const thoughts = [];
    const visible = splitInlineThinking(raw, thoughts);
    const inline = thoughts.map((part) => part.trim()).filter(Boolean).join("\n\n");
    const reasoning = [fieldReasoning.trim(), inline].filter(Boolean).join("\n\n");
    return { visible, reasoning };
  };

  const holdbackLength = (text) => {
    const match = text.match(/<\/?[a-z]{0,8}$/i);
    return match ? match[0].length : 0;
  };

  return {
    /** @returns {{ content?: string, reasoning?: string }} 本次需要下发给 UI 的增量（可为空对象）。 */
    push(delta) {
      if (typeof delta?.reasoning === "string" && delta.reasoning) fieldReasoning += delta.reasoning;
      if (typeof delta?.content === "string" && delta.content) raw += delta.content;
      const { visible, reasoning } = parse();
      const emit = {};
      const visibleCut = visible.length - holdbackLength(visible);
      if (visibleCut > visibleLength) {
        emit.content = visible.slice(visibleLength, visibleCut);
        visibleLength = visibleCut;
      }
      // 思考同样扣住尾部半截标签（如未闭合的 “</th”），标签成形或流结束后再释放。
      const reasoningCut = reasoning.length - holdbackLength(reasoning);
      if (reasoningCut > reasoningLength) {
        emit.reasoning = reasoning.slice(reasoningLength, reasoningCut);
        reasoningLength = reasoningCut;
      }
      return emit;
    },
    /** 流结束后的最终结果（正文与思考都去除首尾空白，思考为空时省略）。 */
    finish() {
      const { visible, reasoning } = parse();
      return { content: visible.trim(), reasoning: reasoning || undefined };
    }
  };
}

/** 逐行读取 SSE data: 载荷（忽略 event:/注释行），三种协议的流式响应共用。 */
async function* sseDataLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt;
    while ((newlineAt = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, "");
      buffer = buffer.slice(newlineAt + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/**
 * 从问答响应中拆出回答正文与思维链/思考过程。兼容常见形态：
 * - OpenAI 兼容：choices[0].message.reasoning_content / reasoning（DeepSeek、New API 系）
 * - Anthropic 原生：content 数组中 type:"thinking" 块（文本在 thinking 字段）
 * - Gemini 原生：candidates parts 中 thought:true 的片段
 * - 内联 <think>…</think> 标签
 * @returns {{ content: string, reasoning?: string }}
 */
export function extractChatResponse(payload) {
  const thoughts = [];
  const finish = (content) => {
    const text = splitInlineThinking(content, thoughts).trim();
    const reasoning = thoughts.map((part) => String(part).trim()).filter(Boolean).join("\n\n");
    return { content: text, reasoning: reasoning || undefined };
  };
  const body = unwrapPayload(payload);
  // Anthropic Messages：text 块拼正文，thinking 块进思考。
  if (Array.isArray(body.content) && !body.choices) {
    const texts = [];
    for (const block of body.content) {
      if (block?.type === "thinking" && typeof block.thinking === "string") thoughts.push(block.thinking);
      else if (typeof block?.text === "string") texts.push(block.text);
    }
    return finish(texts.join(""));
  }
  // Gemini generateContent：thought:true 的片段是思考，其余拼正文。
  if (Array.isArray(body.candidates)) {
    const texts = [];
    for (const part of body.candidates.flatMap((candidate) => candidate?.content?.parts ?? [])) {
      if (part?.thought === true) {
        if (typeof part.text === "string") thoughts.push(part.text);
      } else if (typeof part?.text === "string") {
        texts.push(part.text);
      }
    }
    return finish(texts.join(""));
  }
  // OpenAI 兼容 / Responses：reasoning_content（DeepSeek）或 reasoning（部分网关）。
  const message = body.choices?.[0]?.message;
  if (message) {
    const raw = message.reasoning_content ?? message.reasoning;
    if (typeof raw === "string" && raw.trim()) thoughts.push(raw);
    else if (Array.isArray(raw)) thoughts.push(raw.map((item) => item?.text ?? "").join(""));
    let content = "";
    if (typeof message.content === "string") content = message.content;
    else if (Array.isArray(message.content)) content = message.content.map((item) => item?.text ?? item?.content ?? "").join("");
    return finish(content);
  }
  return finish(body.output_text ?? extractMessageContent(payload));
}

/**
 * 剥掉 Markdown 代码围栏并截取最外层 {...}，把模型回复规整成可 JSON.parse 的字符串。
 * 兼容多种脏输出：围栏、前后解释文字、尾部多出来的 JSON 块——从首个 { 起按 } 自尾向前
 * 逐个截取候选串，返回第一个能成功 parse 的。
 */
export function extractJson(content) {
  const trimmed = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const lastEnd = trimmed.lastIndexOf("}");
  if (start < 0 || lastEnd <= start) return trimmed;
  let end = lastEnd;
  while (end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      end = trimmed.lastIndexOf("}", end - 1);
    }
  }
  return trimmed.slice(start, lastEnd + 1);
}

/** 毫秒数格式化为 mm:ss（纪要提示词中的时间戳用）；非法/缺失时间戳按 00:00 处理。 */
function formatTime(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? Number(ms) : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
