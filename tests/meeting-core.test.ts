/**
 * 核心单元测试（vitest，npm test）：覆盖主进程纯函数与渲染层纯逻辑——
 * formatters（Markdown/字幕）、providers（端点解析/总结/转写/校验/重试策略/JSON 提取）、
 * local-models（模型识别与目录）、diarization（轮次回填）、updates（版本比较与清单校验）、
 * lib/transcript（段落合并/说话人合并）、lib/summary（纪要锁/解锁与修订合并）、
 * database（转录段差量持久化，electron 以临时目录 mock）。
 * 网络与子进程调用均以 vi.fn()/vi.stubGlobal() 模拟，不产生真实请求。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { markdown, subtitle } from "../electron/services/formatters.mjs";
import {
  buildSummaryPrompt,
  buildVisualSummaryPrompt,
  extractJson,
  isVisualSummaryProfileVerified,
  resolveProviderEndpoint,
  generateVisualSummaryWithOpenAICompatible,
  summarizeWithOpenAICompatible,
  summarizeLocally,
  testModelProfile,
  transcribeRemote,
  validateSummary,
  validateVisualSummary,
  visualSummaryProfileFingerprint
} from "../electron/services/providers.mjs";
import {
  buildModelDownloadUrl,
  describeLocalModel,
  downloadFromUrl,
  downloadModel,
  listDownloadableModels,
  looksLikeWhisperModel
} from "../electron/services/local-models.mjs";
import {
  applyDiarization,
  cosineSimilarity,
  matchVoiceprint,
  voiceprintModelKey
} from "../electron/services/diarization.mjs";
import {
  checkForAppUpdate,
  compareVersions,
  compareSystemVersions,
  normalizeGitHubRelease,
  updateManifestUrls,
  validateUpdateManifest
} from "../electron/services/updates.mjs";
import { groupTranscriptSegments, mergeSpeakerLabels, mergeTranscriptSegments } from "../src/lib/transcript";
import { groupLibraryMeetings, splitHighlight } from "../src/lib/library";
import { simplifyChinese, simplifySummary } from "../src/lib/chinese";
import { isMicrophonePermissionError, shouldRequestMicrophone } from "../src/lib/permissions";
import { lockSummaryField, mergeSummaryRevision, toggleSummaryLock, unlockSummaryField } from "../src/lib/summary";
import { normalizeImportChunkSegments } from "../electron/services/import-queue.mjs";
import { audioContentType, parseByteRange } from "../electron/services/media.mjs";
import {
  needsRemoteTranscriptionNormalization,
  normalizeRemoteTranscriptionAudio
} from "../electron/services/transcription-audio.mjs";
import { buildRecordingReadiness, deriveWorkspaceStage, shouldAutoOpenRightPanel } from "../src/lib/workspace";
import { isOnboardingSummaryReady, isOnboardingTranscriptionReady } from "../src/lib/onboarding";
import type { RecorderPhase, WorkspaceStage } from "../src/lib/workspace";
import type { Meeting, MeetingStatus, ModelProfile, TranscriptSegment } from "../src/types";

// database.mjs 只依赖 electron 的 app.getPath；用进程隔离的临时目录 mock 掉，
// 使差量持久化测试可以真实跑 node:sqlite（不依赖 Electron 运行时）。
vi.mock("electron", () => ({
  app: { getPath: () => `/tmp/minuteflow-db-test-${process.pid}` }
}));
// 模型下载测试需要"托管运行时就绪"：把 whisper.node 与内置 FFmpeg 替换为
// 进程内可加载的替身（process.execPath 一定是可执行文件），避免探测真实二进制。
vi.mock("@fugood/whisper.node", () => ({
  loadWhisperModule: async () => ({ WhisperContext: class WhisperContext {} }),
  initWhisper: async () => ({})
}));

describe("首次模型配置向导", () => {
  const profile = (changes: Partial<ModelProfile>): ModelProfile => ({
    name: "测试配置",
    kind: "stt",
    transport: "whisper-cpp",
    baseUrl: "",
    model: "small",
    options: {},
    enabled: true,
    ...changes
  });

  it("only marks a local Whisper profile ready after a model is selected", () => {
    expect(isOnboardingTranscriptionReady(profile({}))).toBe(false);
    expect(isOnboardingTranscriptionReady(profile({ options: { modelPath: "/models/ggml-small.bin" } }))).toBe(true);
    expect(isOnboardingTranscriptionReady(profile({ enabled: false, options: { modelPath: "/models/ggml-small.bin" } }))).toBe(false);
  });

  it("accepts configured remote transcription and excludes basic summaries from LLM readiness", () => {
    expect(isOnboardingTranscriptionReady(profile({ transport: "openai-audio", baseUrl: "https://api.example.com/v1", model: "whisper-1" }))).toBe(true);
    expect(isOnboardingSummaryReady(profile({ kind: "llm", transport: "local-summary", model: "", baseUrl: "" }))).toBe(false);
    expect(isOnboardingSummaryReady(profile({ kind: "llm", transport: "openai-chat", baseUrl: "https://api.example.com/v1", model: "qwen-plus" }))).toBe(true);
  });
});
vi.mock("@ffmpeg-installer/ffmpeg", () => ({
  default: { path: process.execPath }
}));
import {
  deleteVoiceprintPerson,
  listMeetings,
  listVoiceprintPeople,
  listVoiceprintSamples,
  loadMeeting,
  saveMeeting,
  saveVoiceprintSample
} from "../electron/database.mjs";

/** 构造一条定稿转写段的测试工厂（默认 speaker-1/刘婷/system 轨）。 */
const segment = (
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  status: TranscriptSegment["status"] = "final"
): TranscriptSegment => ({
  id,
  startMs,
  endMs,
  speakerId: "speaker-1",
  speakerName: "刘婷",
  text,
  status,
  track: "system"
});

const meeting: Meeting = {
  id: "meeting-1",
  title: "产品同步会",
  scheduledAt: "2026-07-30T10:00:00+08:00",
  durationSeconds: 65,
  status: "complete",
  mode: "online",
  favorite: false,
  participants: ["我", "刘婷"],
  tags: ["产品"],
  goals: ["确认发布方案"],
  notes: ["关注上线风险"],
  notesMarkdown: "## 我的判断\n\n- 关注上线风险",
  transcript: [segment("s1", 1_250, 4_500, "决定周四完成灰度发布。")],
  summary: {
    topics: ["发布方案"],
    keyPoints: ["灰度比例为 5%"],
    decisions: ["周四完成灰度发布"],
    actionItems: [{
      id: "a1",
      title: "准备灰度检查表",
      owner: "刘婷",
      dueDate: "08-03",
      status: "todo",
      done: false
    }],
    openQuestions: ["是否需要法务复核？"],
    risks: ["排期较紧"],
    nextSteps: ["发布后复盘"],
    stale: false
  },
  createdAt: "2026-07-30T09:50:00+08:00",
  updatedAt: "2026-07-30T11:05:00+08:00"
};

