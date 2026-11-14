/**
 * 转写批量改写（查找替换 / 撤销替换）的回归测试。
 *
 * 历史问题：替换与撤销用渲染层持有的 meeting 快照整体回写，
 * 录音期间刚追加的段落会被旧快照覆盖掉。这里锁住两点：
 * 1. 改写发生在 store 的最新转写上，之后到达的段落必须保留；
 * 2. 返回实际改写条数，调用方才能给出准确的「已替换 N 处」提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "../src/types";

vi.mock("../src/lib/api", () => ({
  api: {
    meetings: {
      save: vi.fn(async (meeting: Meeting) => meeting),
      list: vi.fn(async () => [])
    }
  }
}));

const { useMeetingStore } = await import("../src/store/meetingStore");

function makeMeeting(): Meeting {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "周会",
    scheduledAt: "2026-11-15T10:00:00.000Z",
    participants: ["我"],
    goals: [],
    notes: [],
    mode: "offline",
    status: "complete",
    durationSeconds: 60,
    favorite: false,
    createdAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
    transcript: [
      { id: "s1", speakerId: "spk-1", speakerName: "我", startMs: 0, endMs: 4_000, text: "白名单还差一个人", status: "final" },
      { id: "s2", speakerId: "spk-1", speakerName: "我", startMs: 4_000, endMs: 8_000, text: "下周再对一次", status: "final" }
    ],
    summary: {
      topics: [],
      keyPoints: ["白名单是阻塞项"],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [],
      nextSteps: []
    }
  } as unknown as Meeting;
}

const meetingId = "11111111-1111-4111-8111-111111111111";

const segments = () => useMeetingStore.getState().meetings[0].transcript;

describe("store patchTranscript", () => {
  beforeEach(() => {
    // updateMeeting 的防抖落盘走 window.setTimeout；测试不推进定时器，避免真实写盘。
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (id: number) => clearTimeout(id)
    });
    useMeetingStore.setState({ meetings: [makeMeeting()], selectedId: meetingId, loading: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useMeetingStore.setState({ meetings: [], selectedId: null });
  });

  it("在最新转写上改写并返回改写条数", () => {
    const changed = useMeetingStore.getState().patchTranscript(meetingId, (segment) =>
      segment.id === "s1" ? segment.text.replace("白名单", "允许名单") : null);

    expect(changed).toBe(1);
    expect(segments()[0].text).toBe("允许名单还差一个人");
    expect(segments()[1].text).toBe("下周再对一次");
  });

  it("不覆盖快照之后追加的段落", () => {
    // 模拟「替换快照已生成、录音又追加了一段」的时序。
    const snapshot = makeMeeting();
    useMeetingStore.setState({
      meetings: [{
        ...snapshot,
        transcript: [...snapshot.transcript, {
          id: "s3", speakerId: "spk-2", speakerName: "发言人 2",
          startMs: 8_000, endMs: 12_000, text: "我来补签字", status: "final"
        }]
      }]
    });

    useMeetingStore.getState().patchTranscript(meetingId, (segment) =>
      segment.id === "s1" ? "允许名单还差一个人" : null);

    expect(segments().map((segment) => segment.id)).toEqual(["s1", "s2", "s3"]);
    expect(segments()[2].text).toBe("我来补签字");
  });

  it("改写逐字稿后把纪要标记为过期", () => {
    useMeetingStore.getState().patchTranscript(meetingId, () => "改写后的文本");
    expect(useMeetingStore.getState().meetings[0].summary.stale).toBe(true);
  });

  it("没有命中时不改动 state，也不把纪要标成过期", () => {
    const before = useMeetingStore.getState().meetings[0];
    const changed = useMeetingStore.getState().patchTranscript(meetingId, () => null);

    expect(changed).toBe(0);
    expect(useMeetingStore.getState().meetings[0]).toBe(before);
    expect(useMeetingStore.getState().meetings[0].summary.stale).toBeUndefined();
  });
});
