#!/usr/bin/env node
/**
 * electron-updater feed 生成脚本（发版时由 sync-release-assets 工作流运行）：
 * 为 macOS 自动更新生成 electron-updater generic provider 消费的 latest-mac.yml。
 * 与官网清单 latest-macos.json 并存：后者仍是版本对比/发布说明/官网下载页的来源，
 * 前者只服务 app 内 electron-updater 的下载与安装（sha512 为 base64，非 hex）。
 * 用法：
 *   node scripts/write-updater-feed.mjs --version 0.2.0 --zip out/MinuteFlow-0.2.0-macOS-arm64.zip \
 *     --url https://zensoft.top/minuteflow/dl/v0.2.0/MinuteFlow-0.2.0-macOS-arm64.zip
 *   （可选 --sha512 <base64> 与 --size <bytes>：zip 校验和已在别处算好（如 CI 附加
 *    SHA256SUMS 前的校验）且本地网络拉不动大文件时直接传入，不读取 --zip 文件本体，
 *    此时路径仅用于推导文件名；可选 --out 指定输出路径，默认 public/releases/latest-mac.yml。）
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

function sha512Base64File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

/**
 * 组装 electron-updater generic provider 的 latest-mac.yml 结构。
 * files[].url 用绝对地址：feed 常驻 dl/auto-update/，zip 在 dl/<tag>/，两者不同目录，
 * 绝对 URL 避免 newUrlFromBase 相对拼接出错（new URL(absolute, base) 会保留 absolute）。
 */
export function buildUpdaterFeed({ version, fileUrl, fileName, sha512, sizeBytes, publishedAt }) {
  const feed = {
    version,
    files: [{ url: fileUrl, sha512, size: sizeBytes }],
    path: fileUrl,
    sha512,
    releaseDate: publishedAt
  };
  const yaml = [
    `version: ${version}`,
    "files:",
    `  - url: ${fileUrl}`,
    `    sha512: ${sha512}`,
    `    size: ${sizeBytes}`,
    `path: ${fileUrl}`,
    `sha512: ${sha512}`,
    `releaseDate: '${publishedAt}'`,
    ""
  ].join("\n");
  return { feed, yaml };
}

async function main() {
  const version = String(args.get("--version") || "").replace(/^v/, "");
  const zipPath = args.get("--zip");
  const fileUrl = String(args.get("--url") || "");
  const publishedAt = args.get("--published-at") || new Date().toISOString();
  const outPath = args.get("--out") || path.join(root, "public", "releases", "latest-mac.yml");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version must be a semantic version such as 0.2.0");
  }
  if (!/^https:\/\//.test(fileUrl)) {
    throw new Error("--url must be the https URL the zip will be served from");
  }
  const fileName = path.basename(new URL(fileUrl).pathname);
  if (!fileName.endsWith(".zip")) {
    throw new Error("--url must point at the macOS zip artifact (.zip)");
  }
  const sha512Override = String(args.get("--sha512") || "");
  const sizeOverride = args.get("--size");
  const sha512 = sha512Override
    ? Buffer.from(sha512Override, "base64").toString("base64")
    : await sha512Base64File(zipPath);
  if (Buffer.from(sha512, "base64").length !== 64) {
    throw new Error("--sha512 must be a base64-encoded 512-bit digest");
  }
  const sizeBytes = sizeOverride != null ? Number(sizeOverride) : statSync(zipPath).size;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error("--size must be a positive byte count (or pass a readable --zip)");
  }
  const { yaml } = buildUpdaterFeed({ version, fileUrl, fileName, sha512, sizeBytes, publishedAt });
  writeFileSync(outPath, yaml, "utf8");
  console.log(`Updated electron-updater feed for ${version} -> ${outPath}`);
}

// 仅作为 CLI 直接运行时执行；被测试导入时只暴露 buildUpdaterFeed。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