afterEach(() => vi.restoreAllMocks());

describe("phase-aware desktop workspace", () => {
  it("derives prepare, live, and review without adding persisted UI state", () => {
    const statuses: MeetingStatus[] = ["draft", "recording", "paused", "complete", "interrupted"];
    const phases: RecorderPhase[] = ["idle", "starting", "recording", "paused", "stopping"];
    const expectedIdle: Record<MeetingStatus, WorkspaceStage> = {
      draft: "prepare",
      recording: "live",
      paused: "live",
      complete: "review",
      interrupted: "prepare"
    };

    for (const status of statuses) {
      for (const phase of phases) {
        expect(deriveWorkspaceStage(status, phase), `${status}/${phase}`).toBe(
          phase === "idle" ? expectedIdle[status] : "live"
        );
      }
    }
  });

  it("keeps recording available when transcription is not configured", () => {
    const readiness = buildRecordingReadiness({
      mode: "online",
      microphone: "not-determined"
    });
    expect(readiness.hasTranscription).toBe(false);
    expect(readiness.microphoneNeedsAttention).toBe(false);
    expect(readiness.items.find((item) => item.id === "capture")?.value).toBe("麦克风 + 系统音频");
    expect(readiness.items.find((item) => item.id === "transcription")).toMatchObject({
      value: "尚未配置",
      tone: "attention"
    });
  });

  it("surfaces blocked microphone access separately from model readiness", () => {
    const readiness = buildRecordingReadiness({
      mode: "offline",
      microphone: "denied",
      transcriptionProfileName: "本机 Whisper Small"
    });
    expect(readiness.hasTranscription).toBe(true);
    expect(readiness.microphoneNeedsAttention).toBe(true);
    expect(readiness.items.find((item) => item.id === "microphone")?.value).toBe("需要处理");
  });

  it("opens the right panel only when the current stage has useful live or review content", () => {
    expect(shouldAutoOpenRightPanel({ stage: "prepare", transcriptCount: 12 })).toBe(false);
    expect(shouldAutoOpenRightPanel({ stage: "live", transcriptCount: 0 })).toBe(true);
    expect(shouldAutoOpenRightPanel({ stage: "review", transcriptCount: 0 })).toBe(false);
    expect(shouldAutoOpenRightPanel({ stage: "review", transcriptCount: 2 })).toBe(true);
    expect(shouldAutoOpenRightPanel({ stage: "review", transcriptCount: 0, hasProcessingStatus: true })).toBe(true);
  });
});

describe("microphone permission routing", () => {
  it("requests access for stale or undecided states but not for granted", () => {
    expect(shouldRequestMicrophone("unknown")).toBe(true);
    expect(shouldRequestMicrophone("not-determined")).toBe(true);
    expect(shouldRequestMicrophone("denied")).toBe(true);
    expect(shouldRequestMicrophone("granted")).toBe(false);
  });

  it("recognizes Chromium permission failures", () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    expect(isMicrophonePermissionError(denied)).toBe(true);
    expect(isMicrophonePermissionError(new Error("device missing"))).toBe(false);
  });
});

describe("meeting library grouping", () => {
  const now = Date.now();
  const libraryMeeting = (id: string, hoursAgo: number, favorite = false) => ({
    id,
    favorite,
    scheduledAt: new Date(now - hoursAgo * 3_600_000).toISOString()
  });

  it("pins favorites above the time groups and excludes them from time buckets", () => {
    const groups = groupLibraryMeetings([
      libraryMeeting("today", 2),
      libraryMeeting("fav-week", 30, true),
      libraryMeeting("week", 50),
      libraryMeeting("fav-today", 3, true),
      libraryMeeting("earlier", 24 * 10)
    ], false);
    expect(groups.map((group) => group.key)).toEqual(["favorites", "today", "week", "earlier"]);
    expect(groups[0].meetings.map((item) => item.id)).toEqual(["fav-week", "fav-today"]);
    expect(groups[1].meetings.map((item) => item.id)).toEqual(["today"]);
    expect(groups[3].meetings.map((item) => item.id)).toEqual(["earlier"]);
  });

  it("falls back to plain time groups while searching so results stay ordered", () => {
    const groups = groupLibraryMeetings([
      libraryMeeting("fav-today", 3, true),
      libraryMeeting("today", 2)
    ], true);
    expect(groups.map((group) => group.key)).toEqual(["today"]);
    expect(groups[0].meetings.map((item) => item.id)).toEqual(["fav-today", "today"]);
  });

  it("emits no favorites header when nothing is starred", () => {
    expect(groupLibraryMeetings([libraryMeeting("today", 1)], false).map((group) => group.key)).toEqual(["today"]);
  });
});

describe("meeting library search highlight", () => {
  it("splits case-insensitive matches into highlighted parts", () => {
    expect(splitHighlight("产品团队周会 Kickoff", "kick")).toEqual([
      { text: "产品团队周会 ", match: false },
      { text: "Kick", match: true },
      { text: "off", match: false }
    ]);
  });

  it("highlights repeated hits and keeps CJK substring matching", () => {
    expect(splitHighlight("周会与复盘周会", "周会")).toEqual([
      { text: "周会", match: true },
      { text: "与复盘", match: false },
      { text: "周会", match: true }
    ]);
  });

  it("returns a single plain part for empty queries or no match", () => {
    expect(splitHighlight("团队周会", "   ")).toEqual([{ text: "团队周会", match: false }]);
    expect(splitHighlight("团队周会", "访谈").every((part) => !part.match)).toBe(true);
  });
});

describe("progressive import transcript", () => {
  it("offsets chunk timestamps and discards content wholly inside the overlap", () => {
    const result = normalizeImportChunkSegments({
      segments: [
        { startMs: 100, endMs: 800, text: "上一段重复" },
        { startMs: 900, endMs: 2_500, text: "新的内容" }
      ]
    }, 59_000, 60_000, 120_000, "job:chunk:1:", []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startMs: 60_000, endMs: 61_500, text: "新的内容" });
  });

  it("keeps user-visible order and removes an exact boundary duplicate", () => {
    const result = normalizeImportChunkSegments({
      segments: [
        { startMs: 1_100, endMs: 2_000, text: " 已经出现。 " },
        { startMs: 2_100, endMs: 3_000, text: "继续讨论" }
      ]
    }, 59_000, 60_000, 120_000, "job:chunk:1:", [segment("old", 59_000, 60_200, "已经出现")]);
    expect(result.map((item) => item.text)).toEqual(["继续讨论"]);
    expect(result[0].startMs).toBe(61_100);
  });
});

