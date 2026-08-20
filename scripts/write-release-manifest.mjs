#!/usr/bin/env node
/**
 * 桌面更新清单生成脚本（发版时本地运行，产物提交到 public/）：
 * 读取安装包计算 sha256，按 schemaVersion 1 写出官网清单——
 * macOS（--dmg）→ public/releases/latest-macos.json，
 * Windows（--setup）→ public/releases/latest-windows.json。
 * 桌面端启动时校验该清单（electron/services/updates.mjs），downloadUrl 指向官网稳定下载页。
 * 用法：
 *   node scripts/write-release-manifest.mjs --version 0.2.0 --dmg out/MinuteFlow.dmg
 *   node scripts/write-release-manifest.mjs --version 0.2.0 --setup out/MinuteFlow-Setup.exe
 *   （可选 --published-at ISO；--arch 仅 macOS 支持，默认 arm64）
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 解析 --key value 形式的命令行参数。
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const version = String(args.get("--version") || "").replace(/^v/, "");
const dmgPath = args.get("--dmg");
const setupPath = args.get("--setup");
const arch = args.get("--arch") || "arm64";
const publishedAt = args.get("--published-at") || new Date().toISOString();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("--version must be a semantic version such as 0.2.0");
}
if (Boolean(dmgPath) === Boolean(setupPath)) {
  throw new Error("provide exactly one of --dmg (macOS) or --setup (Windows installer)");
}
const platform = dmgPath ? "darwin" : "win32";
const packagePath = path.resolve(root, dmgPath || setupPath);
const fileName = path.basename(packagePath);
const sha256 = createHash("sha256").update(readFileSync(packagePath)).digest("hex");
const tag = `v${version}`;
const assetUrl = `https://github.com/vibeforge2014/minuteflow/releases/download/${tag}/${encodeURIComponent(fileName)}`;
const manifest = {
  schemaVersion: 1,
  version,
  platform,
  // Windows 安装器为 x64 squirrel 产物；macOS 按实际构建架构（arm64 / x64 / universal）填写。
  architectures: platform === "win32" ? ["x64"] : [arch],
  publishedAt,
  minimumSystemVersion: platform === "win32" ? "10.0.19045" : "14.2",
  notes: `MinuteFlow ${version} 已发布。包含最新的功能改进、兼容性优化与问题修复。`,
  downloadUrl: `../downloads/${platform === "win32" ? "windows" : "macos"}/latest/`,
  releasePageUrl: `https://github.com/vibeforge2014/minuteflow/releases/tag/${tag}`,
  assetUrl,
  sha256
};

const manifestFileName = platform === "win32" ? "latest-windows.json" : "latest-macos.json";
writeFileSync(
  path.join(root, "public", "releases", manifestFileName),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
console.log(`Updated ${platform === "win32" ? "Windows" : "macOS"} website manifest for ${tag}`);
