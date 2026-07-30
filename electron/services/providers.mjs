import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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

const normalizeBaseUrl = (value) => value.replace(/\/+$/, "");
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

export async function summarizeWithOpenAICompatible(profile, apiKey, input, final = false) {
  const endpoint = `${normalizeBaseUrl(profile.baseUrl)}/chat/completions`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authorizationHeaders(profile, apiKey),
          ...(profile.options?.headers ?? {})
        },
        body: JSON.stringify({
          model: profile.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "只输出可解析的 JSON。" },
            { role: "user", content: buildSummaryPrompt(input, final) }
          ]
        }),
        signal: AbortSignal.timeout(profile.options?.timeoutMs ?? 60_000)
      });
      if (!response.ok) {
        throw new Error(`总结模型请求失败：${response.status} ${await response.text()}`);
      }
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("总结模型没有返回内容。");
      return validateSummary(JSON.parse(content));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function summarizeLocally(input) {
  const recent = input.transcript.filter((segment) => segment.status === "final").slice(-8);
  const keyPoints = recent
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .slice(-5);
  const decisionPattern = /(决定|确认|同意|采用|确定|结论)/;
  const actionPattern = /(需要|负责|完成|跟进|输出|整理|评估|邀请)/;
  const questionPattern = /[？?]$/;

  return validateSummary({
    topics: input.previousSummary?.topics?.length
      ? input.previousSummary.topics
      : input.goals.slice(0, 3),
    keyPoints: Array.from(new Set([...(input.previousSummary?.keyPoints ?? []), ...keyPoints])).slice(-8),
    decisions: Array.from(new Set([
      ...(input.previousSummary?.decisions ?? []),
      ...recent.filter((segment) => decisionPattern.test(segment.text)).map((segment) => segment.text)
    ])).slice(-5),
    actionItems: Array.from(new Map([
      ...(input.previousSummary?.actionItems ?? []),
      ...recent
        .filter((segment) => actionPattern.test(segment.text))
        .slice(-3)
        .map((segment) => ({
          id: randomUUID(),
          title: segment.text,
          owner: segment.speakerName,
          dueDate: "待确认",
          status: "todo",
          done: false,
          evidenceSegmentIds: [segment.id]
        }))
    ].map((item) => [item.title, item])).values()).slice(-8),
    openQuestions: Array.from(new Set([
      ...(input.previousSummary?.openQuestions ?? []),
      ...recent.filter((segment) => questionPattern.test(segment.text)).map((segment) => segment.text)
    ])).slice(-5),
    risks: input.previousSummary?.risks ?? [],
    nextSteps: input.previousSummary?.nextSteps ?? []
  });
}

export async function transcribeRemote(
  profile,
  apiKey,
  audioBuffer,
  fileName,
  language = "zh",
  glossary = []
) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), fileName);
  form.append("model", profile.model);
  form.append("language", language);
  form.append("response_format", "verbose_json");
  if (glossary.length) form.append("prompt", glossary.slice(0, 200).join("，"));
  const response = await fetch(`${normalizeBaseUrl(profile.baseUrl)}/audio/transcriptions`, {
    method: "POST",
    headers: {
      ...authorizationHeaders(profile, apiKey),
      ...(profile.options?.headers ?? {})
    },
    body: form,
    signal: AbortSignal.timeout(profile.options?.timeoutMs ?? 120_000)
  });
  if (!response.ok) {
    throw new Error(`转录模型请求失败：${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  return {
    text: payload.text ?? "",
    language: payload.language ?? language,
    duration: payload.duration,
    segments: (payload.segments ?? []).map((segment) => ({
      startMs: Math.round((segment.start ?? 0) * 1000),
      endMs: Math.round((segment.end ?? segment.start ?? 0) * 1000),
      text: String(segment.text ?? "").trim()
    })).filter((segment) => segment.text)
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `本地模型进程退出，代码 ${code}`));
    });
  });
}

export async function transcribeWithWhisperCpp(
  profile,
  audioBuffer,
  fileName,
  language = "zh",
  glossary = []
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
      await runProcess(ffmpegPath, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath]);
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
    if (glossary.length) args.push("--prompt", glossary.slice(0, 200).join("，"));
    await runProcess(whisperPath, args);
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
    return { ok: true, message: "本地路径配置完整。" };
  }
  if (profile.transport === "sherpa-onnx") {
    if (
      !profile.options?.executablePath ||
      !profile.options?.segmentationModelPath ||
      !profile.options?.embeddingModelPath
    ) {
      throw new Error("请配置 sherpa-onnx 可执行文件、segmentation 和 embedding 模型路径。");
    }
    return { ok: true, message: "说话人分离运行时与模型路径配置完整。" };
  }
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const response = await fetch(`${baseUrl}/models`, {
    headers: authorizationHeaders(profile, apiKey),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`连接失败：HTTP ${response.status}`);
  return { ok: true, message: "连接成功。" };
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