describe("Simplified Chinese normalization", () => {
  it("converts Traditional characters and contextual Taiwan wording to Mainland Simplified Chinese", () => {
    expect(simplifyChinese("繁體中文與會議記錄，新增一個段落，這件事我管不著。"))
      .toBe("繁体中文与会议记录，添加一个段落，这件事我管不着。");
  });
});

describe("local audio streaming", () => {
  it("parses open, bounded, and suffix byte ranges", () => {
    expect(parseByteRange("bytes=100-", 1_000)).toEqual({ start: 100, end: 999 });
    expect(parseByteRange("bytes=100-199", 1_000)).toEqual({ start: 100, end: 199 });
    expect(parseByteRange("bytes=-50", 1_000)).toEqual({ start: 950, end: 999 });
    expect(parseByteRange("bytes=1000-", 1_000)).toBeUndefined();
  });

  it("returns browser-compatible content types for recorded and imported audio", () => {
    expect(audioContentType("meeting.webm")).toBe("audio/webm");
    expect(audioContentType("meeting.m4a")).toBe("audio/mp4");
    expect(audioContentType("meeting.mp3")).toBe("audio/mpeg");
  });
});

describe("remote live transcription audio", () => {
  it("normalizes browser WebM chunks to 16 kHz mono PCM WAV before upload", async () => {
    const source = Buffer.from("standalone-webm-chunk");
    let invoked = false;
    const prepared = await normalizeRemoteTranscriptionAudio(
      source,
      "microphone-8000.webm",
      "/managed/ffmpeg",
      undefined,
      async (command: string, args: string[]) => {
        invoked = true;
        expect(command).toBe("/managed/ffmpeg");
        expect(args).toEqual(expect.arrayContaining([
          "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav"
        ]));
        const inputPath = args[args.indexOf("-i") + 1];
        expect(await readFile(inputPath)).toEqual(source);
        const wave = Buffer.alloc(48);
        wave.write("RIFF", 0, "ascii");
        await writeFile(args.at(-1)!, wave);
      }
    );
    expect(invoked).toBe(true);
    expect(prepared.fileName).toBe("microphone-8000.wav");
    expect(prepared.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("does not transcode an existing WAV transcription chunk", async () => {
    const source = Buffer.from("RIFF-ready-wave");
    expect(needsRemoteTranscriptionNormalization("chunk.webm")).toBe(true);
    expect(needsRemoteTranscriptionNormalization("chunk.wav")).toBe(false);
    await expect(normalizeRemoteTranscriptionAudio(source, "chunk.wav", undefined))
      .resolves.toEqual({ audio: source, fileName: "chunk.wav" });
  });
});

describe("transcript window merge", () => {
  it("replaces an overlapping provisional window with the final segment", () => {
    const provisional = segment("p1", 0, 8_000, "临时文本", "provisional");
    const final = segment("f1", 200, 7_900, "最终文本");
    expect(mergeTranscriptSegments([provisional], final)).toEqual([final]);
  });

  it("keeps final segments and orders new segments by time", () => {
    const late = segment("late", 9_000, 12_000, "后一句");
    const early = segment("early", 0, 4_000, "前一句");
    expect(mergeTranscriptSegments([late], early).map((item) => item.id))
      .toEqual(["early", "late"]);
  });

  it("groups adjacent short turns but breaks on questions and long pauses", () => {
    const grouped = groupTranscriptSegments([
      segment("one", 0, 4_000, "先确认目标。"),
      segment("two", 4_300, 8_000, "然后评估方案。"),
      segment("question", 8_200, 10_000, "今天能完成吗？"),
      segment("later", 12_000, 14_000, "明天继续。")
    ]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ id: "one", startMs: 0, endMs: 8_000, text: "先确认目标。然后评估方案。" });
    expect(grouped[1].text).toBe("今天能完成吗？");
  });

  it("merges speaker labels without changing other turns", () => {
    const other = { ...segment("s2", 5_000, 7_000, "好的"), speakerId: "speaker-2", speakerName: "周哲" };
    const merged = mergeSpeakerLabels(meeting.transcript.concat(other), "speaker-2", "speaker-1", "刘婷");
    expect(merged[1]).toMatchObject({ speakerId: "speaker-1", speakerName: "刘婷" });
  });

  it("applies stable diarization turns by transcript midpoint", () => {
    const turns = [
      { startMs: 0, endMs: 4_000, speakerId: "speaker-1" },
      { startMs: 4_001, endMs: 9_000, speakerId: "speaker-2" }
    ];
    const result = applyDiarization([
      segment("first", 500, 2_500, "第一位发言"),
      segment("second", 5_000, 7_000, "第二位发言")
    ], turns);
    expect(result.map((item) => item.speakerName)).toEqual(["Speaker 1", "Speaker 2"]);
  });

  it("applies a confidently identified voiceprint name without changing the speaker id", () => {
    const result = applyDiarization([
      segment("known", 500, 2_500, "已识别发言")
    ], [{ startMs: 0, endMs: 4_000, speakerId: "speaker-1", speakerName: "刘婷" }]);
    expect(result[0]).toMatchObject({ speakerId: "speaker-1", speakerName: "刘婷" });
  });

  it("matches voiceprints conservatively and rejects ambiguous or weak candidates", () => {
    const samples = [
      { name: "刘婷", embedding: new Float32Array([1, 0, 0]) },
      { name: "周哲", embedding: new Float32Array([0, 1, 0]) }
    ];
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1);
    expect(matchVoiceprint(new Float32Array([0.98, 0.03, 0]), samples))
      .toMatchObject({ name: "刘婷", sampleCount: 1 });
    expect(matchVoiceprint(new Float32Array([0.7, 0.7, 0]), samples)).toBeNull();
    expect(matchVoiceprint(new Float32Array([0, 0, 1]), samples)).toBeNull();
  });

  it("keys voiceprints by embedding model filename so moved models stay compatible", () => {
    expect(voiceprintModelKey({ options: { embeddingModelPath: "/models/3d-speaker-v1.onnx" } }))
      .toBe("3d-speaker-v1.onnx");
    expect(voiceprintModelKey({ options: {} })).toBe("");
  });
});

describe("structured meeting summary", () => {
  it("extracts decisions, actions, and questions with valid defaults", () => {
    const summary = summarizeLocally({
      title: "评审",
      goals: ["完成评审"],
      notes: [],
      previousSummary: {
        topics: [], keyPoints: [], decisions: [], actionItems: [],
        openQuestions: [], risks: [], nextSteps: []
      },
      transcript: [
        segment("d", 0, 1_000, "决定采用 A 方案。"),
        segment("a", 1_000, 2_000, "刘婷负责整理发布清单。"),
        segment("q", 2_000, 3_000, "上线日期是否确定？")
      ]
    });
    expect(summary.decisions).toContain("决定采用 A 方案。");
    expect(summary.actionItems[0]).toMatchObject({ owner: "刘婷", status: "todo" });
    expect(summary.openQuestions).toContain("上线日期是否确定？");
    expect(summary.keyPoints).not.toContain("决定采用 A 方案。");
    expect(summary.keyPoints.some((item) => /^(会议决定|后续安排|讨论重点)：/.test(item))).toBe(true);
  });

  it("rejects structurally invalid responses", () => {
    expect(() => validateSummary({ topics: "not-an-array" })).toThrow();
  });

  it("preserves manually locked summary blocks across AI revisions", () => {
    const current = lockSummaryField({
      ...meeting.summary,
      keyPoints: ["人工确认的结论"]
    }, "keyPoints:0");
    const incoming = {
      ...meeting.summary,
      keyPoints: ["模型生成的新结论", "新增进展"]
    };
    expect(mergeSummaryRevision(current, incoming).keyPoints)
      .toEqual(["人工确认的结论", "新增进展"]);
  });

  it("keeps locked list entries in place even when the AI list shrinks", () => {
    const current = lockSummaryField(lockSummaryField({
      ...meeting.summary,
      decisions: ["决策一", "决策二"]
    }, "decisions:0"), "decisions:1");
    const incoming = { ...meeting.summary, decisions: [] };
    // AI 返回空列表时，被锁定的两条按原顺序保留，不丢失也不重排。
    expect(mergeSummaryRevision(current, incoming).decisions).toEqual(["决策一", "决策二"]);
  });

  it("replaces locked action items in place and appends ones the AI dropped", () => {
    // UI 中手动新增/编辑行动项都会自动加锁（action:<id>），这里模拟同样的状态。
    const current = lockSummaryField(lockSummaryField({
      ...meeting.summary,
      actionItems: [
        meeting.summary.actionItems[0],
        { id: "a2", title: "用户手动补充的行动项", owner: "我", dueDate: "08-10", status: "todo", done: false }
      ]
    }, "action:a1"), "action:a2");
    const incoming = {
      ...meeting.summary,
      actionItems: [
        { id: "new-1", title: "AI 新行动项", owner: "刘婷", dueDate: "08-12", status: "todo", done: false },
        meeting.summary.actionItems[0]
      ]
    };
    const merged = mergeSummaryRevision(current, incoming).actionItems;
    // AI 结果中同 id 的行动项被用户锁定版本原位替换（位置不变）；
    // AI 结果里没有的锁定行动项补回到末尾，内容不丢失。
    expect(merged.map((item) => item.id)).toEqual(["new-1", "a1", "a2"]);
    expect(merged[1]).toEqual(current.actionItems[0]);
  });

  it("unlocks a field so AI revisions resume updating it", () => {
    const locked = lockSummaryField({ ...meeting.summary, keyPoints: ["人工结论"] }, "keyPoints:0");
    const unlocked = unlockSummaryField(toggleSummaryLock(locked, "keyPoints:0"), "keyPoints:0");
    const merged = mergeSummaryRevision(unlocked, { ...meeting.summary, keyPoints: ["AI 结论"] });
    expect(merged.keyPoints).toEqual(["AI 结论"]);
    expect(merged.manualLocks).toEqual([]);
  });

  it("keeps the whole topics list when it is locked", () => {
    const locked = lockSummaryField(meeting.summary, "topics");
    const merged = mergeSummaryRevision(locked, { ...meeting.summary, topics: ["AI 改写的主题"] });
    expect(merged.topics).toEqual(["发布方案"]);
  });

  it("reads decisions and risks from earlier segments beyond the old 8-item window", () => {
    const transcript = Array.from({ length: 14 }, (_value, index) =>
      segment(`w${index}`, index * 1_000, index * 1_000 + 900, `第${index}句普通内容。`));
    transcript[2] = segment("w2", 2_000, 2_900, "决定采用离线方案。");
    transcript[3] = segment("w3", 3_000, 3_900, "这个排期有延期风险。");
    const summary = summarizeLocally({
      title: "长会议",
      goals: [],
      notes: [],
      previousSummary: { topics: [], keyPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [] },
      transcript
    });
    expect(summary.decisions).toContain("决定采用离线方案。");
    expect(summary.risks).toContain("这个排期有延期风险。");
  });

  it("reports structurally invalid summaries with a readable message", () => {
    expect(() => validateSummary({ topics: "not-an-array" }))
      .toThrow(/纪要结构不合法/);
  });
});

describe("model response parsing", () => {
  it("strips code fences and surrounding prose from JSON replies", () => {
    const payload = JSON.stringify({ topics: [], keyPoints: ["要点"] });
    expect(extractJson("```json\n" + payload + "\n```")).toBe(payload);
    expect(extractJson(`好的，以下是纪要：${payload}`)).toBe(payload);
    // 尾部多出的第二个 JSON 块不应破坏第一个的解析。
    expect(JSON.parse(extractJson(`${payload}\n补充说明 {"another": true}`)))
      .toEqual({ topics: [], keyPoints: ["要点"] });
  });

  it("bounds the transcript portion of summary prompts for long meetings", () => {
    const longSegments = Array.from({ length: 2_000 }, (_value, index) =>
      segment(`s${index}`, index * 1_000, index * 1_000 + 999, "这是一段比较长的转录内容，用来撑爆提示词窗口。"));
    const prompt = buildSummaryPrompt({
      title: "超长会议",
      goals: [],
      notes: [],
      transcript: longSegments,
      previousSummary: { topics: [], keyPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [] }
    });
    expect(prompt).toContain("已省略更早的部分");
    expect(prompt.length).toBeLessThan(45_000);
  });

  it("formats missing timestamps as 00:00 instead of NaN", () => {
    const prompt = buildSummaryPrompt({
      title: "时间缺失",
      goals: [],
      notes: [],
      transcript: [{ ...segment("bad", 0, 0, "内容"), startMs: undefined as unknown as number }],
      previousSummary: { topics: [], keyPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [] }
    });
    expect(prompt).not.toContain("NaN");
  });
});

describe("model provider compatibility", () => {
  const summaryInput = {
    title: meeting.title,
    goals: meeting.goals,
    notes: meeting.notes,
    transcript: meeting.transcript,
    previousSummary: meeting.summary
  };
  const validSummaryPayload = JSON.stringify({
    topics: [], keyPoints: [], decisions: [], actionItems: [],
    openQuestions: [], risks: [], nextSteps: []
  });

  it("normalizes New API base URLs with or without /v1", () => {
    const base = { baseUrl: "https://new-api.example", options: {} };
    expect(resolveProviderEndpoint(base, "chat/completions"))
      .toBe("https://new-api.example/v1/chat/completions");
    expect(resolveProviderEndpoint({ ...base, baseUrl: "https://new-api.example/v1/" }, "audio/transcriptions"))
      .toBe("https://new-api.example/v1/audio/transcriptions");
  });

  it("uses the standard transcription endpoint and unwraps gateway data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { text: "测试转录" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const result = await transcribeRemote({
      baseUrl: "https://new-api.example",
      model: "whisper-1",
      options: { apiFlavor: "new-api" }
    }, "secret", new Uint8Array([1, 2, 3]), "sample.webm");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://new-api.example/v1/audio/transcriptions"
    ]);
    expect(result.text).toBe("测试转录");
  });

  it("labels WAV transcription uploads with an audio MIME type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "测试转录" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    await transcribeRemote({
      baseUrl: "https://new-api.example",
      model: "whisper-1",
      options: { apiFlavor: "new-api" }
    }, "secret", new Uint8Array([1, 2, 3]), "sample.wav");
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect((form.get("file") as Blob).type).toBe("audio/wav");
  });

  it("tests a full transcription URL by uploading a built-in WAV instead of appending /models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const result = await testModelProfile({
      baseUrl: "https://gateway.example/v1/audio/transcriptions",
      kind: "stt",
      transport: "openai-audio",
      model: "whisper-1",
      options: { responseFormat: "json" }
    }, "secret");
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://gateway.example/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBeInstanceOf(Blob);
  });

  it("keeps remote transcription alive beyond a 300-second reverse-proxy timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "已转录" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await transcribeRemote({
      baseUrl: "https://gateway.example/v1",
      model: "whisper-1",
      // 模拟升级前已保存的旧档案：运行时仍应自动提升到 330 秒。
      options: { timeoutMs: 120_000, responseFormat: "json" }
    }, "secret", new Uint8Array([1, 2, 3]), "sample.webm");
    expect(timeoutSpy).toHaveBeenCalledWith(330_000);
  });

  it("uses Anthropic's native Messages API for Claude presets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: "text", text: validSummaryPayload }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await summarizeWithOpenAICompatible({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      options: { apiFlavor: "anthropic" }
    }, "anthropic-secret", summaryInput);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-secret");
  });

  it("retries without response_format when the gateway rejects the field", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("response_format is not supported", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: validSummaryPayload } }]
      }), { status: 200, headers: { "content-type": "application/json" } }));
    await summarizeWithOpenAICompatible({
      baseUrl: "https://gateway.example/v1",
      model: "gpt-test"
    }, "secret", summaryInput);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(firstBody.response_format).toEqual({ type: "json_object" });
    expect(secondBody.response_format).toBeUndefined();
  });

  it("does not retry unrecoverable auth failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(summarizeWithOpenAICompatible({
      baseUrl: "https://api.example/v1",
      model: "gpt-test"
    }, "bad-secret", summaryInput)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Gemini's native generateContent API for Gemini presets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: validSummaryPayload }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await summarizeWithOpenAICompatible({
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.6-flash",
      options: { apiFlavor: "gemini" }
    }, "gemini-secret", summaryInput);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("gemini-secret");
  });

  it("routes PT checkpoints to Python and GGML/GGUF to whisper.cpp", () => {
    expect(describeLocalModel("/models/small.pt")?.engine).toBe("whisper-python");
    expect(describeLocalModel("/models/ggml-small.bin")?.engine).toBe("whisper-cpp");
    expect(describeLocalModel("/models/model.gguf")?.engine).toBe("whisper-cpp");
    expect(describeLocalModel("/models/model.onnx")).toBeNull();
  });

  it("does not discover unrelated small .bin files as Whisper models", async () => {
    expect(looksLikeWhisperModel("/Downloads/data.bin", 5_000_000)).toBe(false);
    expect(looksLikeWhisperModel("/Downloads/ggml-small.bin", 488_000_000)).toBe(true);
    expect(looksLikeWhisperModel("/Downloads/small.pt", 461_000_000)).toBe(true);
  });

  it("offers the grouped Whisper catalog with sha256 digests", async () => {
    const catalog = await listDownloadableModels("/nonexistent/minuteflow-model-catalog");
    expect(catalog.map((model) => model.id)).toEqual([
      "ggml-tiny",
      "ggml-base",
      "ggml-small",
      "ggml-medium",
      "ggml-large-v3-turbo-q5_0",
      "ggml-large-v3-turbo",
      "ggml-large-v3",
      "ggml-medium-q5_0",
      "ggml-medium-q8_0",
      "ggml-large-v3-q5_0",
      "ggml-large-v3-turbo-q8_0",
      "ggml-tiny.en",
      "ggml-base.en",
      "ggml-small.en",
      "ggml-medium.en"
    ]);
    expect(catalog.every((model) => model.engine === "whisper-cpp" && model.installed === false)).toBe(true);
    // 摘要算法必须是 sha256（体积与 HuggingFace 官方仓库逐一核对）。
    expect(catalog.every((model) => model.digestAlgorithm === "sha256")).toBe(true);
    // 三组展示：多语言推荐 7 款 + 轻量量化 4 款 + 英文专用 4 款。
    expect(catalog.filter((model) => model.group === "multilingual")).toHaveLength(7);
    expect(catalog.filter((model) => model.group === "quantized")).toHaveLength(4);
    expect(catalog.filter((model) => model.group === "english")).toHaveLength(4);
    expect(catalog.find((model) => model.id === "ggml-base")?.sizeBytes).toBe(147_951_465);
    expect(catalog.find((model) => model.id === "ggml-large-v3")?.sizeBytes).toBe(3_095_033_483);
    expect(catalog.find((model) => model.id === "ggml-medium-q5_0")?.sizeBytes).toBe(539_212_467);
    expect(catalog.find((model) => model.id === "ggml-medium.en")?.sizeBytes).toBe(1_533_774_781);
  });

  it("builds download URLs from mirror hosts and {fileName} templates", () => {
    const item = { fileName: "ggml-base.bin", repo: "ggerganov/whisper.cpp" };
    // HF 兼容站点根地址：换域名即可用，路径与官方一致。
    expect(buildModelDownloadUrl(item, "https://hf-mirror.com")).toBe(
      "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true"
    );
    expect(buildModelDownloadUrl(item, "https://huggingface.co/")).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true"
    );
    // 含 {fileName} 占位符的链接模板按字面替换。
    expect(buildModelDownloadUrl(item, "https://cdn.example.com/models/{fileName}")).toBe(
      "https://cdn.example.com/models/ggml-base.bin"
    );
    // 缺省 repo 回落到官方仓库名；空源返回 null。
    expect(buildModelDownloadUrl({ fileName: "ggml-tiny.bin" }, "https://hf.example.com")).toContain(
      "https://hf.example.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
    );
    expect(buildModelDownloadUrl(item, "   ")).toBeNull();
  });

  // 以下下载用例会触发真实的环境探测（spawn python 探包），放宽 vitest 默认 5 秒超时。
  it("falls back to the mirror source when the official source is unreachable", { timeout: 30_000 }, async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const directory = await mkdtemp(path.join(tmpdir(), "minuteflow-model-source-"));
    await expect(downloadModel("ggml-base", directory)).rejects.toThrow("模型下载失败");
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true",
      "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true"
    ]);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("tries the selected custom source first, then the built-in presets", { timeout: 30_000 }, async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const directory = await mkdtemp(path.join(tmpdir(), "minuteflow-model-custom-"));
    await expect(downloadModel("ggml-tiny", directory, () => {}, {
      sourceKind: "custom",
      customBase: "https://mirror.internal/whisper/{fileName}"
    })).rejects.toThrow("模型下载失败");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://mirror.internal/whisper/ggml-tiny.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin?download=true",
      "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin?download=true"
    ]);
  });

  it("rejects mismatched digests and cleans up temporary files across sources", { timeout: 30_000 }, async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    const directory = await mkdtemp(path.join(tmpdir(), "minuteflow-model-digest-"));
    await expect(downloadModel("ggml-base", directory)).rejects.toThrow("模型下载失败");
    // 两个预设源各尝试一次（摘要不符也视作该源失败并换源），且不留下 .download 半截文件。
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("downloads a model from a custom direct link without digest verification", { timeout: 30_000 }, async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(bytes));
    const directory = await mkdtemp(path.join(tmpdir(), "minuteflow-model-url-"));
    const events: Array<{ status: string; modelId: string }> = [];
    const model = await downloadFromUrl("https://example.com/models/my-whisper.bin", directory, (progress) => events.push(progress));
    expect(model.engine).toBe("whisper-cpp");
    expect(model.name).toBe("my-whisper.bin");
    await expect(readFile(path.join(directory, "my-whisper.bin"))).resolves.toEqual(Buffer.from(bytes));
    expect(events.some((event) => event.status === "ready")).toBe(true);
    expect(events.every((event) => event.modelId === "custom:my-whisper.bin")).toBe(true);
  });

  it("rejects custom links that do not point at a model file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "minuteflow-model-url-invalid-"));
    await expect(downloadFromUrl("https://example.com/models/notes.txt", directory)).rejects.toThrow(".pt、.bin 或 .gguf");
    await expect(downloadFromUrl("ftp://example.com/models/ggml-base.bin", directory)).rejects.toThrow("http(s)");
    await expect(downloadFromUrl("not-a-url", directory)).rejects.toThrow("下载链接无效");
  });
});

