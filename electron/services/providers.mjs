/**
 * 转录与纪要的模型调用层（Electron 主进程 / 服务层）。
 * 封装三类能力：远程 OpenAI 兼容接口的转录与纪要（含 New API 双端点兜底、
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
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { initWhisper, loadWhisperModule } from "@fugood/whisper.node";

/** 会议纪要 JSON 的 zod 校验 schema：模型输出先经它归一化（缺省字段补默认值）再进库。 */
const summarySchema = z.object({
  topics: z.array(z.string()).default([]),
  keyPoints: z.array(z.string()).default([]),
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

/** 调用 Anthropic Messages API（x-api-key 头 + anthropic-version），副作用：网络请求。 */
async function requestAnthropic(profile, apiKey, prompt, maxTokens = 8_192, signal) {
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
      messages: [{ role: "user", content: prompt }]
    }),
    signal: requestSignal(signal, profile.options?.timeoutMs ?? 60_000)
  });
  if (!response.ok) throw new Error(`总结模型请求失败：${response.status} ${await response.text()}`);
  return response.json();
}

/** 调用 Gemini generateContent API（x-goog-api-key 头，强制 JSON MIME 输出），副作用：网络请求。 */
async function requestGemini(profile, apiKey, prompt, maxTokens = 8_192, signal) {
  const model = encodeURIComponent(profile.model);
  const response = await fetch(nativeProviderEndpoint(profile, `v1beta/models/${model}:generateContent`, profile.options?.chatEndpoint), {
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
    signal: requestSignal(signal, profile.options?.timeoutMs ?? 60_000)
  });
  if (!response.ok) throw new Error(`总结模型请求失败：${response.status} ${await response.text()}`);
  return response.json();
}

/** 用 zod schema 校验并归一化纪要 JSON，字段缺失补默认值，格式不符抛错。 */
export function validateSummary(value) {
  return summarySchema.parse(value);
}

/**
 * 构造中文会议纪要提示词：拼接转录（带时间戳与说话人）、目标、人工笔记与上一版纪要。
 * final=true 要求生成最终纪要；否则只根据新增内容滚动更新且不删除已确认的人工内容。
 * @param {object} input 会议上下文（title/goals/notes/transcript/previousSummary）
 * @returns {string} 提示词文本
 */
export function buildSummaryPrompt(input, final = false) {
  const transcript = input.transcript
    .map((segment) => `[${formatTime(segment.startMs)}] ${segment.speakerName}: ${segment.text}`)
    .join("\n");
  return [
    "你是一名严谨的中文会议纪要助手。",
    final
      ? "请基于完整会议内容生成最终纪要。"
      : "请只根据新增内容更新滚动纪要，不要删除已经确认的人工内容。",
    "必须返回 JSON，不要使用 Markdown 代码块。",
    "结构：topics, keyPoints, decisions, actionItems, openQuestions, risks, nextSteps。",
    "actionItems 每项包含 title, owner, dueDate, status, done, evidenceSegmentIds。",
    `会议标题：${input.title}`,
    `会议目标：${input.goals.join("；") || "未提供"}`,
    `人工笔记：${input.notes.join("；") || "暂无"}`,
    `上一版纪要：${JSON.stringify(input.previousSummary ?? {})}`,
    `转录内容：\n${transcript || "暂无转录"}`
  ].join("\n\n");
}

/**
 * 调用在线模型生成会议纪要（summary:generate 与导入流水线调用）。副作用：网络请求。
 * apiFlavor 为 anthropic / gemini 时走原生协议，其余走 OpenAI 兼容 chat/completions；
 * OpenAI 路径最多尝试 2 次：第一次带 response_format=json_object，
 * 部分兼容网关不支持该字段，第二次去掉后重试（兼容性兜底）。
 * @param {object} profile LLM 模型档案
 * @param {string} apiKey 经 secrets.mjs 解出的密钥
 * @param {object} input 会议上下文
 * @returns {Promise<object>} 经 validateSummary 归一化后的纪要对象
 */
