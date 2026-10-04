/**
 * Electron Forge 打包配置（npm run package / make）：
 * - asar unpack：whisper.cpp 原生 .node 绑定与 FFmpeg 可执行文件必须留在 asar 外才能加载/执行。
 * - macOS：优先 Developer ID 签名 + 公证（环境变量注入 APPLE_IDENTITY / APPLE_NOTARY_PROFILE 或
 *   APPLE_API_*）；无身份时退化为 ad-hoc 开发构建（关 hardened runtime，仅供本地调试）。
 * - entitlements.mac.plist：hardened runtime 下加载原生模块与音频采集所必需。
 */
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFileSync } from "node:child_process";

const isMac = process.platform === "darwin";
const appleIdentity = process.env.APPLE_IDENTITY;
const appleNotaryProfile = process.env.APPLE_NOTARY_PROFILE;
const appleApiKey = process.env.APPLE_API_KEY;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuer = process.env.APPLE_API_ISSUER;

// 公证凭据：优先 keychain profile，其次 App Store Connect API 密钥三元组。
const notarizeOptions = appleNotaryProfile
  ? { keychainProfile: appleNotaryProfile }
  : appleApiKey && appleApiKeyId && appleApiIssuer
    ? { appleApiKey, appleApiKeyId, appleApiIssuer }
    : undefined;

// forge 的 osxNotarize 只在 afterSign 公证 .app，产出的 DMG 本身没有公证票；
// 发布校验脚本要求 DMG 装订票（v0.1.24 起两次靠手动 notarytool submit + stapler 补救）。
// 这里在 postMake 对每个 DMG 产物自动提交公证并装订校验，使 `npm run make` 一步出可发布产物。
async function notarizeAndStapleDmg(dmgPath) {
  console.log(`[forge] 公证并装订 DMG: ${dmgPath}`);
  execFileSync("xcrun", [
    "notarytool", "submit", dmgPath,
    "--keychain-profile", appleNotaryProfile,
    "--no-s3-acceleration", "--wait"
  ], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", dmgPath], { stdio: "inherit" });
  console.log(`[forge] DMG 公证装订完成: ${dmgPath}`);
}

export default {
  packagerConfig: {
    // Release jobs can point Forge at a previously verified Electron ZIP so
    // transient GitHub/CDN failures do not make an otherwise offline package
    // step nondeterministic.
    electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
    asar: {
      // Native Whisper bindings and the extensionless FFmpeg executable must
      // live outside app.asar so Electron can load/execute them at runtime.
      unpack: "{**/*.{node,dylib,so,dll,exe},**/node_modules/@ffmpeg-installer/**}"
    },
    ignore: [
      // Native iOS sources and local release/QA outputs are not desktop app
      // resources. Excluding them also prevents an older installer from being
      // recursively embedded when a release is built from a reused checkout.
      /^\/(?:ios|release|artifacts|\.build)(?:\/|$)/
    ],
    appBundleId: "com.meetingassistant.desktop",
    appCategoryType: "public.app-category.productivity",
    executableName: "MinuteFlow",
    icon: "./assets/app-icon",
    extraResource: ["./assets/licenses"],
    osxSign: isMac
      ? {
          identity: appleIdentity || "-",
          identityValidation: Boolean(appleIdentity),
          // Entitlements are required under hardened runtime to load the
          // whisper.cpp/.node native modules (library validation) and capture
          // audio. Without them a properly-signed build crashes at launch.
          entitlements: "./entitlements.mac.plist",
          ...(appleIdentity
            ? {
                hardenedRuntime: true,
                ignore: "\\.pak$"
              }
            : {
                // Ad-hoc (no APPLE_IDENTITY): unsigned dev build. Hardened
                // runtime is off because entitlements are ignored for ad-hoc
                // signatures; use a signed build for distribution.
                hardenedRuntime: false,
                optionsForFile: () => ({
                  hardenedRuntime: false,
                  timestamp: "none"
                })
              })
        }
      : undefined,
    osxNotarize: isMac ? notarizeOptions : undefined,
    extendInfo: {
      CFBundleDisplayName: "MinuteFlow",
      LSMinimumSystemVersion: "14.2",
      NSMicrophoneUsageDescription: "MinuteFlow需要访问麦克风，以录制并转录会议内容。",
      NSAudioCaptureUsageDescription: "MinuteFlow需要访问系统音频，以录制线上会议中的其他参与者。",
      NSScreenCaptureUsageDescription: "MinuteFlow需要屏幕与系统音频权限，以捕获线上会议声音。",
      NSHighResolutionCapable: true
    }
  },
  rebuildConfig: {},
  hooks: {
    postMake: async (_forgeConfig, makeResults) => {
      if (!isMac || !appleNotaryProfile) return makeResults;
      for (const result of makeResults) {
        for (const artifact of result.artifacts || []) {
          if (artifact.endsWith(".dmg")) await notarizeAndStapleDmg(artifact);
        }
      }
      return makeResults;
    }
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "minuteflow",
        setupExe: "MinuteFlow-Setup.exe",
        authors: "MinuteFlow",
        description: "本地优先的跨平台会议记录、转录与纪要工作台。"
      }
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"]
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        name: "MinuteFlow"
      }
    }
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};
