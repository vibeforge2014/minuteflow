/**
 * 在线纪要的容错回归：真实网关（New API / 内网代理）对完整会议常需 1–3 分钟，
 * 且会间歇返回整页 HTML 的 502/504。旧实现用 60 秒超时、5xx 不重试、把 HTML
 * 原文拼进错误提示，导致「更新纪要」必然降级并弹出几万字符的报错。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  friendlyHttpError,
  generateVisualSummaryWithOpenAICompatible,
  summarizeWithOpenAICompatible,
  summaryRequestTimeoutMs,
  keyPointsRequestTimeoutMs
} from "../electron/services/providers.mjs";

const legacyProfile = {
  baseUrl: "https://gateway.example/v1",
  model: "slow-model",
  options: { timeoutMs: 60_000 }
};

const input = {
  title: "诊断会议",
  goals: [],
  notes: [],
  transcript: [
    { id: "t1", speakerName: "发言人 1", text: "下周三前完成接口联调，张三负责。", startMs: 0, endMs: 6000 }
  ],
  previousSummary: {}
};

const summaryJson = JSON.stringify({
  topics: [], keyPoints: ["接口联调｜下周三前完成，由张三负责"], decisions: [],
  actionItems: [], openQuestions: [], risks: [], nextSteps: []
});

const okResponse = () => new Response(
  JSON.stringify({ choices: [{ message: { content: summaryJson } }] }),
  { status: 200, headers: { "content-type": "application/json" } }
);

const gatewayHtml = `<!DOCTYPE html><html><head><title>504 Gateway Time-out</title>
<style>.wrap{background:url(data:image/png;base64,${"A".repeat(400)})}</style></head>
<body><center><h1>504 Gateway Time-out</h1></center></body></html>`;

afterEach(() => { vi.restoreAllMocks(); });

describe("在线纪要请求容错", () => {
  it("把旧档案的 60 秒超时抬到 300 秒下限，显式更长的配置仍生效", () => {
    expect(summaryRequestTimeoutMs(legacyProfile)).toBe(300_000);
    expect(summaryRequestTimeoutMs({ options: {} })).toBe(300_000);
    expect(summaryRequestTimeoutMs({ options: { timeoutMs: 600_000 } })).toBe(600_000);
  });

  it("深度提炼用更宽的 300 秒下限，显式更长的配置仍生效", () => {
    expect(keyPointsRequestTimeoutMs(legacyProfile)).toBe(300_000);
    expect(keyPointsRequestTimeoutMs({ options: {} })).toBe(300_000);
    expect(keyPointsRequestTimeoutMs({ options: { timeoutMs: 600_000 } })).toBe(600_000);
  });

  it("HTML 错误页只留标题与可见文字，不带标签和 base64", () => {
    const message = friendlyHttpError(504, gatewayHtml, null);
    expect(message).toMatch(/HTTP 504/);
    expect(message).toMatch(/504 Gateway Time-out/);
    expect(message).not.toMatch(/<html|<title|base64|AAAA/);
    expect(message.length).toBeLessThan(300);
    // 纯文本与 JSON 错误仍保留原有可读格式。
    expect(friendlyHttpError(502, "upstream error", "req-x")).toMatch(/upstream error · 请求标识 req-x/);
  });

  it("504 网关抖动时原样重试一次并成功，保留 response_format", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(gatewayHtml, { status: 504 }))
      .mockResolvedValueOnce(okResponse());
    const result = await summarizeWithOpenAICompatible(legacyProfile, "secret", input, false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(result.keyPoints).toHaveLength(1);
  });

  it("持续 5xx 时只重试一次，且抛出的错误是短提示而非整页 HTML", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response(gatewayHtml, { status: 502 })));
    await expect(summarizeWithOpenAICompatible(legacyProfile, "secret", input, false))
      .rejects.toThrow(/HTTP 502/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    try {
      await summarizeWithOpenAICompatible(legacyProfile, "secret", input, false);
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/<html|base64/);
    }
  });

  it("等满超时后给出可操作提示，且不重复发起请求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(summarizeWithOpenAICompatible(legacyProfile, "secret", input, false))
      .rejects.toThrow(/总结模型请求超时（300 秒）/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("默认用 SSE 流式请求，并把分片内容拼成完整 JSON 纪要", async () => {
    const half = Math.floor(summaryJson.length / 2);
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: summaryJson.slice(0, half) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: summaryJson.slice(half) } }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join("");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const result = await summarizeWithOpenAICompatible(legacyProfile, "secret", input, false);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
    expect(result.keyPoints).toHaveLength(1);
  });

  it("网关声称支持流式却没有任何内容时，退回最小请求体重试", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(okResponse());
    const result = await summarizeWithOpenAICompatible(legacyProfile, "secret", input, false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallback = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(fallback.stream).toBeUndefined();
    expect(fallback.response_format).toBeUndefined();
    expect(fallback.max_tokens).toBeUndefined();
    expect(result.keyPoints).toHaveLength(1);
  });

  it("网关点名不支持 stream 时只去掉该参数重试", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("stream is not supported", { status: 400 }))
      .mockResolvedValueOnce(okResponse());
    await summarizeWithOpenAICompatible(legacyProfile, "secret", input, false);
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retry.stream).toBeUndefined();
    expect(retry.response_format).toEqual({ type: "json_object" });
  });

  it("视觉纪要同样走 SSE 流式，避免第二阶段被网关 60 秒切断", async () => {
    const visualJson = JSON.stringify({
      schemaVersion: 1,
      title: "周会视觉纪要",
      subtitle: "聚焦接口联调",
      sections: [{
        id: "final-callout", number: 1, title: "会议定调", tone: "green",
        layout: "callout", callout: "下周三前完成接口联调。"
      }]
    });
    const half = Math.floor(visualJson.length / 2);
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: visualJson.slice(0, half) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: visualJson.slice(half) } }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join("");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const result = await generateVisualSummaryWithOpenAICompatible(
      { id: "visual-profile", ...legacyProfile }, "secret",
      { title: "诊断会议", participants: [], summary: { updatedAt: "2026-11-15T00:00:00.000Z" } }
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.stream).toBe(true);
    expect(result.sections).toHaveLength(1);
  });

  it("用户取消生成时不重试，原样抛出取消错误", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    await expect(summarizeWithOpenAICompatible(legacyProfile, "secret", input, false, controller.signal))
      .rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