describe("desktop online updates", () => {
  const updateManifest = {
    schemaVersion: 1,
    version: "0.2.0",
    platform: "darwin",
    architectures: ["arm64"],
    publishedAt: "2026-08-02T06:20:37Z",
    notes: "更新说明",
    downloadUrl: "../downloads/macos/latest/",
    releasePageUrl: "https://github.com/vibeforge2014/minuteflow/releases/tag/v0.2.0",
    assetUrl: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/app.dmg",
    sha256: "abc"
  };

  const windowsManifest = {
    ...updateManifest,
    platform: "win32",
    architectures: ["x64"],
    downloadUrl: "../downloads/windows/latest/",
    assetUrl: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/MinuteFlow-Setup.exe"
  };

  it("compares stable and prerelease semantic versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.1")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0-beta.2")).toBe(1);
  });

  it("compares macOS and Windows dotted system versions", () => {
    expect(compareSystemVersions("14.2.1", "14.2")).toBe(1);
    expect(compareSystemVersions("10.0.19045", "10.0.19045.0")).toBe(0);
    expect(compareSystemVersions("10.0.19044", "10.0.19045")).toBe(-1);
    expect(() => compareSystemVersions("14.2-beta", "14.2")).toThrow("系统版本号格式无效");
  });

  it("selects per-platform manifest sources and rejects other platforms", () => {
    expect(updateManifestUrls("darwin")[0]).toContain("latest-macos.json");
    expect(updateManifestUrls("win32")[0]).toContain("latest-windows.json");
    expect(updateManifestUrls("linux")).toEqual([]);
    expect(() => validateUpdateManifest(updateManifest, { platform: "win32" }))
      .toThrow("更新清单不是 Windows 版本。");
  });

  it("rejects update manifests that point outside official HTTPS hosts", () => {
    expect(() => validateUpdateManifest({
      ...updateManifest,
      downloadUrl: "https://example.com/app.dmg"
    })).toThrow("受信任");
    expect(() => validateUpdateManifest({
      ...windowsManifest,
      assetUrl: "http://example.com/MinuteFlow-Setup.exe"
    }, { platform: "win32" })).toThrow("受信任");
  });

  it("detects a newer compatible macOS release from the website manifest", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.1.1",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(updateManifest), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
    });
    expect(result).toMatchObject({
      status: "available",
      currentVersion: "0.1.1",
      update: { version: "0.2.0", platform: "darwin" }
    });
  });

  it("does not offer a release that requires a newer operating system", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "0.1.1",
      platform: "darwin",
      arch: "arm64",
      systemVersion: "13.6.9",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ...updateManifest,
        minimumSystemVersion: "14.2"
      }), { status: 200 }))
    });
    expect(result).toMatchObject({
      status: "unsupported",
      update: { version: "0.2.0", minimumSystemVersion: "14.2" }
    });
    expect(result.message).toContain("当前系统为 13.6.9");
  });

  it("falls back to the official GitHub release when the website manifest is unavailable", async () => {
    const githubRelease = {
      tag_name: "v0.2.0",
      published_at: "2026-08-03T00:00:00Z",
      html_url: "https://github.com/vibeforge2014/minuteflow/releases/tag/v0.2.0",
      body: "修复与改进",
      assets: [{
        name: "MinuteFlow-0.2.0-macOS-arm64.dmg",
        browser_download_url: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/MinuteFlow-0.2.0-macOS-arm64.dmg",
        digest: "sha256:1234"
      }]
    };
    expect(normalizeGitHubRelease(githubRelease, { platform: "darwin", arch: "arm64" })).toMatchObject({
      version: "0.2.0",
      architectures: ["arm64"],
      sha256: "1234"
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(githubRelease), { status: 200 }));
    const result = await checkForAppUpdate({
      currentVersion: "0.1.1",
      platform: "darwin",
      arch: "arm64",
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "available", update: { version: "0.2.0" } });
  });

  it("detects a newer Windows release from the website manifest", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(windowsManifest), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const result = await checkForAppUpdate({
      currentVersion: "0.1.1",
      platform: "win32",
      arch: "x64",
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://vibeforge2014.github.io/minuteflow/releases/latest-windows.json",
      expect.anything()
    );
    expect(result).toMatchObject({
      status: "available",
      update: { version: "0.2.0", platform: "win32", architectures: ["x64"] }
    });
  });

  it("picks the squirrel setup executable from a GitHub release for Windows", async () => {
    const githubRelease = {
      tag_name: "v0.2.0",
      published_at: "2026-08-03T00:00:00Z",
      html_url: "https://github.com/vibeforge2014/minuteflow/releases/tag/v0.2.0",
      body: "修复与改进",
      assets: [
        { name: "RELEASES", browser_download_url: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/RELEASES" },
        { name: "minuteflow-0.2.0-full.nupkg", browser_download_url: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/minuteflow-0.2.0-full.nupkg" },
        {
          name: "MinuteFlow-Setup.exe",
          browser_download_url: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/MinuteFlow-Setup.exe",
          digest: "sha256:abcd"
        }
      ]
    };
    expect(normalizeGitHubRelease(githubRelease, { platform: "win32", arch: "x64" })).toMatchObject({
      version: "0.2.0",
      platform: "win32",
      architectures: ["x64"],
      assetUrl: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/MinuteFlow-Setup.exe"
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(githubRelease), { status: 200 }));
    const result = await checkForAppUpdate({
      currentVersion: "0.1.1",
      platform: "win32",
      arch: "x64",
      fetchImpl
    });
    expect(result).toMatchObject({
      status: "available",
      update: { assetUrl: "https://github.com/vibeforge2014/minuteflow/releases/download/v0.2.0/MinuteFlow-Setup.exe" }
    });
  });

  it("reports unsupported platforms without any network request", async () => {
    const fetchImpl = vi.fn();
    const result = await checkForAppUpdate({
      currentVersion: "0.1.1",
      platform: "linux",
      arch: "x64",
      fetchImpl
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "unsupported" });
  });
});

