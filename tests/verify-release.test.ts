import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertVersionMatchesPackage,
  checkArtifactVersions,
  parseReleaseTag
} from "../scripts/verify-release.mjs";
import pkg from "../package.json";

const temporaryDirectories: string[] = [];
const makeDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "mf-release-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("发布 tag 校验", () => {
  it("只接受 vX.Y.Z", () => {
    expect(parseReleaseTag("v0.1.44")).toBe("0.1.44");
    expect(parseReleaseTag(" v1.20.3 ")).toBe("1.20.3");
    for (const invalid of ["0.1.44", "v0.1", "v0.1.44-beta", "v1.2.3.4", "", undefined]) {
      expect(() => parseReleaseTag(invalid)).toThrow(/vX\.Y\.Z/);
    }
  });

  it("tag 必须与 package.json 版本一致", () => {
    expect(assertVersionMatchesPackage(pkg.version)).toBe(pkg.version);
    expect(() => assertVersionMatchesPackage("0.0.1")).toThrow(/不一致/);
  });
});

describe("发布产物版本校验", () => {
  it("识别出来自其它构建的旧安装包", () => {
    const directory = makeDirectory();
    mkdirSync(path.join(directory, "macos"));
    writeFileSync(path.join(directory, "MinuteFlow-0.1.44-macOS-arm64.dmg"), "");
    writeFileSync(path.join(directory, "macos", "MinuteFlow-0.1.41-macOS-arm64.zip"), "");
    const result = checkArtifactVersions([directory], "0.1.44");
    expect(result.checked).toBe(2);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toContain("0.1.41");
  });

  it("同版本产物通过，无版本号的文件名只提示不阻断", () => {
    const directory = makeDirectory();
    writeFileSync(path.join(directory, "MinuteFlow-0.1.44-macOS-arm64.dmg"), "");
    writeFileSync(path.join(directory, "MinuteFlow-Setup.exe"), "");
    const result = checkArtifactVersions([directory], "0.1.44");
    expect(result.mismatches).toEqual([]);
    expect(result.unversioned).toEqual(["MinuteFlow-Setup.exe"]);
  });

  it("忽略非安装包文件与不存在的目录", () => {
    const directory = makeDirectory();
    writeFileSync(path.join(directory, "SHA256SUMS.txt"), "");
    writeFileSync(path.join(directory, "notes-0.0.1.md"), "");
    const result = checkArtifactVersions([directory, path.join(directory, "missing")], "0.1.44");
    expect(result.checked).toBe(0);
    expect(result.mismatches).toEqual([]);
  });
});
