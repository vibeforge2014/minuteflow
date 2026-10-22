#!/usr/bin/env bash
# 构建 Apple Speech 转录 helper（macOS universal 二进制）。
# 产物: resources/bin/mf-apple-speech-darwin-universal
# 用法: scripts/build-apple-speech.sh   （需要 Xcode Command Line Tools 的 swiftc）
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="resources/apple-speech/mf-apple-speech.swift"
OUT_DIR="resources/bin"
OUT="$OUT_DIR/mf-apple-speech-darwin-universal"
MIN_MACOS="13.0"

command -v xcrun >/dev/null 2>&1 || { echo "需要 xcrun（安装 Xcode Command Line Tools）" >&2; exit 1; }

mkdir -p "$OUT_DIR"
ARM="$OUT_DIR/.mf-apple-speech-arm64"
X86="$OUT_DIR/.mf-apple-speech-x86_64"

xcrun swiftc -O -target "arm64-apple-macos$MIN_MACOS" -o "$ARM" "$SRC" -framework Speech
xcrun swiftc -O -target "x86_64-apple-macos$MIN_MACOS" -o "$X86" "$SRC" -framework Speech
lipo -create -output "$OUT" "$ARM" "$X86"
rm -f "$ARM" "$X86"
codesign --sign - --force "$OUT" 2>/dev/null || true
echo "built $OUT"
lipo -info "$OUT"
