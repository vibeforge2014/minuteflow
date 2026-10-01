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
  buildChatSystemPrompt,
  chatWithMeetingContext,
  createChatStreamAccumulator,
  extractChatResponse,
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
  mergeDiarizationClusters,
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
import { groupTranscriptSegments, mergeSpeakerLabels, mergeTranscriptSegments, splitTimedTranscriptText } from "../src/lib/transcript";
import { groupLibraryMeetings, splitHighlight } from "../src/lib/library";
import { simplifyChinese, simplifySummary } from "../src/lib/chinese";
import { derivePermissionSetupPhase, finishPermissionSetup, isMicrophonePermissionError, isScreenPermissionError, shouldOpenPermissionSetup, shouldRequestMicrophone } from "../src/lib/permissions";
import { lockSummaryField, mergeSummaryRevision, toggleSummaryLock, unlockSummaryField } from "../src/lib/summary";
import { normalizeImportChunkSegments } from "../electron/services/import-queue.mjs";
import { parseSilenceMidpoints, planTranscriptionChunkBoundaries } from "../electron/services/chunk-planning.mjs";
import { plannedCharacters, punctuationCut, typewriterStep } from "../src/lib/typewriter";
import {
  absorbTranscriptSegments,
  displayedTranscriptSegments,
  emptyRevealState,
  revealPending,
  revealTick,
  seedTranscriptReveal
} from "../src/lib/transcript-reveal";
import { audioContentType, parseByteRange } from "../electron/services/media.mjs";
import { isTrustedPermissionRequest, isTrustedRendererUrl } from "../electron/services/permissions.mjs";
import {
  needsRemoteTranscriptionNormalization,
  normalizeRemoteTranscriptionAudio
} from "../electron/services/transcription-audio.mjs";
import { buildRecordingReadiness, deriveWorkspaceStage, findPlayingSegment, shouldAutoOpenRightPanel } from "../src/lib/workspace";
import { isOnboardingSummaryReady, isOnboardingTranscriptionReady } from "../src/lib/onboarding";
import {
  buildSummaryContentMotion,
  classifyListChanges,
  classifyStringListChanges,
  classifyTextChange,
  findEnteringItemIds,
  stringOccurrenceIdentity
} from "../src/lib/content-motion";
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