describe("visual summary schema and capability gates", () => {
  const visualPayload = {
    schemaVersion: 1,
    title: "產品週會視覺紀要",
    subtitle: "聚焦登入改版與灰度上線",
    sections: [
      {
        id: "decision-table",
        number: 4,
        title: "方案對比",
        tone: "amber",
        layout: "table",
        table: {
          columns: ["方案", "結論"],
          rows: [["A 方案", "優先驗證"], ["B 方案", "暫緩"]]
        }
      },
      {
        id: "final-callout",
        number: 5,
        title: "會議定調",
        tone: "green",
        layout: "callout",
        callout: "先以 5% 流量灰度，再根據資料決定擴量。"
      }
    ]
  } as const;

  it("validates, renumbers, and normalizes all generated copy to Simplified Chinese", () => {
    const result = validateVisualSummary(visualPayload, {
      sourceSummaryUpdatedAt: "2026-08-24T08:00:00.000Z",
      generatedAt: "2026-08-24T08:01:00.000Z"
    });
    expect(result.title).toBe("产品周会视觉纪要");
    expect(result.sections.map((section) => section.number)).toEqual([1, 2]);
    expect(result.sections[0].table?.columns).toEqual(["方案", "结论"]);
    expect(result.sections[1].callout).toContain("数据");
    expect(simplifyChinese("聚焦核心任务與核心結論")).toBe("聚焦核心任务与核心结论");
  });

  it("rejects markup, URLs, oversized tables, and mismatched row widths", () => {
    expect(() => validateVisualSummary({
      ...visualPayload,
      subtitle: "https://example.com/report"
    })).toThrow(/结构不合法/);
    expect(() => validateVisualSummary({
      ...visualPayload,
      sections: [{
        ...visualPayload.sections[0],
        table: { columns: ["方案", "结论"], rows: [["缺一列"]] }
      }]
    })).toThrow(/结构不合法/);
    expect(() => validateVisualSummary({
      ...visualPayload,
      sections: [{
        ...visualPayload.sections[0],
        table: { columns: ["方案", "结论"], rows: Array.from({ length: 6 }, () => ["A", "通过"]) }
      }]
    })).toThrow(/结构不合法/);
  });

  it("invalidates verification when endpoint, protocol, or model settings change", () => {
    const base = {
      id: "visual-profile",
      transport: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      model: "gpt-visual",
      options: { apiFlavor: "openai", chatEndpoint: "chat/completions", visualSummaryEnabled: true }
    };
    const verified = {
      ...base,
      options: {
        ...base.options,
        visualSummaryVerifiedAt: "2026-08-24T08:00:00.000Z",
        visualSummaryVerifiedFingerprint: visualSummaryProfileFingerprint(base)
      }
    };
    expect(isVisualSummaryProfileVerified(verified)).toBe(true);
    expect(isVisualSummaryProfileVerified({ ...verified, model: "gpt-visual-v2" })).toBe(false);
    expect(isVisualSummaryProfileVerified({ ...verified, baseUrl: "https://other.example/v1" })).toBe(false);
  });

  it("builds the second-stage request from ordinary minutes without transcript or audio", () => {
    const prompt = buildVisualSummaryPrompt({
      title: "发布复盘",
      participants: ["刘婷", "周哲"],
      summary: meeting.summary,
      transcript: "THIS MUST NEVER LEAVE THE DEVICE",
      audio: "AUDIO-BYTES"
    });
    expect(prompt).toContain("发布复盘");
    expect(prompt).toContain("普通纪要");
    expect(prompt).not.toContain("THIS MUST NEVER LEAVE THE DEVICE");
    expect(prompt).not.toContain("AUDIO-BYTES");
  });

  it("performs a real schema validation during connection test", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(visualPayload) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await testModelProfile({
      id: "visual-profile",
      kind: "llm",
      transport: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      model: "gpt-visual",
      options: { apiFlavor: "openai", visualSummaryEnabled: true }
    }, "secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.visualSummaryVerifiedAt).toBeTruthy();
    expect(result.visualSummaryVerifiedFingerprint).toBeTruthy();
  });

  it("keeps the ordinary summary when visual generation fails and marks an older visual stale", () => {
    const current = simplifySummary({
      ...meeting.summary,
      updatedAt: "2026-08-24T08:00:00.000Z",
      visualSummary: validateVisualSummary(visualPayload, {
        sourceSummaryUpdatedAt: "2026-08-24T08:00:00.000Z"
      })
    });
    const incoming = {
      ...meeting.summary,
      decisions: ["改为周五发布"],
      updatedAt: "2026-08-24T09:00:00.000Z"
    };
    const merged = mergeSummaryRevision(current, incoming);
    expect(merged.decisions).toEqual(["改为周五发布"]);
    expect(merged.visualSummary?.stale).toBe(true);
  });

  it("generates a validated visual summary through the compatible provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(visualPayload) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await generateVisualSummaryWithOpenAICompatible({
      id: "visual-profile",
      transport: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      model: "gpt-visual",
      options: { apiFlavor: "openai" }
    }, "secret", {
      title: meeting.title,
      participants: meeting.participants,
      summary: { ...meeting.summary, updatedAt: "2026-08-24T08:00:00.000Z" }
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.providerProfileId).toBe("visual-profile");
    expect(result.sourceSummaryUpdatedAt).toBe("2026-08-24T08:00:00.000Z");
  });
});

