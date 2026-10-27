#!/usr/bin/env bash
# 构建 Apple Speech 转录 helper（macOS universal 二进制）。
# 产物: resources/bin/mf-apple-speech-darwin-universal
# 用法: scripts/build-apple-speech.sh   （需要 Xcode Command Line Tools 的 swiftc）
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="resources/apple-speech/mf-apple-speech.swift"
INFO_PLIST="resources/apple-speech/helper-info.plist"
OUT_DIR="resources/bin"
OUT="$OUT_DIR/mf-apple-speech-darwin-universal"
MIN_MACOS="13.0"

command -v xcrun >/dev/null 2>&1 || { echo "需要 xcrun（安装 Xcode Command Line Tools）" >&2; exit 1; }

mkdir -p "$OUT_DIR"
ARM="$OUT_DIR/.mf-apple-speech-arm64"
X86="$OUT_DIR/.mf-apple-speech-x86_64"

# 内嵌 Info.plist（__TEXT __info_plist）：TCC 会对照发起语音识别的进程自己的
# usage description；helper 作为裸二进制被主应用拉起时，多数情况归属父应用，
# 但在重签/硬化运行时等场景下会被按自身判定——内嵌后两种归属都能过。
xcrun swiftc -O -target "arm64-apple-macos$MIN_MACOS" -o "$ARM" "$SRC" -framework Speech \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$INFO_PLIST"
xcrun swiftc -O -target "x86_64-apple-macos$MIN_MACOS" -o "$X86" "$SRC" -framework Speech \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$INFO_PLIST"
lipo -create -output "$OUT" "$ARM" "$X86"
rm -f "$ARM" "$X86"
codesign --sign - --force "$OUT" 2>/dev/null || true
echo "built $OUT"
lipo -info "$OUT"
