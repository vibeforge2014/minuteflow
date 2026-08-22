/**
 * 核心单元测试（vitest，npm test）：覆盖主进程纯函数与渲染层纯逻辑——
 * formatters（Markdown/字幕）、providers（端点解析/总结/转写/校验/重试策略/JSON 提取）、
 * local-models（模型识别与目录）、diarization（轮次回填）、updates（版本比较与清单校验）、
 * lib/transcript（段落合并/说话人合并）、lib/summary（纪要锁/解锁与修订合并）、
 * database（转录段差量持久化，electron 以临时目录 mock）。
 * 网络与子进程调用均以 vi.fn()/vi.stubGlobal() 模拟，不产生真实请求。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdown, subtitle } from "../electron/services/formatters.mjs";
import {
  buildSummaryPrompt,
  extractJson,
  resolveProviderEndpoint,
  summarizeWithOpenAICompatible,
  summarizeLocally,
  testModelProfile,
  transcribeRemote,
  validateSummary
} from "../electron/services/providers.mjs";
import { describeLocalModel, listDownloadableModels, looksLikeWhisperModel } from "../electron/services/local-models.mjs";
import { applyDiarization } from "../electron/services/diarization.mjs";
import {
  checkForAppUpdate,
  compareVersions,
  normalizeGitHubRelease,
  updateManifestUrls,
  validateUpdateManifest
} from "../electron/services/updates.mjs";
import { groupTranscriptSegments, mergeSpeakerLabels, mergeTranscriptSegments } from "../src/lib/transcript";
import { groupLibraryMeetings, splitHighlight } from "../src/lib/library";
import { simplifyChinese } from "../src/lib/chinese";
import { isMicrophonePermissionError, shouldRequestMicrophone } from "../src/lib/permissions";
import { lockSummaryField, mergeSummaryRevision, toggleSummaryLock, unlockSummaryField } from "../src/lib/summary";
import { normalizeImportChunkSegments } from "../electron/services/import-queue.mjs";
import { audioContentType, parseByteRange } from "../electron/services/media.mjs";
import type { Meeting, TranscriptSegment } from "../src/types";

// database.mjs 只依赖 electron 的 app.getPath；用进程隔离的临时目录 mock 掉，
// 使差量持久化测试可以真实跑 node:sqlite（不依赖 Electron 运行时）。
vi.mock("electron", () => ({
  app: { getPath: () => `/tmp/minuteflow-db-test-${process.pid}` }
}));
import { listMeetings, loadMeeting, saveMeeting } from "../electron/database.mjs";

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

  it("offers the common multilingual Whisper model range with sha256 digests", async () => {
    const catalog = await listDownloadableModels("/nonexistent/minuteflow-model-catalog");
    expect(catalog.map((model) => model.id)).toEqual([
      "ggml-tiny",
      "ggml-base",
      "ggml-small",
      "ggml-medium",
      "ggml-large-v3-turbo-q5_0",
      "ggml-large-v3-turbo",
      "ggml-large-v3"
    ]);
    expect(catalog.every((model) => model.engine === "whisper-cpp" && model.installed === false)).toBe(true);
    // 摘要算法必须是 sha256（体积与 HuggingFace 官方仓库逐一核对）。
    expect(catalog.every((model) => model.digestAlgorithm === "sha256")).toBe(true);
    expect(catalog.find((model) => model.id === "ggml-base")?.sizeBytes).toBe(147_951_465);
    expect(catalog.find((model) => model.id === "ggml-large-v3")?.sizeBytes).toBe(3_095_033_483);
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
});
