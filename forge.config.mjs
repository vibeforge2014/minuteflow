import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const isMac = process.platform === "darwin";
const appleIdentity = process.env.APPLE_IDENTITY;
const appleNotaryProfile = process.env.APPLE_NOTARY_PROFILE;
const appleApiKey = process.env.APPLE_API_KEY;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuer = process.env.APPLE_API_ISSUER;

const notarizeOptions = appleNotaryProfile
  ? { keychainProfile: appleNotaryProfile }
  : appleApiKey && appleApiKeyId && appleApiIssuer
    ? { appleApiKey, appleApiKeyId, appleApiIssuer }
    : undefined;

export default {
  packagerConfig: {
    asar: {
      unpack: "**/*.{node,dylib,so,dll}"
    },
    ignore: [
      /^\/ios(?:\/|$)/
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
          ...(appleIdentity
            ? {
                hardenedRuntime: true,
                ignore: "\\.pak$"
              }
            : {
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
      NSMicrophoneUsageDescription: "MinuteFlow需要访问麦克风，以录制并转录会议内容。",
      NSAudioCaptureUsageDescription: "MinuteFlow需要访问系统音频，以录制线上会议中的其他参与者。",
      NSScreenCaptureUsageDescription: "MinuteFlow需要屏幕与系统音频权限，以捕获线上会议声音。"
    }
  },
  rebuildConfig: {},
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
