import { afterEach, describe, expect, it, vi } from "vitest";
import { markdown, subtitle } from "../electron/services/formatters.mjs";
import {
  resolveProviderEndpoint,
  summarizeLocally,
  transcribeRemote,
  validateSummary
} from "../electron/services/providers.mjs";
import { describeLocalModel, looksLikeWhisperModel } from "../electron/services/local-models.mjs";
import { applyDiarization } from "../electron/services/diarization.mjs";
import {
  checkForMacUpdate,
  compareVersions,
  validateMacUpdateManifest
} from "../electron/services/updates.mjs";
import { mergeSpeakerLabels, mergeTranscriptSegments } from "../src/lib/transcript";
import { lockSummaryField, mergeSummaryRevision } from "../src/lib/summary";
import type { Meeting, TranscriptSegment } from "../src/types";

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
});

describe("model provider compatibility", () => {
  it("normalizes New API base URLs with or without /v1", () => {
    const base = { baseUrl: "https://new-api.example", options: {} };
    expect(resolveProviderEndpoint(base, "chat/completions"))
      .toBe("https://new-api.example/v1/chat/completions");
    expect(resolveProviderEndpoint({ ...base, baseUrl: "https://new-api.example/v1/" }, "audio/transcriptions"))
      .toBe("https://new-api.example/v1/audio/transcriptions");
  });

  it("falls back to the alternate New API transcription endpoint and unwraps data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
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
      "https://new-api.example/v1/audio/transcriptions",
      "https://new-api.example/v1/audio/openai/create-transcription"
    ]);
    expect(result.text).toBe("测试转录");
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
});

describe("macOS website updates", () => {
  const updateManifest = {
    schemaVersion: 1,
    version: "0.2.0",
    platform: "darwin",
    architectures: ["arm64"],
    publishedAt: "2026-08-02T06:20:37Z",
    notes: "更新说明",
    downloadUrl: "../downloads/macos/latest/",
    releasePageUrl: "https://github.com/vibeforge2014/meeting-assistant/releases/tag/v0.2.0",
    assetUrl: "https://github.com/vibeforge2014/meeting-assistant/releases/download/v0.2.0/app.dmg",
    sha256: "abc"
  };

  it("compares stable and prerelease semantic versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.1")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0-beta.2")).toBe(1);
  });

  it("rejects update manifests that point outside official HTTPS hosts", () => {
    expect(() => validateMacUpdateManifest({
      ...updateManifest,
      downloadUrl: "https://example.com/app.dmg"
    })).toThrow("受信任");
  });

  it("detects a newer compatible macOS release from the website manifest", async () => {
    const result = await checkForMacUpdate({
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
      update: { version: "0.2.0" }
    });
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
