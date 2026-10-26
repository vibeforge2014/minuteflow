/**
 * 导入任务档案解析与转写路由的纯逻辑单元测试。
 *
 * 背景（线上问题）：导入转写分派漏了 apple-speech，切块被送进 transcribeRemote，
 * 拿空 baseUrl 发 HTTP 请求报「网络错误」，看起来像在用远程 Whisper；同时导入抽屉
 * 只列「已启用」档案，被单启用顶替的用户配置无从选择。这里的用例锁死两条规则：
 * 1) apple-speech 是本机引擎，路由永远不是 remote；
 * 2) 任务显式钉住的档案（含未启用）优先于全局启用项。
 */
import { describe, expect, it } from "vitest";
import { importTranscriptionRoute, resolveJobProfile } from "../electron/services/import-profiles.mjs";

const appleSpeech = { id: "stt-apple", kind: "stt", transport: "apple-speech", enabled: true };
const newApiWhisper = { id: "stt-newapi", kind: "stt", transport: "openai", enabled: false };
const localWhisper = { id: "stt-cpp", kind: "stt", transport: "whisper-cpp", enabled: false };
const llmProfile = { id: "llm-1", kind: "llm", transport: "openai", enabled: true };
const profiles = [appleSpeech, newApiWhisper, localWhisper, llmProfile];

describe("resolveJobProfile", () => {
  it("显式钉住的档案优先，即使它当前未启用（导入是任务级选择）", () => {
    expect(resolveJobProfile(profiles, "stt", "stt-newapi")).toBe(newApiWhisper);
  });

  it("未钉住时回落到当前启用的档案", () => {
    expect(resolveJobProfile(profiles, "stt", undefined)).toBe(appleSpeech);
    expect(resolveJobProfile(profiles, "llm", undefined)).toBe(llmProfile);
  });

  it("钉住的档案已被删除时回落启用项，任务不悬死在等待态", () => {
    expect(resolveJobProfile(profiles, "stt", "stt-deleted")).toBe(appleSpeech);
  });

  it("kind 过滤：钉住的 id 不跨类别命中", () => {
    expect(resolveJobProfile(profiles, "llm", "stt-apple")).toBe(llmProfile);
  });

  it("该类别没有任何档案时返回 null（任务进入 waiting_for_model）", () => {
    expect(resolveJobProfile([llmProfile], "stt", undefined)).toBeNull();
    expect(resolveJobProfile([], "stt", "stt-apple")).toBeNull();
  });
});

describe("importTranscriptionRoute", () => {
  it("apple-speech 是本机引擎，绝不能路由到 remote（线上网络错误的回归点）", () => {
    expect(importTranscriptionRoute("apple-speech")).toBe("apple-speech");
  });

  it("本机 Whisper 四种运行时归入 whisper 路径（先解析模型文件）", () => {
    for (const transport of ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"]) {
      expect(importTranscriptionRoute(transport)).toBe("whisper");
    }
  });

  it("OpenAI 兼容等在线传输走 remote", () => {
    expect(importTranscriptionRoute("openai")).toBe("remote");
  });
});
