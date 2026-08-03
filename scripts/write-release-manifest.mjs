#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const version = String(args.get("--version") || "").replace(/^v/, "");
const dmgPath = args.get("--dmg");
const publishedAt = args.get("--published-at") || new Date().toISOString();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("--version must be a semantic version such as 0.2.0");
}
if (!dmgPath) throw new Error("--dmg is required");

const absoluteDmgPath = path.resolve(root, dmgPath);
const fileName = path.basename(absoluteDmgPath);
const sha256 = createHash("sha256").update(readFileSync(absoluteDmgPath)).digest("hex");
const tag = `v${version}`;
const assetUrl = `https://github.com/vibeforge2014/minuteflow/releases/download/${tag}/${encodeURIComponent(fileName)}`;
const manifest = {
  schemaVersion: 1,
  version,
  platform: "darwin",
  architectures: ["arm64"],
  publishedAt,
  minimumSystemVersion: "14.2",
  notes: `MinuteFlow ${version} 已发布。包含最新的功能改进、兼容性优化与问题修复。`,
  downloadUrl: "../downloads/macos/latest/",
  releasePageUrl: `https://github.com/vibeforge2014/minuteflow/releases/tag/${tag}`,
  assetUrl,
  sha256
};

writeFileSync(
  path.join(root, "public", "releases", "latest-macos.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
console.log(`Updated macOS website manifest for ${tag}`);
