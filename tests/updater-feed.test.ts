/**
 * electron-updater feed（latest-mac.yml）生成逻辑测试：
 * 结构字段、base64 sha512、绝对 URL（feed 与 zip 不同目录）、CLI 参数校验。
 */
import { describe, expect, it } from "vitest";
import { buildUpdaterFeed } from "../scripts/write-updater-feed.mjs";

const SAMPLE_SHA512 = Buffer.alloc(64, 7).toString("base64");

describe("buildUpdaterFeed", () => {
  it("输出 electron-updater generic provider 需要的字段结构", () => {
    const { feed } = buildUpdaterFeed({
      version: "0.2.0",
      fileUrl: "https://zensoft.top/minuteflow/dl/v0.2.0/MinuteFlow-0.2.0-macOS-arm64.zip",
      fileName: "MinuteFlow-0.2.0-macOS-arm64.zip",
      sha512: SAMPLE_SHA512,
      sizeBytes: 1234,
      publishedAt: "2026-10-23T00:00:00.000Z"
    });
    expect(feed.version).toBe("0.2.0");
    expect(feed.files).toHaveLength(1);
    expect(feed.files[0].url).toContain("/dl/v0.2.0/");
    expect(feed.files[0].sha512).toBe(SAMPLE_SHA512);
    expect(feed.files[0].size).toBe(1234);
    expect(feed.path).toBe(feed.files[0].url);
    expect(feed.sha512).toBe(SAMPLE_SHA512);
    expect(feed.releaseDate).toBe("2026-10-23T00:00:00.000Z");
  });

  it("sha512 是 base64 编码的 512 位摘要（electron-updater DigestTransform 默认按 base64 校验）", () => {
    expect(Buffer.from(SAMPLE_SHA512, "base64")).toHaveLength(64);
    const { feed } = buildUpdaterFeed({
      version: "0.2.0",
      fileUrl: "https://example.com/x.zip",
      fileName: "x.zip",
      sha512: SAMPLE_SHA512,
      sizeBytes: 1,
      publishedAt: "2026-10-23T00:00:00.000Z"
    });
    // 64 字节 base64 编码恒为 88 字符、结尾 "=="
    expect(feed.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });

  it("yaml 文本可被逐行解析且 releaseDate 带引号（ISO 日期含冒号）", () => {
    const { yaml } = buildUpdaterFeed({
      version: "0.2.0",
      fileUrl: "https://zensoft.top/minuteflow/dl/v0.2.0/m.zip",
      fileName: "m.zip",
      sha512: SAMPLE_SHA512,
      sizeBytes: 5,
      publishedAt: "2026-10-23T08:09:10.000Z"
    });
    const lines = yaml.split("\n");
    expect(lines[0]).toBe("version: 0.2.0");
    expect(lines[1]).toBe("files:");
    expect(lines[2]).toBe("  - url: https://zensoft.top/minuteflow/dl/v0.2.0/m.zip");
    expect(lines[3]).toBe(`    sha512: ${SAMPLE_SHA512}`);
    expect(lines[4]).toBe("    size: 5");
    expect(lines[5]).toBe("path: https://zensoft.top/minuteflow/dl/v0.2.0/m.zip");
    expect(lines[6]).toBe(`sha512: ${SAMPLE_SHA512}`);
    expect(lines[7]).toBe("releaseDate: '2026-10-23T08:09:10.000Z'");
    expect(lines[8]).toBe("");
  });
});