export async function summarizeWithOpenAICompatible(profile, apiKey, input, final = false, signal) {
  const prompt = buildSummaryPrompt(input, final);
  if (profile.options?.apiFlavor === "anthropic" || profile.options?.apiFlavor === "gemini") {
    const payload = profile.options.apiFlavor === "anthropic"
      ? await requestAnthropic(profile, apiKey, prompt, 8_192, signal)
      : await requestGemini(profile, apiKey, prompt, 8_192, signal);
    const content = extractMessageContent(payload);
    if (!content) throw new Error("总结模型没有返回内容。");
    return validateSummary(JSON.parse(extractJson(content)));
  }
  const endpoint = apiUrl(profile, "chat/completions", profile.options?.chatEndpoint);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const body = {
        model: profile.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "只输出可解析的 JSON。" },
          { role: "user", content: prompt }
        ]
      };
      // 第一次请求带 response_format；若网关不认识该字段报错，下一轮去掉再试。
      if (attempt === 0) body.response_format = { type: "json_object" };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authorizationHeaders(profile, apiKey),
          ...(profile.options?.headers ?? {})
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(profile.options?.timeoutMs ?? 60_000)]) : AbortSignal.timeout(profile.options?.timeoutMs ?? 60_000)
      });
      if (!response.ok) {
        throw new Error(`总结模型请求失败：${response.status} ${await response.text()}`);
      }
      const payload = await response.json();
      const content = extractMessageContent(payload);
      if (!content) throw new Error("总结模型没有返回内容。");
      return validateSummary(JSON.parse(extractJson(content)));
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** 按中英文句末标点（。！？!?…）切分句子，供本地规则纪要做句子级匹配。 */
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?…])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * 本地规则纪要兜底（无 LLM 配置或用户关闭自动总结时使用，纯 CPU、无网络）。
 * 用关键词正则从最近几句转录里抽决策/行动项/未决问题，并与上一版纪要合并去重。
 * @param {object} input 会议上下文
 * @returns {object} 经 validateSummary 归一化后的纪要对象
 */
