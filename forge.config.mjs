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

// 官网专属产物：桌面入口 desktop.html 不引用它们，可安全从安装包剔除。
// 下面 prePackage 的构建自检会确保这些规则不会误伤桌面入口的依赖。
const siteOnlyAssets = [
  /^\/dist\/client\/(?:index\.html|404\.html|og\.png)$/,
  /^\/dist\/client\/assets\/main-[^/]+\.(?:js|css|map)$/
];

// 正式发布模式：CI 把仓库变量 MINUTEFLOW_RELEASE_BUILD 设为 1 后，缺少签名
// 身份或公证凭据必须直接失败，不能产出"绿色"但实际不可分发的 DMG。
// 本地 ad-hoc 打包（默认）保持原有行为。
const requireSignedRelease = process.env.MINUTEFLOW_RELEASE_BUILD === "1";

const isMac = process.platform === "darwin";
// 签名身份：默认不强制。CI 导入 Developer ID 证书后通过 APPLE_IDENTITY 传入证书 CN；
// 本地验证时同样用该变量指向本机钥匙串里的证书。未设置则退化为 ad-hoc 开发构建。
const appleIdentity = process.env.APPLE_IDENTITY;
const appleNotaryProfile = process.env.APPLE_NOTARY_PROFILE;
// issuer / key id 属于非机密标识符；缺省指向本项目的 App Store Connect API 密钥，
// 仅需再提供 .p8 文件路径（APPLE_NOTARY_KEY_PATH）即可公证。
const appleApiKeyId = process.env.APPLE_API_KEY_ID || "496SRK4K68";
const appleApiIssuer = process.env.APPLE_API_ISSUER || "a307ff7b-774c-4ef6-98c4-8031876fa556";
// 直连 App Store Connect API 的 .p8 路径（keychain profile 缺失时的公证凭据来源）。
// 这是指向密钥文件的路径，而非密钥内容；不设置默认值，避免把机器专属路径写进仓库。
const appleNotaryKeyPath = process.env.APPLE_NOTARY_KEY_PATH;

// DMG 公证参数：优先 keychain profile，其次 .p8 直连三元组（与 notarytool CLI 对应）。
function notarytoolCredentialArgs() {
  if (appleNotaryProfile) return ["--keychain-profile", appleNotaryProfile];
  if (appleNotaryKeyPath && appleApiKeyId && appleApiIssuer) {
    return ["--key", appleNotaryKeyPath, "--key-id", appleApiKeyId, "--issuer", appleApiIssuer];
  }
  return undefined;
}

// 仅当明确进入发布/公证流程时才启用公证：MINUTEFLOW_RELEASE_BUILD=1（CI 正式发布）
// 或本地显式 MINUTEFLOW_NOTARIZE=1。这样本地常规 `npm run make` 只做 Developer ID
// 签名、不上传公证，既快又能验证签名链路；公证只在发布或显式开关时触发。
const shouldNotarize = requireSignedRelease || process.env.MINUTEFLOW_NOTARIZE === "1";

// 公证凭据：优先 keychain profile，其次 App Store Connect API 密钥三元组。
// @electron/notarize 的 notarytool 适配层把 appleApiKey 原样传给 CLI 的 --key，
// 该参数接收 .p8 的「文件路径」（不是内容，也不是 key id）。
const notarizeOptions = shouldNotarize
  ? (appleNotaryProfile
    ? { keychainProfile: appleNotaryProfile }
    : appleNotaryKeyPath && appleApiKeyId && appleApiIssuer
      ? { appleApiKey: appleNotaryKeyPath, appleApiKeyId, appleApiIssuer }
      : undefined)
  : undefined;

if (requireSignedRelease && isMac) {
  const missing = [];
  if (!appleIdentity) missing.push("APPLE_IDENTITY");
  if (!notarizeOptions) missing.push("APPLE_NOTARY_PROFILE 或 APPLE_NOTARY_KEY_PATH/APPLE_API_KEY_ID/APPLE_API_ISSUER");
  if (missing.length) {
    throw new Error(
      `MINUTEFLOW_RELEASE_BUILD=1 要求可分发构建，但缺少：${missing.join("、")}。` +
      "请在 CI 导入签名证书并配置 notarytool 凭据，或关闭严格模式以生成本地调试构建。"
    );
  }
}