describe("content change motion classification", () => {
  it("distinguishes a growing paragraph from a recognition correction", () => {
    expect(classifyTextChange("我们先确认目标。", "我们先确认目标。接下来讨论范围。"))
      .toEqual({ kind: "appended", prefix: "我们先确认目标。", suffix: "接下来讨论范围。" });
    expect(classifyTextChange("周四上线。", "调整为周五上线。").kind).toBe("updated");
    expect(classifyTextChange("", "第一段内容").kind).toBe("added");
    expect(classifyTextChange("保持不变", "保持不变").kind).toBe("unchanged");
  });

  it("handles duplicate summary strings without marking old copies as new", () => {
    expect(classifyListChanges(
      ["保留", "保留"],
      ["保留", "保留", "新增"],
      stringOccurrenceIdentity,
      (item) => item
    )).toEqual(["unchanged", "unchanged", "added"]);
    expect(classifyStringListChanges(["旧结论"], ["改写后的结论"])).toEqual(["updated"]);
  });

  it("marks only the changed summary fields and stable action ids", () => {
    const previous = { ...meeting.summary, updatedAt: "2026-08-31T10:00:00.000Z" };
    const next = {
      ...previous,
      keyPoints: [...previous.keyPoints, "补充验收指标"],
      decisions: ["周五完成灰度发布"],
      actionItems: [
        { ...previous.actionItems[0], owner: "周哲" },
        { id: "a2", title: "补充验收记录", owner: "我", dueDate: "09-02", status: "todo" as const, done: false }
      ],
      updatedAt: "2026-08-31T10:01:00.000Z"
    };
    const motion = buildSummaryContentMotion(previous, next);
    expect(motion.lists.keyPoints).toEqual(["unchanged", "added"]);
    expect(motion.lists.decisions).toEqual(["updated"]);
    expect(motion.actions).toEqual({ a1: "updated", a2: "added" });
  });

  it("suppresses initial and meeting-switch animations but detects same-meeting inserts", () => {
    expect(findEnteringItemIds("meeting-a", "meeting-b", new Set(["old"]), ["new"]).size).toBe(0);
    expect(findEnteringItemIds("meeting-a", "meeting-a", new Set(["old"]), ["old", "new"]))
      .toEqual(new Set(["new"]));
  });
});

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
  it("allows the packaged main frame when Chromium reports an opaque file origin", () => {
    expect(isTrustedRendererUrl("file:///Applications/MinuteFlow.app/Contents/Resources/app.asar/dist/client/index.html")).toBe(true);
    expect(isTrustedPermissionRequest({
      webContentsUrl: "file:///Applications/MinuteFlow.app/Contents/Resources/app.asar/dist/client/index.html",
      requestingOrigin: "null",
      requestingUrl: "file:///Applications/MinuteFlow.app/Contents/Resources/app.asar/dist/client/index.html",
      isMainFrame: true
    })).toBe(true);
    expect(isTrustedPermissionRequest({
      webContentsUrl: "file:///Applications/MinuteFlow.app/Contents/Resources/app.asar/dist/client/index.html",
      requestingOrigin: "null",
      requestingUrl: "",
      isMainFrame: true
    })).toBe(true);
  });

  it("allows only the configured development origin", () => {
    const developmentServerUrl = "http://127.0.0.1:5173";
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/?preview=desktop", developmentServerUrl)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/", developmentServerUrl)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173.evil.example/", developmentServerUrl)).toBe(false);
  });

  it("rejects embedded or explicitly untrusted media request frames", () => {
    const packagedWindow = "file:///Applications/MinuteFlow.app/Contents/Resources/app.asar/dist/client/index.html";
    expect(isTrustedPermissionRequest({
      webContentsUrl: packagedWindow,
      requestingUrl: "https://malicious.example/frame",
      isMainFrame: false
    })).toBe(false);
    expect(isTrustedPermissionRequest({
      webContentsUrl: packagedWindow,
      requestingUrl: "https://malicious.example/",
      isMainFrame: true
    })).toBe(false);
  });

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

  it("advances first-run authorization through deterministic phases", () => {
    const input = { screen: "denied" as const, systemAudioRequired: true, capturePrepared: false };
    expect(derivePermissionSetupPhase({ ...input, microphone: "not-determined" })).toBe("microphone");
    expect(derivePermissionSetupPhase({ ...input, microphone: "denied" })).toBe("microphone");
    expect(derivePermissionSetupPhase({ ...input, microphone: "granted" })).toBe("screen-settings");
    expect(derivePermissionSetupPhase({ ...input, microphone: "granted", returnedFromScreenSettings: true })).toBe("restart");
    expect(derivePermissionSetupPhase({ ...input, microphone: "granted", screen: "granted" })).toBe("verify");
    expect(derivePermissionSetupPhase({ ...input, microphone: "granted", screen: "granted", restartRequired: true })).toBe("restart");
    expect(derivePermissionSetupPhase({ ...input, microphone: "granted", screen: "granted", capturePrepared: true })).toBe("success");
    expect(derivePermissionSetupPhase({ ...input, microphone: "granted", systemAudioRequired: false })).toBe("success");
  });

  it("recognizes screen-permission failures that should return to restart guidance", () => {
    for (const name of ["NotAllowedError", "PermissionDeniedError", "SecurityError"]) {
      const error = new Error("screen denied");
      error.name = name;
      expect(isScreenPermissionError(error)).toBe(true);
    }
    expect(isScreenPermissionError({ name: "NotAllowedError" })).toBe(true);
    expect(isScreenPermissionError(new Error("no audio track"))).toBe(false);
  });

  it("reopens after a relaunch marker even when the prior flow was already complete", () => {
    expect(shouldOpenPermissionSetup({
      permissionSetupResume: true,
      systemPermissionsCompleted: true,
      permissionsVersion: 2
    })).toBe(true);
    expect(shouldOpenPermissionSetup({
      permissionSetupResume: false,
      systemPermissionsCompleted: true,
      permissionsVersion: 2
    })).toBe(false);
    expect(shouldOpenPermissionSetup({
      permissionSetupResume: false,
      systemPermissionsCompleted: false,
      permissionsVersion: 2
    })).toBe(true);
  });

  it("clears the relaunch marker when setup is completed or skipped", () => {
    const preferences = {
      summaryIntervalSeconds: 60,
      summaryCadenceVersion: 1,
      defaultMode: "online" as const,
      glossary: [],
      retentionDays: null,
      onboardingCompleted: false,
      systemPermissionsCompleted: false,
      permissionsVersion: 0,
      permissionSetupResume: true,
      modelDownloadSourceKind: "official" as const,
      modelDownloadCustomBase: ""
    };
    expect(finishPermissionSetup(preferences)).toMatchObject({
      systemPermissionsCompleted: true,
      permissionsVersion: 2,
      permissionSetupResume: false
    });
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

describe("adaptive import chunk planning", () => {
  it("falls back to the nominal 10s grid when no silence is available", () => {
    expect(planTranscriptionChunkBoundaries(35_000)).toEqual([0, 10_000, 20_000, 30_000]);
    expect(planTranscriptionChunkBoundaries(5_000)).toEqual([0]);
  });

  it("snaps each boundary to the nearest silence midpoint inside the search window", () => {
    const boundaries = planTranscriptionChunkBoundaries(40_000, [30_500, 11_200, 19_000]);
    expect(boundaries).toEqual([0, 11_200, 19_000, 30_500]);
    for (let index = 1; index < boundaries.length; index += 1) {
      const length = boundaries[index] - boundaries[index - 1];
      expect(length).toBeGreaterThanOrEqual(7_000);
      expect(length).toBeLessThanOrEqual(13_000);
    }
  });

  it("ignores silences below the minimum chunk length or outside the snap window", () => {
    expect(planTranscriptionChunkBoundaries(30_000, [5_000, 14_000, 25_000])).toEqual([0, 10_000, 20_000]);
  });

  it("pairs silencedetect events in order and drops unclosed or tail-adjacent silences", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 3.2",
      "[silencedetect @ 0x1] silence_end: 3.9 | silence_duration: 0.7",
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.51",
      "[silencedetect @ 0x1] silence_start: 12.05",
      "[silencedetect @ 0x1] silence_end: 12.45 | silence_duration: 0.4",
      "[silencedetect @ 0x1] silence_start: 59.8"
    ].join("\n");
    expect(parseSilenceMidpoints(stderr, 60_000)).toEqual([245, 3_550, 12_250]);
    expect(parseSilenceMidpoints("no events here", 60_000)).toEqual([]);
  });
});