export function summarizeLocally(input) {
  const recent = input.transcript.filter((segment) => segment.status === "final").slice(-8);
  const keyPoints = recent
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .slice(-5);
  const decisionPattern = /(决定|決定|确认|確認|同意|采用|採用|确定|確定|结论|結論)/;
  const actionPattern = /(需要|负责|負責|完成|跟进|跟進|输出|輸出|整理|评估|評估|邀请|邀請)/;
  const questionPattern = /[？?]$/;

  // Match at sentence granularity (split on Chinese/English terminal punctuation)
  // so a single long segment containing several points yields individual
  // decisions, actions, and questions instead of one undifferentiated block.
  const sentences = recent.flatMap((segment) =>
    splitSentences(segment.text).map((sentence) => ({
      text: sentence,
      speakerName: segment.speakerName,
      segmentId: segment.id
    }))
  );

  return validateSummary({
    topics: input.previousSummary?.topics?.length
      ? input.previousSummary.topics
      : input.goals.slice(0, 3),
    keyPoints: Array.from(new Set([...(input.previousSummary?.keyPoints ?? []), ...keyPoints])).slice(-8),
    decisions: Array.from(new Set([
      ...(input.previousSummary?.decisions ?? []),
      ...sentences.filter((unit) => decisionPattern.test(unit.text)).map((unit) => unit.text)
    ])).slice(-5),
    actionItems: Array.from(new Map([
      ...(input.previousSummary?.actionItems ?? []),
      ...sentences
        .filter((unit) => actionPattern.test(unit.text))
        .slice(-3)
        .map((unit) => ({
          id: randomUUID(),
          title: unit.text,
          owner: unit.speakerName,
          dueDate: "待确认",
          status: "todo",
          done: false,
          evidenceSegmentIds: [unit.segmentId]
        }))
    ].map((item) => [item.title, item])).values()).slice(-8),
    openQuestions: Array.from(new Set([
      ...(input.previousSummary?.openQuestions ?? []),
      ...sentences.filter((unit) => questionPattern.test(unit.text)).map((unit) => unit.text)
    ])).slice(-5),
    risks: input.previousSummary?.risks ?? [],
    nextSteps: input.previousSummary?.nextSteps ?? []
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
  "model = WhisperModel(sys.argv[1], device='auto', compute_type='auto')",
  "segments, info = model.transcribe(sys.argv[2], language=sys.argv[3] or None, initial_prompt=sys.argv[4] or None, vad_filter=True)",
  "materialized = [{'start': float(s.start), 'end': float(s.end), 'text': (s.text or '').strip()} for s in segments]",
  "print(json.dumps({'text': ' '.join(s['text'] for s in materialized), 'language': getattr(info, 'language', None), 'segments': materialized}, ensure_ascii=False))"
].join("\n");

/** mlx-whisper（Apple Silicon 专用 MLX 后端）的 Python 内置脚本，输出格式与 faster-whisper 一致。 */
const MLX_WHISPER_SCRIPT = [
  "import json, sys",
  "import mlx_whisper",
  "result = mlx_whisper.transcribe(sys.argv[2], path_or_hf_repo=sys.argv[1], language=sys.argv[3] or None, initial_prompt=sys.argv[4] or None)",
  "segments = [{'start': float(s.get('start', 0)), 'end': float(s.get('end', 0)), 'text': (s.get('text') or '').strip()} for s in result.get('segments', [])]",
  "print(json.dumps({'text': (result.get('text') or '').strip(), 'language': result.get('language'), 'segments': segments}, ensure_ascii=False))"
].join("\n");

/**
 * Python 系本地转录的公共执行流程（faster-whisper / mlx-whisper 共用）。
 * 副作用：写临时音频文件、拉起 ffmpeg 与 Python 子进程、结束前清理临时文件。
 * 流程：原始音频落临时文件 →（可选）FFmpeg 转 16k 单声道 WAV →
 * 运行内嵌 Python 脚本（模型路径、语言、术语表提示作为 argv 传入）→ 解析 JSON。
 * @returns {Promise<{text: string, segments: Array, duration?: number}>}
 */
async function transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, script) {
  const modelPath = profile.options?.modelPath;
  const pythonPath = profile.options?.pythonExecutablePath
    || profile.options?.executablePath
    || (process.platform === "win32" ? "python" : "python3");
  if (!modelPath) throw new Error("请先选择本地模型目录或填写 Hugging Face 仓库 ID。");
  const promptSegments = [];
  if (language === "zh") promptSegments.push("以下是简体中文的会议记录。");
  if (glossary.length) promptSegments.push(glossary.slice(0, 200).join("，"));
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
    const { stdout } = await runProcess(pythonPath, ["-c", script, modelPath, wavePath, language ?? "", promptSegments.join("")], { env: environment, signal });
    const payload = JSON.parse(stdout.trim().split("\n").pop());
    const segments = (payload.segments ?? [])
      .map((segment) => ({
        startMs: Math.round((Number(segment.start) || 0) * 1000),
        endMs: Math.round((Number(segment.end) || 0) * 1000),
        text: String(segment.text ?? "").trim()
      }))
      .filter((segment) => segment.text);
    return {
      text: (payload.text ?? segments.map((segment) => segment.text).join(" ")).trim(),
      segments,
      duration: segments.length ? Math.max(...segments.map((segment) => segment.endMs)) / 1000 : undefined
    };
  } finally {
    await Promise.allSettled([unlink(inputPath), wavePath !== inputPath && unlink(wavePath)]);
  }
}

/** faster-whisper（CTranslate2）转录入口，委托 transcribeWithPythonPackage 执行。 */
export async function transcribeWithFasterWhisper(profile, audioBuffer, fileName, language = "zh", glossary = [], signal) {
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, FASTER_WHISPER_SCRIPT);
}

/** mlx-whisper 转录入口：仅 Apple Silicon macOS 可用，其余平台直接报错。 */
export async function transcribeWithMlxWhisper(profile, audioBuffer, fileName, language = "zh", glossary = [], signal) {
  if (process.platform !== "darwin") throw new Error("MLX-Whisper 仅在 Apple Silicon macOS 上可用。");
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, MLX_WHISPER_SCRIPT);
}

