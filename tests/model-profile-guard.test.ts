import { describe, expect, it } from "vitest";
import {
  assertEndpointOverrides,
  assertSafeHttpUrl,
  resolveProfileCredential
} from "../electron/services/model-profile-guard.mjs";

const savedProfiles = [
  { id: "stt-1", secretId: "secret-1", baseUrl: "https://api.example.com/v1" }
];

describe("模型服务地址校验", () => {
  it("只接受 http(s) 并拒绝云元数据与链路本地地址", () => {
    expect(assertSafeHttpUrl("https://api.example.com/v1").hostname).toBe("api.example.com");
    expect(() => assertSafeHttpUrl("file:///etc/passwd")).toThrow(/http\(s\)/);
    expect(() => assertSafeHttpUrl("http://169.254.169.254/latest/meta-data/x.bin")).toThrow(/不允许/);
    expect(() => assertSafeHttpUrl("https://metadata.google.internal/computeMetadata")).toThrow(/不允许/);
    expect(() => assertSafeHttpUrl("ftp://example.com/model.bin")).toThrow(/http\(s\)/);
  });

  it("拒绝把自定义端点覆盖到另一个域名", () => {
    expect(() => assertEndpointOverrides(
      { options: { chatEndpoint: "https://attacker.test/v1/chat/completions" } },
      "https://api.example.com/v1"
    )).toThrow(/同一域名/);
    expect(() => assertEndpointOverrides(
      { options: { chatEndpoint: "https://api.example.com/custom" } },
      "https://api.example.com/v1"
    )).not.toThrow();
    expect(() => assertEndpointOverrides(
      { options: { transcriptionEndpoint: "http://169.254.169.254/steal" } },
      "https://api.example.com/v1"
    )).toThrow(/不允许/);
  });
});

describe("密钥归属绑定", () => {
  it("用户现场输入明文密钥时直接放行（地址仍要校验）", () => {
    expect(resolveProfileCredential(
      { baseUrl: "https://new-host.example.com/v1", secretId: "secret-1" },
      "sk-typed-by-user",
      savedProfiles
    )).toEqual({ apiKey: "sk-typed-by-user", useStoredSecret: false });
  });

  it("已存密钥只能发往其归属档案的同一域名", () => {
    expect(resolveProfileCredential(
      { baseUrl: "https://api.example.com/v1", secretId: "secret-1" },
      "",
      savedProfiles
    )).toEqual({ apiKey: "", useStoredSecret: true });
    expect(() => resolveProfileCredential(
      { baseUrl: "https://attacker.test/v1", secretId: "secret-1" },
      "",
      savedProfiles
    )).toThrow(/不一致/);
  });

  it("查不到密钥归属或本地档案无地址时不携带任何密钥", () => {
    expect(() => resolveProfileCredential(
      { baseUrl: "https://api.example.com/v1", secretId: "unknown-secret" },
      "",
      savedProfiles
    )).toThrow(/重新输入/);
    expect(resolveProfileCredential({ transport: "whisper-cpp", secretId: "secret-1" }, "", savedProfiles))
      .toEqual({ apiKey: "", useStoredSecret: false });
  });
});