describe("typewriter pacing", () => {
  it("scales the per-take character budget with the backlog within 40..160 cps", () => {
    expect(plannedCharacters("")).toBe(0);
    expect(plannedCharacters("五个字")).toBeGreaterThanOrEqual(1);
    expect(plannedCharacters("六".repeat(400))).toBe(Math.round((160 * 40) / 1000));
  });

  it("cuts at sentence and comma punctuation with proportional pauses", () => {
    expect(punctuationCut("然后我们继续。之后")).toEqual({ emit: "然后我们继续。", pauseTicks: 3 });
    expect(punctuationCut("首先，")).toEqual({ emit: "首先，", pauseTicks: 1 });
    expect(punctuationCut("没有任何标点符号出现")).toBeNull();
    // 每拍字数按缓冲长度计（40 字/秒 × 40ms ≈ 2 字/拍）：标点落在拍内即切分。
    const step = typewriterStep("一。后面的内容还在缓冲里慢慢排队");
    expect(step?.emit).toBe("一。");
    expect(step?.pauseTicks).toBe(3);
  });
});

describe("transcript streaming reveal", () => {
  const drainAll = (segments: TranscriptSegment[], state: ReturnType<typeof emptyRevealState>) => {
    const emitted: string[] = [];
    for (let guard = 0; guard < 5_000; guard += 1) {
      const tick = revealTick(segments, state);
      if (!tick) {
        if (!revealPending(state)) break;
        continue;
      }
      emitted.push(tick.emit);
    }
    return emitted.join("");
  };

  it("seeds existing content as fully revealed and streams only new arrivals", () => {
    const state = seedTranscriptReveal([segment("a", 0, 5_000, "已有内容")], emptyRevealState(), true);
    expect(revealPending(state)).toBe(false);
    absorbTranscriptSegments([segment("a", 0, 5_000, "已有内容"), segment("b", 6_000, 12_000, "新到达的句子。")], state, true);
    expect(state.queue).toEqual(["b"]);
    const shown = displayedTranscriptSegments([segment("a", 0, 5_000, "已有内容"), segment("b", 6_000, 12_000, "新到达的句子。")], state);
    expect(shown[0].text).toBe("已有内容");
    expect(shown[1].text).toBe("");
    const all = drainAll([segment("a", 0, 5_000, "已有内容"), segment("b", 6_000, 12_000, "新到达的句子。")], state);
    expect(all).toBe("新到达的句子。");
    expect(revealPending(state)).toBe(false);
  });

  it("queues appended text on an already-revealed segment and reveals segments in arrival order", () => {
    const state = seedTranscriptReveal([segment("a", 0, 5_000, "开头")], emptyRevealState(), true);
    absorbTranscriptSegments([segment("a", 0, 8_000, "开头继续补充的半句话，")], state, true);
    absorbTranscriptSegments([segment("a", 0, 8_000, "开头继续补充的半句话，"), segment("b", 9_000, 15_000, "下一段。")], state, true);
    expect(state.queue).toEqual(["a", "b"]);
    const firstTick = revealTick([segment("a", 0, 8_000, "开头继续补充的半句话，"), segment("b", 9_000, 15_000, "下一段。")], state);
    expect(firstTick?.id).toBe("a");
    expect(firstTick?.emit).toBe("继续");
    const drained = (firstTick?.emit ?? "") + drainAll([segment("a", 0, 8_000, "开头继续补充的半句话，"), segment("b", 9_000, 15_000, "下一段。")], state);
    expect(drained).toBe("继续补充的半句话，下一段。");
  });

  it("snaps shortened rewrites into place instead of retyping", () => {
    const state = seedTranscriptReveal([segment("a", 0, 5_000, "很长的一段临时转写文本")], emptyRevealState(), true);
    absorbTranscriptSegments([segment("a", 0, 5_000, "修正后的文本")], state, true);
    expect(state.queue).toEqual([]);
    expect(displayedTranscriptSegments([segment("a", 0, 5_000, "修正后的文本")], state)[0].text).toBe("修正后的文本");
  });

  it("passes everything through once the session is no longer active", () => {
    const state = seedTranscriptReveal([segment("a", 0, 5_000, "已有内容")], emptyRevealState(), true);
    absorbTranscriptSegments([segment("a", 0, 5_000, "已有内容追加"), segment("b", 9_000, 15_000, "新句子。")], state, true);
    absorbTranscriptSegments([segment("a", 0, 5_000, "已有内容追加"), segment("b", 9_000, 15_000, "新句子。")], state, false);
    expect(revealPending(state)).toBe(false);
    const shown = displayedTranscriptSegments([segment("a", 0, 5_000, "已有内容追加"), segment("b", 9_000, 15_000, "新句子。")], state);
    expect(shown.map((item) => item.text)).toEqual(["已有内容追加", "新句子。"]);
  });

  it("seeds inactive sessions fully so history never typewrites", () => {
    const state = seedTranscriptReveal([segment("a", 0, 5_000, "历史内容")], emptyRevealState(), false);
    absorbTranscriptSegments([segment("a", 0, 9_000, "历史内容新增了尾巴")], state, false);
    expect(revealPending(state)).toBe(false);
    expect(displayedTranscriptSegments([segment("a", 0, 9_000, "历史内容新增了尾巴")], state)[0].text).toBe("历史内容新增了尾巴");
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

  it("merges one utterance across transport windows and breaks on a topic opener", () => {
    const grouped = groupTranscriptSegments([
      segment("chunk-0", 0, 8_000, "我们先确认目标，"),
      segment("chunk-1", 8_000, 16_000, "再看执行路径。"),
      segment("chunk-2", 16_000, 24_000, "接下来讨论风险。")
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      id: "chunk-0",
      startMs: 0,
      endMs: 16_000,
      text: "我们先确认目标，再看执行路径。"
    });
    expect(grouped[1].text).toBe("接下来讨论风险。");
  });

  it("breaks natural paragraphs on speaker changes, 1.5 second pauses, and hard punctuation", () => {
    const changedSpeaker = { ...segment("speaker-2", 4_000, 6_000, "我补充一点。"), speakerId: "speaker-2" };
    const grouped = groupTranscriptSegments([
      segment("question", 0, 2_000, "这个方案可行吗？"),
      segment("answer", 2_000, 3_500, "可以。"),
      changedSpeaker,
      { ...segment("after-pause", 7_500, 9_000, "继续。"), speakerId: "speaker-2" }
    ]);
    expect(grouped.map((item) => item.id)).toEqual(["question", "answer", "speaker-2", "after-pause"]);
  });

  it("uses two sentences as a soft boundary and preserves the first fragment id", () => {
    const grouped = groupTranscriptSegments([
      segment("first", 0, 2_000, "第一句。"),
      segment("second", 2_000, 4_000, "第二句。"),
      segment("third", 4_000, 6_000, "第三句。")
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ id: "first", text: "第一句。第二句。" });
    expect(grouped[1].id).toBe("third");
  });

  it("splits a flat provider response into proportional timestamped sentences", () => {
    const fragments = splitTimedTranscriptText("先确认。然后继续！最后收尾", 10_000, 20_000);
    expect(fragments.map((item) => item.text)).toEqual(["先确认。", "然后继续！", "最后收尾"]);
    expect(fragments[0].startMs).toBe(10_000);
    expect(fragments.at(-1)?.endMs).toBe(20_000);
    expect(fragments.every((item, index) => index === 0 || item.startMs === fragments[index - 1].endMs)).toBe(true);
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
    // 未匹配声纹库的聚类用「发言人N」占位，等用户在转写里改名注册声纹。
    expect(result.map((item) => item.speakerName)).toEqual(["发言人1", "发言人2"]);
  });

  it("assigns gap segments to the temporally nearest turn instead of keeping a colliding legacy label", () => {
    const turns = [
      { startMs: 0, endMs: 4_000, speakerId: "speaker-1" },
      { startMs: 8_000, endMs: 12_000, speakerId: "speaker-2" }
    ];
    // 4000–8000 是轮次间隙：靠前段归 speaker-1、靠后段归 speaker-2，
    // 不能沿用旧的 speaker-1（会与分离出的 speaker-1 撞 id 出现双名）。
    const result = applyDiarization([
      segment("gap-late", 4_200, 6_000, "间隙偏后"),
      segment("gap-early", 6_100, 7_900, "间隙偏前"),
      segment("second", 9_000, 10_000, "第二位发言")
    ], turns);
    expect(result[0].speakerId).toBe("speaker-1");
    expect(result[1].speakerId).toBe("speaker-2");
    expect(result[2].speakerId).toBe("speaker-2");
    expect(new Set(result.map((item) => item.speakerId)).size).toBe(2);
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

describe("diarization cluster merging", () => {
  const turn = (startMs: number, endMs: number, speakerId: string) => ({ startMs, endMs, speakerId });
  const sameVoice = Float32Array.from([1, 0]);
  const sameVoiceDrifted = Float32Array.from([0.95, 0.05]);
  const otherVoice = Float32Array.from([0, 1]);

  it("merges same-speaker clusters above the similarity threshold and relabels densely by first appearance", () => {
    const merged = mergeDiarizationClusters(
      [turn(0, 90_000, "a"), turn(95_000, 150_000, "b"), turn(160_000, 170_000, "c")],
      new Map([["a", sameVoice], ["b", sameVoiceDrifted], ["c", otherVoice]])
    );
    expect(new Set(merged.map((item) => item.speakerId)).size).toBe(2);
    expect(merged[0].speakerId).toBe("speaker-1");
    expect(merged[1].speakerId).toBe("speaker-1");
    expect(merged[2].speakerId).toBe("speaker-2");
  });

  it("keeps distinct speakers separate", () => {
    const merged = mergeDiarizationClusters(
      [turn(0, 90_000, "a"), turn(95_000, 150_000, "b")],
      new Map([["a", sameVoice], ["b", otherVoice]])
    );
    expect(new Set(merged.map((item) => item.speakerId)).size).toBe(2);
  });

  it("folds short fragments into the most similar cluster", () => {
    const merged = mergeDiarizationClusters(
      [turn(0, 90_000, "a"), turn(95_000, 150_000, "b"), turn(151_000, 154_000, "f")],
      new Map([["a", sameVoice], ["b", otherVoice], ["f", sameVoiceDrifted]])
    );
    expect(new Set(merged.map((item) => item.speakerId)).size).toBe(2);
    expect(merged.find((item) => item.startMs === 151_000)?.speakerId).toBe("speaker-1");
  });

  it("folds unembeddable fragments into the time-adjacent cluster", () => {
    const merged = mergeDiarizationClusters(
      [turn(0, 90_000, "a"), turn(95_000, 150_000, "b"), turn(150_500, 151_500, "n")],
      new Map([["a", sameVoice], ["b", otherVoice], ["n", null]])
    );
    expect(new Set(merged.map((item) => item.speakerId)).size).toBe(2);
    expect(merged.find((item) => item.startMs === 150_500)?.speakerId)
      .toBe(merged.find((item) => item.startMs === 95_000)?.speakerId);
  });

  it("resolves chained merges through cluster roots", () => {
    const merged = mergeDiarizationClusters(
      [turn(0, 90_000, "a"), turn(95_000, 150_000, "b"), turn(150_200, 150_800, "f")],
      new Map([["a", sameVoice], ["b", sameVoiceDrifted], ["f", null]])
    );
    expect(new Set(merged.map((item) => item.speakerId)).size).toBe(1);
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

  it("backfills unique ids for AI action items that omit them", () => {
    const summary = validateSummary({
      topics: ["上线准备"],
      actionItems: [
        { title: "输出发布清单", owner: "刘婷", dueDate: "周五", status: "todo", done: false },
        { title: "回归核心链路", owner: "周哲", dueDate: "周四", status: "todo", done: false },
        { id: "keep-me", title: "通知客服团队", owner: "王敏", dueDate: "周四", status: "done", done: true }
      ]
    });
    expect(summary.actionItems.map((item) => item.id)).toEqual(
      [expect.any(String), expect.any(String), "keep-me"]);
    expect(summary.actionItems[0].id).not.toBe(summary.actionItems[1].id);
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
      "ggml-medium.en",
      "diarization-pyannote-segmentation",
      "diarization-eres2netv2-zh"
    ]);
    // Whisper 项全部走 whisper-cpp；声纹项单独成组。
    expect(catalog.filter((model) => model.group !== "diarization")
      .every((model) => model.engine === "whisper-cpp" && model.installed === false)).toBe(true);
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

  it("offers verified diarization models with per-source direct URLs", async () => {
    const catalog = await listDownloadableModels("/nonexistent/minuteflow-model-catalog");
    const segmentation = catalog.find((model) => model.id === "diarization-pyannote-segmentation");
    const embedding = catalog.find((model) => model.id === "diarization-eres2netv2-zh");
    expect(segmentation).toMatchObject({
      group: "diarization",
      engine: "diarization",
      format: "ONNX",
      sizeBytes: 1_540_506,
      digest: "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d"
    });
    expect(embedding).toMatchObject({
      group: "diarization",
      sizeBytes: 71_441_526,
      // 摘要与 sherpa-onnx 官方 release checksum.txt 一致。
      digest: "bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239"
    });
    // 分离模型远端文件名（model.int8.onnx）与本地存储名不同：模板替换必须用远端名。
    expect(buildModelDownloadUrl(segmentation!, "https://cdn.example.com/{fileName}")).toBe(
      "https://cdn.example.com/model.int8.onnx"
    );
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
      "https://zensoft.top/minuteflow/releases/latest-windows.json",
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

  it("tolerates string-serialized section numbers and schemaVersion from compatible gateways", () => {
    const result = validateVisualSummary({
      ...visualPayload,
      schemaVersion: "1",
      sections: [
        { ...visualPayload.sections[0], number: "1" },
        { ...visualPayload.sections[1], number: "02" }
      ]
    });
    expect(result.sections.map((section) => section.number)).toEqual([1, 2]);
  });

  it("falls back gracefully when the model reports an unparsable section number", () => {
    const result = validateVisualSummary({
      ...visualPayload,
      sections: [
        { ...visualPayload.sections[0], number: "一" },
        { ...visualPayload.sections[1], number: null }
      ]
    });
    expect(result.sections.map((section) => section.number)).toEqual([1, 2]);
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

describe("chat system prompt", () => {
  it("packs meeting context and groundedness rules into the prompt", () => {
    const prompt = buildChatSystemPrompt({
      title: "季度复盘",
      participants: ["小林", "小周"],
      goals: ["对齐下季度目标"],
      notes: [],
      summary: { topics: [], keyPoints: ["Q3 增长 12%"], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [], stale: false },
      transcriptText: "[00:10] 小林：Q3 增长 12%。"
    });
    expect(prompt).toContain("季度复盘");
    expect(prompt).toContain("小林、小周");
    expect(prompt).toContain("对齐下季度目标");
    expect(prompt).toContain("Q3 增长 12%");
    expect(prompt).toContain("[00:10] 小林：Q3 增长 12%。");
    // 不编造 + 纯文本回答是问答路径的核心约束，必须写进系统提示。
    expect(prompt).toContain("不要编造");
    expect(prompt).not.toContain("只输出");
  });

  it("tolerates missing context fields without crashing", () => {
    const prompt = buildChatSystemPrompt({});
    expect(prompt).toContain("会议标题：");
    expect(prompt).toContain("转写记录：");
    expect(prompt).not.toContain("undefined");
  });
});

describe("findPlayingSegment", () => {
  const seg = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs, speakerId: "s", speakerName: "S", text: id, status: "final" as const });

  it("定位播放位置所在的段落", () => {
    const segments = [seg("a", 0, 5_000), seg("b", 5_000, 9_000), seg("c", 12_000, 20_000)];
    expect(findPlayingSegment(segments, 1)?.id).toBe("a");
    expect(findPlayingSegment(segments, 4_999)?.id).toBe("a");
    expect(findPlayingSegment(segments, 5_000)?.id).toBe("b");
    expect(findPlayingSegment(segments, 19_999)?.id).toBe("c");
  });

  it("段落间隙（沉默）保留上一段高亮，直到下一段开始", () => {
    const segments = [seg("a", 0, 5_000), seg("b", 12_000, 20_000)];
    expect(findPlayingSegment(segments, 9_000)?.id).toBe("a");
    expect(findPlayingSegment(segments, 11_999)?.id).toBe("a");
    expect(findPlayingSegment(segments, 12_000)?.id).toBe("b");
  });

  it("末段结束后的间隙仍指向末段，转写之外与播放前返回 null", () => {
    const segments = [seg("a", 0, 5_000), seg("b", 6_000, 9_000)];
    expect(findPlayingSegment(segments, 60_000)?.id).toBe("b");
    expect(findPlayingSegment(segments, -3)).toBeNull();
    expect(findPlayingSegment([], 1_000)).toBeNull();
    expect(findPlayingSegment(segments, 0)).toBeNull();
  });
});

describe("extractChatResponse", () => {
  it("拆出 OpenAI 兼容响应里的 reasoning_content，正文保持独立", () => {
    const result = extractChatResponse({
      choices: [{ message: { content: "**结论**如下", reasoning_content: "先查纪要再核对转写" } }]
    });
    expect(result.content).toBe("**结论**如下");
    expect(result.reasoning).toBe("先查纪要再核对转写");
  });

  it("把内联 <think> 标签拆为思考过程，未闭合时其后全部视为思考", () => {
    const closed = extractChatResponse({
      choices: [{ message: { content: "<think>推理 A</think>答案是列表页延迟" } }]
    });
    expect(closed.content).toBe("答案是列表页延迟");
    expect(closed.reasoning).toBe("推理 A");
    const unclosed = extractChatResponse({
      choices: [{ message: { content: "答案前半<think>还没想完的推理" } }]
    });
    expect(unclosed.content).toBe("答案前半");
    expect(unclosed.reasoning).toBe("还没想完的推理");
  });

  it("Anthropic thinking 块进思考、text 块拼正文；Gemini thought 片段同理", () => {
    const anthropic = extractChatResponse({
      content: [
        { type: "thinking", thinking: "先定位行动项" },
        { type: "text", text: "共 3 个行动项" }
      ]
    });
    expect(anthropic.content).toBe("共 3 个行动项");
    expect(anthropic.reasoning).toBe("先定位行动项");
    const gemini = extractChatResponse({
      candidates: [{ content: { parts: [
        { text: "思考片段", thought: true },
        { text: "最终回答" }
      ] } }]
    });
    expect(gemini.content).toBe("最终回答");
    expect(gemini.reasoning).toBe("思考片段");
  });

  it("无思考过程的普通响应只返回 content，不产生 reasoning", () => {
    const plain = extractChatResponse({ choices: [{ message: { content: "普通回答" } }] });
    expect(plain.content).toBe("普通回答");
    expect(plain.reasoning).toBeUndefined();
    const wrapped = extractChatResponse({ data: { choices: [{ message: { content: "网关包装", reasoning: "r" } }] } });
    expect(wrapped.content).toBe("网关包装");
    expect(wrapped.reasoning).toBe("r");
  });
});

describe("createChatStreamAccumulator", () => {
  it("跨块拆开的 <think> 标签不会把半截标签漏进正文增量", () => {
    const acc = createChatStreamAccumulator();
    const emissions = [
      acc.push({ content: "答案前" }),
      acc.push({ content: "<th" }),
      acc.push({ content: "ink>推理" }),
      acc.push({ content: "过程</th" }),
      acc.push({ content: "ink>可见回答" })
    ];
    const streamedContent = emissions.map((e) => e.content ?? "").join("");
    const streamedReasoning = emissions.map((e) => e.reasoning ?? "").join("");
    expect(streamedContent).not.toContain("<");
    expect(streamedContent).toBe("答案前可见回答");
    expect(streamedReasoning).toBe("推理过程");
    expect(acc.finish()).toEqual({ content: "答案前可见回答", reasoning: "推理过程" });
  });

  it("reasoning 字段增量单调累积，finish 去除首尾空白", () => {
    const acc = createChatStreamAccumulator();
    acc.push({ reasoning: "先查纪要 " });
    acc.push({ reasoning: "再核对转写 " });
    acc.push({ content: " 回答正文 " });
    expect(acc.finish()).toEqual({ content: "回答正文", reasoning: "先查纪要 再核对转写" });
  });

  it("空增量与无效载荷返回空对象，不影响已输出内容", () => {
    const acc = createChatStreamAccumulator();
    expect(acc.push({})).toEqual({});
    expect(acc.push({ content: "abc" }).content).toBe("abc");
    expect(acc.push({})).toEqual({});
    expect(acc.finish().content).toBe("abc");
  });
});

describe("chat 流式请求默认值", () => {
  const sseResponse = (events: string[]) => new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  const chatProfile = {
    name: "问答模型",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    model: "qwen-plus",
    options: {},
    enabled: true
  } as const;

  it("OpenAI 兼容问答默认发出流式请求（stream:true + SSE Accept 头）并逐段回调", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先查纪要" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "第一点，" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "增长 12%。" } }] })}\n\n`,
      "data: [DONE]\n\n"
    ]));
    const deltas: Array<{ content?: string; reasoning?: string }> = [];
    const result = await chatWithMeetingContext(
      chatProfile,
      "sk-test",
      { question: "Q3 表现如何？", context: {} },
      (delta) => deltas.push(delta)
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Accept: "text/event-stream" });
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.map((delta) => delta.content ?? "").join("")).toBe("第一点，增长 12%。");
    expect(deltas.some((delta) => delta.reasoning === "先查纪要")).toBe(true);
    expect(result.content).toBe("第一点，增长 12%。");
    expect(result.reasoning).toBe("先查纪要");
    fetchMock.mockRestore();
  });

  it("Anthropic 原生问答同样默认 stream:true，thinking/text 增量分流入对应字段", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先定位行动项" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "共 2 个行动项。" } })}\n\n`
    ]));
    const deltas: Array<{ content?: string; reasoning?: string }> = [];
    const result = await chatWithMeetingContext(
      { ...chatProfile, transport: "anthropic", baseUrl: "https://anthropic.example.com", options: { apiFlavor: "anthropic" } },
      "sk-ant-test",
      { question: "行动项有哪些？", context: {} },
      (delta) => deltas.push(delta)
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://anthropic.example.com/v1/messages");
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
    expect(deltas.map((delta) => delta.content ?? "").join("")).toBe("共 2 个行动项。");
    expect(result.content).toBe("共 2 个行动项。");
    expect(result.reasoning).toBe("先定位行动项");
    fetchMock.mockRestore();
  });
});