/**
 * 远程转录（OpenAI 兼容 /audio/transcriptions 接口）。副作用：网络请求。
 * New API 预设兼容：标准端点 404/405 时自动换用 /audio/openai/create-transcription 再试；
 * 响应形状做了容错（data/result 包裹、text/transcript 字段、JSON 或纯文本体均可）。
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
  signal
) {
  const defaultResponseFormat = profile.options?.responseFormat
    ?? (profile.options?.apiFlavor === "new-api" || profile.model !== "whisper-1" ? "json" : "verbose_json");
  const endpoints = [
    apiUrl(profile, "audio/transcriptions", profile.options?.transcriptionEndpoint)
  ];
  if (profile.options?.apiFlavor === "new-api" && !profile.options?.transcriptionEndpoint) {
    endpoints.push(apiUrl(profile, "audio/openai/create-transcription"));
  }
  let response;
  let errorBody = "";
  for (const [index, endpoint] of endpoints.entries()) {
    const form = new FormData();
    form.append("file", new Blob([audioBuffer]), fileName);
    form.append("model", profile.model);
    if (language) form.append("language", language);
    if (defaultResponseFormat !== "text") form.append("response_format", defaultResponseFormat);
    if (glossary.length) form.append("prompt", glossary.slice(0, 200).join("，"));
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...authorizationHeaders(profile, apiKey),
        ...(profile.options?.headers ?? {})
      },
      body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(profile.options?.timeoutMs ?? 120_000)]) : AbortSignal.timeout(profile.options?.timeoutMs ?? 120_000)
    });
    if (response.ok) break;
    // 仅在 404/405（端点不存在）且还有候选端点时切换；其他错误直接抛出。
    errorBody = await response.text();
    if (![404, 405].includes(response.status) || index === endpoints.length - 1) {
      throw new Error(`转录模型请求失败：${response.status} ${errorBody}`);
    }
  }
  if (!response?.ok) throw new Error(`转录模型请求失败：${errorBody || "未知错误"}`);
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
      text: String(segment.text ?? "").trim()
    })).filter((segment) => segment.text)
  };
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
  signal
) {
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
    "model = whisper.load_model(sys.argv[1])",
    "options = {'verbose': False, 'fp16': False}",
    "if sys.argv[3]: options['language'] = sys.argv[3]",
    "if sys.argv[4]: options['initial_prompt'] = sys.argv[4]",
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
      glossary.slice(0, 200).join("，")
    ], { env: environment, signal });
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    const segments = (result.segments ?? []).map((segment) => ({
      startMs: Math.round(Number(segment.start ?? 0) * 1000),
      endMs: Math.round(Number(segment.end ?? segment.start ?? 0) * 1000),
      text: String(segment.text ?? "").trim()
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
  signal
) {
  const whisperPath = profile.options?.executablePath;
  const modelPath = profile.options?.modelPath;
  const ffmpegPath = profile.options?.ffmpegPath;
  if (!modelPath) {
    throw new Error("本地模型尚未就绪，请在转录设置中下载一个模型。");
  }
  if (!whisperPath) {
    return transcribeWithManagedWhisper(profile, audioBuffer, fileName, language, glossary, signal);
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
      "-l", language,
      "-oj",
      "-of", outputBase
    ];
    // Whisper defaults to Traditional Chinese for Mandarin even with -l zh.
    // Prime the decoder with a Simplified-Chinese prompt so the transcript
    // matches the product's Simplified-first language priority, then append
    // the user glossary as additional prompt context.
    const promptSegments = [];
    if (language === "zh") promptSegments.push("以下是简体中文的会议记录。");
    if (glossary.length) promptSegments.push(glossary.slice(0, 200).join("，"));
    if (promptSegments.length) args.push("--prompt", promptSegments.join(""));
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
 * 应用托管 whisper 运行时（@fugood/whisper.node）的进程内转录，零可执行文件配置。
 * 副作用：临时文件、ffmpeg 子进程、进程内 whisper 上下文（结束必须 release）。
 * 支持取消：AbortSignal 触发时停止推理并抛"任务已取消"。
 */