describe("export formatting", () => {
  it("renders all required meeting-note sections", () => {
    const output = markdown(meeting);
    expect(output).toContain("# 产品同步会");
    expect(output).toContain("## 已确认决策");
    expect(output).toContain("## 行动项");
    expect(output).toContain("**刘婷**：决定周四完成灰度发布。");
  });

  it("uses SRT and VTT timestamp separators correctly", () => {
    expect(subtitle(meeting, "srt")).toContain("00:00:01,250 --> 00:00:04,500");
    expect(subtitle(meeting, "vtt")).toContain("00:00:01.250 --> 00:00:04.500");
  });
});

describe("database transcript diff persistence", () => {
  const buildMeeting = (id: string, transcript: TranscriptSegment[]): Meeting => ({
    ...meeting,
    id,
    transcript
  });

  it("applies segment insert/update/delete incrementally and keeps FTS in sync", () => {
    const id = `diff-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    saveMeeting(buildMeeting(id, [
      segment(`${id}-a`, 0, 4_000, "保留的段落"),
      segment(`${id}-b`, 4_000, 8_000, "将被删除的段落"),
      segment(`${id}-c`, 8_000, 12_000, "将被改写的段落")
    ]));
    let stored = loadMeeting(id);
    expect(stored?.transcript.map((item) => item.text))
      .toEqual(["保留的段落", "将被删除的段落", "将被改写的段落"]);

    // 差量保存：删 b、改 c、追加 d——不应影响其余行。
    saveMeeting(buildMeeting(id, [
      segment(`${id}-a`, 0, 4_000, "保留的段落"),
      segment(`${id}-c`, 8_000, 12_000, "已经改写的段落"),
      segment(`${id}-d`, 12_000, 16_000, "追加的段落")
    ]));
    stored = loadMeeting(id);
    expect(stored?.transcript.map((item) => item.text))
      .toEqual(["保留的段落", "已经改写的段落", "追加的段落"]);

    // FTS 全文索引随保存同步：新文本可搜到，被删除的文本搜不到。
    expect(listMeetings("已经改写").some((item) => item.id === id)).toBe(true);
    expect(listMeetings("将被删除").some((item) => item.id === id)).toBe(false);
  });

  it("round-trips visual summary JSON without dropping fields from older meeting records", () => {
    const id = `visual-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const visualSummary = validateVisualSummary({
      schemaVersion: 1,
      title: "发布复盘视觉纪要",
      subtitle: "聚焦决策、风险和下一步",
      sections: [{
        id: "final",
        number: 1,
        title: "会议定调",
        tone: "green",
        layout: "callout",
        callout: "周四先以 5% 流量灰度发布。"
      }]
    }, { sourceSummaryUpdatedAt: "2026-08-24T08:00:00.000Z" });
    saveMeeting({
      ...buildMeeting(id, meeting.transcript),
      summary: { ...meeting.summary, updatedAt: "2026-08-24T08:00:00.000Z", visualSummary }
    });
    const stored = loadMeeting(id);
    expect(stored?.summary.visualSummary).toMatchObject({
      schemaVersion: 1,
      title: "发布复盘视觉纪要",
      sourceSummaryUpdatedAt: "2026-08-24T08:00:00.000Z",
      stale: false
    });
  });

  it("stores voiceprint vectors locally, replaces a same-source sample, and forgets by name", () => {
    const id = `voiceprint-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const name = `测试发言人-${id}`;
    saveMeeting(buildMeeting(id, [segment(`${id}-speaker`, 0, 5_000, "用于声纹学习的片段") ]));
    saveVoiceprintSample({
      name,
      modelKey: "speaker-model.onnx",
      embedding: new Float32Array([1, 0.25, -0.5]),
      sourceMeetingId: id,
      sourceSpeakerId: "speaker-1"
    });
    saveVoiceprintSample({
      name,
      modelKey: "speaker-model.onnx",
      embedding: new Float32Array([0.9, 0.2, -0.45]),
      sourceMeetingId: id,
      sourceSpeakerId: "speaker-1"
    });
    const samples = listVoiceprintSamples("speaker-model.onnx").filter((item) => item.name === name);
    expect(samples).toHaveLength(1);
    expect(Array.from(samples[0].embedding)).toEqual([expect.closeTo(0.9), expect.closeTo(0.2), expect.closeTo(-0.45)]);
    expect(listVoiceprintPeople()).toContainEqual(expect.objectContaining({ name, sampleCount: 1 }));
    expect(deleteVoiceprintPerson(name)).toEqual({ deleted: 1 });
    expect(listVoiceprintPeople().some((person) => person.name === name)).toBe(false);
  });
});
