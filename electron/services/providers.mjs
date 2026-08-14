import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { z } from "zod";

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

const normalizeBaseUrl = (value) => value.trim().replace(/\/+$/, "");

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

export const resolveProviderEndpoint = apiUrl;
const authorizationHeaders = (profile, apiKey) => {
  if (!apiKey) return {};
  return profile.baseUrl.includes(".openai.azure.com")
    ? { "api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
};

export function validateSummary(value) {
  return summarySchema.parse(value);
}

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

export async function summarizeWithOpenAICompatible(profile, apiKey, input, final = false, signal) {
  const endpoint = apiUrl(profile, "chat/completions", profile.options?.chatEndpoint);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const body = {
        model: profile.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "只输出可解析的 JSON。" },
          { role: "user", content: buildSummaryPrompt(input, final) }
        ]
      };
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

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?…])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

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

const MLX_WHISPER_SCRIPT = [
  "import json, sys",
  "import mlx_whisper",
  "result = mlx_whisper.transcribe(sys.argv[2], path_or_hf_repo=sys.argv[1], language=sys.argv[3] or None, initial_prompt=sys.argv[4] or None)",
  "segments = [{'start': float(s.get('start', 0)), 'end': float(s.get('end', 0)), 'text': (s.get('text') or '').strip()} for s in result.get('segments', [])]",
  "print(json.dumps({'text': (result.get('text') or '').strip(), 'language': result.get('language'), 'segments': segments}, ensure_ascii=False))"
].join("\n");

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

export async function transcribeWithFasterWhisper(profile, audioBuffer, fileName, language = "zh", glossary = [], signal) {
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, FASTER_WHISPER_SCRIPT);
}

export async function transcribeWithMlxWhisper(profile, audioBuffer, fileName, language = "zh", glossary = [], signal) {
  if (process.platform !== "darwin") throw new Error("MLX-Whisper 仅在 Apple Silicon macOS 上可用。");
  return transcribeWithPythonPackage(profile, audioBuffer, fileName, language, glossary, signal, MLX_WHISPER_SCRIPT);
}

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
  if (!whisperPath || !modelPath) {
    throw new Error("请先配置 whisper.cpp 可执行文件和模型路径。");
  }

  const inputPath = path.join(tmpdir(), `${randomUUID()}-${fileName}`);
  const wavePath = `${inputPath}.wav`;
  const outputBase = `${inputPath}-out`;
  await writeFile(inputPath, audioBuffer);
  try {
    if (ffmpegPath) {
      await runProcess(ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath], { signal });
    } else if (path.extname(fileName).toLowerCase() === ".wav") {
      await writeFile(wavePath, await readFile(inputPath));
    } else {
      throw new Error("转录 WebM/M4A 等格式时需要配置 FFmpeg 路径。");
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

export async function testModelProfile(profile, apiKey) {
  if (profile.transport === "whisper-cpp") {
    if (!profile.options?.executablePath || !profile.options?.modelPath) {
      throw new Error("请配置 whisper.cpp 可执行文件和模型路径。");
    }
    // Actually invoke the executable so a missing/non-executable path or an
    // incompatible build fails here, not silently mid-meeting.
    try {
      await runProcess(profile.options.executablePath, ["--help"], { timeoutMs: 8_000 });
    } catch (error) {
      throw new Error(`无法运行 whisper.cpp：${error instanceof Error ? error.message : "请检查可执行文件路径与权限。"}`);
    }
    return { ok: true, message: "whisper.cpp 可执行文件可运行，模型路径已配置。" };
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
  return "";
}

function extractJson(content) {
  const trimmed = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
