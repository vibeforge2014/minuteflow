/**
 * 开发态 Electron.app 权限声明补丁（幂等，postinstall 运行）。
 *
 * Apple Speech helper（mf-apple-speech）以子进程运行，TCC 会把权限请求归属到
 * 责任进程——即开发态的 node_modules/electron/dist/Electron.app。该包的
 * Info.plist 默认没有 NSSpeechRecognitionUsageDescription，speech 权限请求会被
 * TCC 直接中止（SIGABRT privacy violation）。这里给开发壳补上声明；正式打包
 * 的 plist 由 forge.config.mjs 的 extendInfo 提供。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") process.exit(0);

const plist = path.join("node_modules", "electron", "dist", "Electron.app", "Contents", "Info.plist");
if (!existsSync(plist)) {
  console.log("[dev-plist] 未找到开发态 Electron.app，跳过。");
  process.exit(0);
}

const ENTRIES = [
  [
    "NSSpeechRecognitionUsageDescription",
    "MinuteFlow使用macOS内置语音识别在本机将会议音频转成文字，音频不会上传到任何服务器。"
  ],
  ["NSMicrophoneUsageDescription", "MinuteFlow需要访问麦克风，以录制并转录会议内容。"]
];

const plistBuddy = "/usr/libexec/PlistBuddy";
let changed = false;
for (const [key, value] of ENTRIES) {
  try {
    execFileSync(plistBuddy, ["-c", `Print :${key}`, plist], { stdio: "pipe" });
  } catch {
    execFileSync(plistBuddy, ["-c", `Add :${key} string ${value}`, plist], { stdio: "pipe" });
    changed = true;
    console.log(`[dev-plist] 已添加 ${key}`);
  }
}
if (changed) {
  // plist 变更后补一次 ad-hoc 签名，保持开发壳可正常启动。
  try {
    execFileSync("codesign", ["--sign", "-", "--force", "--deep",
      path.join("node_modules", "electron", "dist", "Electron.app")], { stdio: "pipe" });
  } catch {
    // 签名失败不阻断安装：未签名的开发壳依旧可运行，仅 speech 权限弹窗缺失。
  }
}
console.log("[dev-plist] 开发态权限声明就绪。");
