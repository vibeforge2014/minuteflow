#!/usr/bin/env node
/**
 * 发布前版本一致性校验（publish-desktop-release.yml 调用）。
 *
 * 手填的 release tag 曾与 package.json 版本无关，且产物来自另一次 build_run_id，
 * 容易把旧构建发成新版本。这里校验：
 *   1. tag 必须是 vX.Y.Z；
 *   2. tag 版本与 package.json version 一致；
 *   3. 待发布产物文件名里出现的版本号必须与 tag 一致（无版本号的文件只提示）。
 *
 * 用法：node scripts/verify-release.mjs --tag v0.1.44 --artifacts artifacts/windows artifacts/macos
 */
import { readdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/;
const VERSION_IN_FILENAME = /(\d+\.\d+\.\d+)/g;
const INSTALLER_EXTENSIONS = /\.(?:dmg|zip|exe|msi|appimage|deb|rpm)$/i;

export function parseReleaseTag(tag) {
  const match = TAG_PATTERN.exec(String(tag ?? "").trim());
  if (!match) throw new Error(`发布 tag 格式应为 vX.Y.Z，实际收到：${tag ?? "(空)"}`);
  return match[1];
}

export function assertVersionMatchesPackage(version) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.version !== version) {
    throw new Error(`tag 版本 ${version} 与 package.json 的 ${pkg.version} 不一致；请先更新版本号再发布。`);
  }
  return pkg.version;
}

/** 返回 { checked, mismatches, unversioned }；mismatches 非空即应阻断发布。 */
export function checkArtifactVersions(directories, version) {
  const mismatches = [];
  const unversioned = [];
  let checked = 0;
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !INSTALLER_EXTENSIONS.test(entry.name)) continue;
      checked += 1;
      const versions = [...entry.name.matchAll(VERSION_IN_FILENAME)].map((match) => match[1]);
      if (!versions.length) {
        unversioned.push(entry.name);
      } else if (!versions.includes(version)) {
        mismatches.push(`${entry.name}（含版本 ${versions.join(", ")}）`);
      }
    }
  }
  return { checked, mismatches, unversioned };
}

function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const tag = option("--tag") ?? process.env.RELEASE_TAG;
  const version = parseReleaseTag(tag);
  const packageVersion = assertVersionMatchesPackage(version);
  console.log(`[verify-release] tag ${tag} 与 package.json ${packageVersion} 一致`);

  const artifactIndex = argv.indexOf("--artifacts");
  const directories = artifactIndex === -1
    ? []
    : argv.slice(artifactIndex + 1).filter((item) => !item.startsWith("--"));
  const result = checkArtifactVersions(directories, version);
  if (result.checked) {
    console.log(`[verify-release] 检查 ${result.checked} 个安装包文件名`);
    for (const name of result.unversioned) {
      console.warn(`[verify-release] 提示：${name} 文件名不含版本号，无法确认构建来源`);
    }
    if (result.mismatches.length) {
      throw new Error(`以下产物来自其它版本，可能选错了 build_run_id：\n  ${result.mismatches.join("\n  ")}`);
    }
  } else {
    console.warn("[verify-release] 未找到可校验的安装包文件（产物目录可能为空）");
  }
  return version;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    const version = main(process.argv.slice(2));
    // 把校验过的版本传给后续 workflow 步骤，避免再次手写解析。
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_OUTPUT, `release_version=${version}\n`, "utf8");
    }
    console.log("[verify-release] 校验通过");
  } catch (error) {
    console.error(`[verify-release] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
