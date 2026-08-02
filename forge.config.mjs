import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

export default {
  packagerConfig: {
    asar: {
      unpack: "**/*.{node,dylib,so,dll}"
    },
    appBundleId: "com.meetingassistant.desktop",
    appCategoryType: "public.app-category.productivity",
    executableName: "meeting-assistant",
    icon: "./assets/app-icon",
    extraResource: ["./assets/licenses"],
    osxSign: process.platform === "darwin"
      ? {
          identity: process.env.APPLE_IDENTITY || "-",
          identityValidation: Boolean(process.env.APPLE_IDENTITY),
          ...(process.env.APPLE_IDENTITY
            ? {}
            : {
                optionsForFile: () => ({
                  hardenedRuntime: false,
                  timestamp: "none"
                })
              })
        }
      : undefined,
    extendInfo: {
      CFBundleDisplayName: "会议助手",
      NSMicrophoneUsageDescription: "会议助手需要访问麦克风，以录制并转录会议内容。",
      NSAudioCaptureUsageDescription: "会议助手需要访问系统音频，以录制线上会议中的其他参与者。",
      NSScreenCaptureUsageDescription: "会议助手需要屏幕与系统音频权限，以捕获线上会议声音。"
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "meeting_assistant",
        setupExe: "会议助手-Setup.exe",
        authors: "会议助手",
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
        name: "会议助手"
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