// forge 的 osxNotarize 只在 afterSign 公证 .app，产出的 DMG 本身没有公证票；
// 发布校验脚本要求 DMG 装订票（v0.1.24 起两次靠手动 notarytool submit + stapler 补救）。
// 这里在 postMake 对每个 DMG 产物自动提交公证并装订校验，使 `npm run make` 一步出可发布产物。
async function notarizeAndStapleDmg(dmgPath) {
  const credentialArgs = notarytoolCredentialArgs();
  if (!credentialArgs) {
    if (requireSignedRelease) throw new Error("正式发布构建缺少 DMG 公证凭据。");
    console.warn("[forge] 缺少公证凭据，跳过 DMG 公证（产出的 DMG 不可发布！）");
    return;
  }
  console.log(`[forge] 公证并装订 DMG: ${dmgPath}`);
  execFileSync("xcrun", [
    "notarytool", "submit", dmgPath,
    ...credentialArgs,
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
      /^\/(?:ios|release|artifacts|\.build)(?:\/|$)/,
      // 桌面工作台只加载 dist/client/desktop.html；官网入口及其专属 chunk
      // （MarketingSite / marketing.css）不再随安装包分发。
      ...siteOnlyAssets
    ],
    appBundleId: "com.meetingassistant.desktop",
    appCategoryType: "public.app-category.productivity",
    executableName: "MinuteFlow",
    icon: "./assets/app-icon",
    // Apple Speech helper（构建产物，scripts/build-apple-speech.sh）与真实识别测试样例
    // 随包分发到 Contents/Resources/{bin,fixtures}；打包前由 prePackage 钩子确保已构建。
    // 两者都是 macOS 专属：Windows CI 上 resources/bin 不存在（gitignored），不能列入。
    extraResource: isMac
      ? ["./assets/licenses", "./resources/bin", "./resources/fixtures"]
      : ["./assets/licenses"],
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
      NSSpeechRecognitionUsageDescription: "MinuteFlow使用macOS内置语音识别在本机将会议音频转成文字，音频不会上传到任何服务器。",
      NSAudioCaptureUsageDescription: "MinuteFlow需要访问系统音频，以录制线上会议中的其他参与者。",
      NSScreenCaptureUsageDescription: "MinuteFlow需要屏幕与系统音频权限，以捕获线上会议声音。",
      NSHighResolutionCapable: true
    }
  },
  rebuildConfig: {},
  hooks: {
    // macOS 自动更新 feed 指向（electron-updater，运行时读 Contents/Resources/app-update.yml）。
    // packageAfterPrune 的 buildPath 是 <App>.app/Contents/Resources/app，
    // 包根在三级之上；必须赶在 osx-sign 之前写入，否则破坏应用签名。
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      if (!isMac) return;
      const { writeFileSync } = await import("node:fs");
      const { join, resolve } = await import("node:path");
      const resourcesDir = resolve(buildPath, "..", "..", "..", "Contents", "Resources");
      writeFileSync(
        join(resourcesDir, "app-update.yml"),
        [
          "provider: generic",
          "url: https://zensoft.top/minuteflow/dl/auto-update/",
          "channel: latest",
          "updaterCacheDirName: minuteflow-updater",
          ""
        ].join("\n"),
        "utf8"
      );
    },
    // Apple Speech helper 是构建产物（不入库）：打包前确保存在，缺失则现场构建。
    prePackage: async () => {
      // 多入口构建自检：desktop.html 引用的每个资源都必须存在，且不能被
      // siteOnlyAssets 规则误排除——否则打包会成功但用户打开是白屏。
      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const clientDir = resolve("dist", "client");
      const desktopHtml = resolve(clientDir, "desktop.html");
      if (!existsSync(desktopHtml)) {
        throw new Error("缺少 dist/client/desktop.html，请先运行 npm run build:renderer。");
      }
      const html = readFileSync(desktopHtml, "utf8");
      const references = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
      if (!references.some((ref) => /\.js$/.test(ref))) {
        throw new Error("desktop.html 未引用任何脚本，构建产物不完整。");
      }
      for (const ref of references) {
        if (siteOnlyAssets.some((pattern) => pattern.test(`/dist/client/${ref}`))) {
          throw new Error(`桌面入口依赖被误判为官网专属资源：${ref}`);
        }
        if (!existsSync(resolve(clientDir, ref))) {
          throw new Error(`桌面入口引用的资源缺失：${ref}`);
        }
      }
      if (!isMac) return;
      const helper = "./resources/bin/mf-apple-speech-darwin-universal";
      if (!existsSync(helper)) {
        console.log("[forge] 构建 Apple Speech helper…");
        execFileSync("bash", ["scripts/build-apple-speech.sh"], { stdio: "inherit" });
      }
    },
    postMake: async (_forgeConfig, makeResults) => {
      if (!isMac) return makeResults;
      // 仅当显式进入公证流程（正式发布或本地 MINUTEFLOW_NOTARIZE=1）才对每个
      // DMG 提交公证并装订；常规本地构建直接返回，不联网、不等待。
      if (!shouldNotarize) return makeResults;
      const credentialArgs = notarytoolCredentialArgs();
      if (!credentialArgs) {
        throw new Error("正式发布构建缺少 DMG 公证凭据（APPLE_NOTARY_PROFILE 或 APPLE_NOTARY_KEY_PATH/APPLE_API_KEY_ID/APPLE_API_ISSUER）。");
      }
      let notarized = 0;
      for (const result of makeResults) {
        for (const artifact of result.artifacts || []) {
          if (artifact.endsWith(".dmg")) {
            await notarizeAndStapleDmg(artifact);
            notarized += 1;
          }
        }
      }
      if (requireSignedRelease && notarized === 0) {
        throw new Error("正式发布构建未产出任何 DMG，无法完成公证装订。");
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