async function transcribeWithManagedWhisper(profile, audioBuffer, fileName, language, glossary, signal) {
  const modelPath = profile.options?.modelPath;
  const ffmpegPath = profile.options?.ffmpegPath;
  if (!modelPath) throw new Error("本地模型尚未就绪，请在转录设置中下载一个模型。");
  await access(modelPath);

  const inputPath = path.join(tmpdir(), `${randomUUID()}-${fileName}`);
  const wavePath = `${inputPath}.wav`;
  await writeFile(inputPath, audioBuffer);
  let context;
  let transcription;
  let abort;
  try {
    if (ffmpegPath) {
      await runProcess(ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath], { signal });
    } else if (path.extname(fileName).toLowerCase() === ".wav") {
      await writeFile(wavePath, await readFile(inputPath));
    } else {
      throw new Error("音频处理组件尚未就绪，请重试或重新安装应用。");
    }

    context = await initWhisper({
      filePath: modelPath,
      // GPU 加速只在 macOS 启用（Windows 上该后端不稳定），FlashAttention 两平台均可。
      useGpu: process.platform === "darwin",
      useFlashAttn: true
    });
    const promptSegments = [];
    if (language === "zh") promptSegments.push("以下是简体中文的会议记录。");
    if (glossary.length) promptSegments.push(glossary.slice(0, 200).join("，"));
    transcription = context.transcribeFile(wavePath, {
      language: language || undefined,
      prompt: promptSegments.join("") || undefined,
      temperature: 0
    });
    abort = () => { void transcription.stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const result = await transcription.promise;
    if (signal?.aborted || result.isAborted) throw new Error("任务已取消。");
    const segments = (result.segments ?? []).map((segment) => ({
      // whisper.cpp timestamps are expressed in 10 ms units.
      startMs: Math.round(Number(segment.t0 ?? 0) * 10),
      endMs: Math.round(Number(segment.t1 ?? segment.t0 ?? 0) * 10),
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
    await context?.release().catch(() => {});
    await Promise.allSettled([unlink(inputPath), unlink(wavePath)]);
  }
}

/**
 * 测试模型档案是否可用（models:test 通道调用）。副作用：网络请求或子进程。
 * 各 transport 的就绪含义不同：本地运行时检查模型文件与组件可运行，
 * LLM 走一次最小请求确认连通，远程 stt 用 /models 列表探测。
 * @returns {Promise<{ok: true, message: string}>} 成功时带用户可读的提示
 */
export async function testModelProfile(profile, apiKey) {
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
    if (
      !profile.options?.executablePath ||
      !profile.options?.segmentationModelPath ||
      !profile.options?.embeddingModelPath
    ) {
      throw new Error("请配置 sherpa-onnx 可执行文件、segmentation 和 embedding 模型路径。");
    }
    try {
      await runProcess(profile.options.executablePath, ["--help"], { timeoutMs: 8_000 });
    } catch (error) {
      throw new Error(`无法运行 sherpa-onnx：${error instanceof Error ? error.message : "请检查可执行文件路径与权限。"}`);
    }
    return { ok: true, message: "sherpa-onnx 可执行文件可运行，模型路径已配置。" };
  }
  if (profile.kind === "llm") {
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
    if (!response.ok) throw new Error(`连接失败：HTTP ${response.status} ${await response.text()}`);
    const payload = await response.json();
    if (!extractMessageContent(payload)) throw new Error("连接成功，但模型没有返回兼容的消息内容。");
    return { ok: true, message: "模型调用成功，接口兼容。" };
  }
  const response = await fetch(apiUrl(profile, "models"), {
    headers: {
      ...authorizationHeaders(profile, apiKey),
      ...(profile.options?.headers ?? {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`连接失败：HTTP ${response.status} ${await response.text()}`);
  return { ok: true, message: "连接成功。" };
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

/** 剥掉 Markdown 代码围栏并截取最外层 {...}，把模型回复规整成可 JSON.parse 的字符串。 */
function extractJson(content) {
  const trimmed = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** 毫秒数格式化为 mm:ss（纪要提示词中的时间戳用）。 */
function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
