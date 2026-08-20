/**
 * 桌面应用更新检测（Electron 主进程 / 服务层，macOS 与 Windows）。
 * 从官网更新清单（JSON manifest）与 GitHub Releases 兜底拉取最新版本信息，
 * 校验版本号与下载地址（仅 allow-list 的 HTTPS 宿主），产出统一的更新状态对象。
 * 主要导出：compareVersions、isOfficialHttpsUrl、validateUpdateManifest、
 * normalizeGitHubRelease、checkForAppUpdate、updateManifestUrls。
 * 被 main.mjs 的 updates:get-state / updates:check / updates:open-download 通道调用。
 * 副作用：网络请求。更新从不静默安装，只引导用户跳转官方下载页。
 */
// Public update sources, tried in order, selected per desktop platform. The
// official product site manifest is primary; the GitHub API is a resilient
// fallback that always reflects the latest release. The legacy private
// chatgpt.site host is no longer queried.
// 公开更新源（按序尝试，按平台选择）：官网清单为主，GitHub API 为兜底；旧的私有宿主不再查询。
const MANIFEST_SOURCES = {
  darwin: [
    "https://vibeforge2014.github.io/minuteflow/releases/latest-macos.json",
    "https://api.github.com/repos/vibeforge2014/minuteflow/releases/latest"
  ],
  win32: [
    "https://vibeforge2014.github.io/minuteflow/releases/latest-windows.json",
    "https://api.github.com/repos/vibeforge2014/minuteflow/releases/latest"
  ]
};

/** 更新清单的平台展示名，用于错误信息。 */
const PLATFORM_LABELS = { darwin: "macOS", win32: "Windows" };

/** 各平台未标注最低系统版本时的默认值（Windows 10 22H2 / macOS 14.2）。 */
const DEFAULT_MINIMUM_SYSTEM_VERSION = { darwin: "14.2", win32: "10.0.19045" };

/** 下载/跳转地址的宿主 allow-list：任何更新链接必须落在这些 HTTPS 宿主上。 */
const OFFICIAL_HOSTS = new Set([
  "vibeforge2014.github.io",
  "github.com",
  "api.github.com"
]);

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析 semver 风格版本号（可选 v 前缀与预发布段），不合法返回 null。 */
function parseVersion(version) {
  const match = String(version || "").trim().match(VERSION_PATTERN);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? []
  };
}

/** 按 semver 规则比较预发布段：无预发布 > 有预发布；数字段与字符串段分别比较。 */
function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null;
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个版本号（semver 语义，含预发布段）。
 * @returns {number} 左边更新返回 1，右边更新返回 -1，相等返回 0；格式非法抛错
 */
export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) throw new Error("版本号格式无效。");
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] > right.parts[index] ? 1 : -1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * 判断 URL 是否为 HTTPS 且宿主在 allow-list 内。
 * 安全边界：更新清单、下载地址、版本说明链接都要先过这一关，
 * 防止被篡改的清单把用户引向任意站点。
 */
export function isOfficialHttpsUrl(value, allowedHosts = OFFICIAL_HOSTS) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 校验并归一化官网更新清单（schemaVersion=1）：字段类型逐一检查，
 * downloadUrl/releasePageUrl/assetUrl 必须通过 allow-list HTTPS 校验，
 * 相对地址会基于清单 URL 解析为绝对地址。macOS 与 Windows 清单共用
 * 同一 schema，仅 platform 字段与默认最低系统版本不同。
 * @param {object} input 清单原始 JSON
 * @param {{ manifestUrl?: string, platform?: "darwin" | "win32" }} options
 * @returns {object} 归一化后的清单（版本去掉 v 前缀、notes 截断 4000 字等）
 */
export function validateUpdateManifest(
  input,
  { manifestUrl = MANIFEST_SOURCES.darwin[0], platform = "darwin" } = {}
) {
  if (!input || typeof input !== "object") throw new Error("更新清单格式无效。");
  if (input.schemaVersion !== 1) throw new Error("暂不支持此更新清单版本。");
  if (!parseVersion(input.version)) throw new Error("更新清单中的版本号无效。");
  if (input.platform !== platform) {
    throw new Error(`更新清单不是 ${PLATFORM_LABELS[platform]} 版本。`);
  }
  if (!Array.isArray(input.architectures) || !input.architectures.length) {
    throw new Error("更新清单缺少处理器架构信息。");
  }
  let downloadUrl;
  try {
    downloadUrl = new URL(input.downloadUrl, manifestUrl).href;
  } catch {
    throw new Error("更新下载地址格式无效。");
  }
  if (!isOfficialHttpsUrl(downloadUrl)) {
    throw new Error("更新下载地址不是受信任的官网地址。");
  }
  if (input.releasePageUrl && !isOfficialHttpsUrl(input.releasePageUrl)) {
    throw new Error("版本说明地址不是受信任的官方地址。");
  }
  if (input.assetUrl && !isOfficialHttpsUrl(input.assetUrl)) {
    throw new Error("安装包地址不是受信任的官方地址。");
  }
  return {
    schemaVersion: 1,
    version: String(input.version).replace(/^v/, ""),
    platform,
    architectures: input.architectures.map(String),
    publishedAt: typeof input.publishedAt === "string" ? input.publishedAt : "",
    notes: typeof input.notes === "string" ? input.notes.slice(0, 4000) : "",
    downloadUrl,
    releasePageUrl: input.releasePageUrl || input.downloadUrl,
    assetUrl: input.assetUrl || "",
    sha256: typeof input.sha256 === "string" ? input.sha256.replace(/^sha256:/, "") : "",
    minimumSystemVersion:
      typeof input.minimumSystemVersion === "string"
        ? input.minimumSystemVersion
        : DEFAULT_MINIMUM_SYSTEM_VERSION[platform]
  };
}

/**
 * 把 GitHub Releases API 响应归一化为与官网清单相同的结构：
 * macOS 按当前 CPU 架构挑选 macOS-<arch> 或 universal 的 DMG 资产；
 * Windows 挑选安装器 .exe 资产（squirrel 产物名为 MinuteFlow-Setup.exe，
 * 优先名字带 setup 的资产，忽略 .nupkg / RELEASES 等元数据文件）。
 * 资产与版本页地址同样必须通过 allow-list 校验。
 * @param {object} input GitHub /releases/latest 响应
 * @param {{ platform?: "darwin" | "win32", arch?: string }} options
 */
export function normalizeGitHubRelease(
  input,
  { platform = "darwin", arch = "arm64" } = {}
) {
  if (!input || typeof input !== "object" || !parseVersion(input.tag_name)) {
    throw new Error("官方发布信息格式无效。");
  }
  const assets = Array.isArray(input.assets) ? input.assets : [];
  let asset;
  if (platform === "win32") {
    const executables = assets.filter(
      (item) => typeof item?.name === "string" && item.name.toLowerCase().endsWith(".exe")
    );
    asset = executables.find((item) => /setup/i.test(item.name)) || executables[0];
    if (!asset || !isOfficialHttpsUrl(asset.browser_download_url)) {
      throw new Error("最新版本没有适用于 Windows 的安装程序（.exe）。");
    }
  } else {
    const architecture = arch === "x64" ? "x64" : "arm64";
    asset = assets.find((item) =>
      typeof item?.name === "string"
      && item.name.toLowerCase().endsWith(".dmg")
      && (item.name.includes(`macOS-${architecture}`) || item.name.includes("macOS-universal")));
    if (!asset || !isOfficialHttpsUrl(asset.browser_download_url)) {
      throw new Error(`最新版本没有适用于 ${architecture} 的 macOS DMG。`);
    }
  }
  if (!isOfficialHttpsUrl(input.html_url)) throw new Error("官方版本说明地址无效。");
  return {
    schemaVersion: 1,
    version: String(input.tag_name).replace(/^v/, ""),
    platform,
    architectures: [
      platform === "win32"
        ? "x64"
        : asset.name.includes("universal") ? "universal" : (arch === "x64" ? "x64" : "arm64")
    ],
    publishedAt: typeof input.published_at === "string" ? input.published_at : "",
    notes: typeof input.body === "string" ? input.body.slice(0, 4000) : "",
    downloadUrl: asset.browser_download_url,
    releasePageUrl: input.html_url,
    assetUrl: asset.browser_download_url,
    sha256: typeof asset.digest === "string" ? asset.digest.replace(/^sha256:/, "") : "",
    minimumSystemVersion: DEFAULT_MINIMUM_SYSTEM_VERSION[platform]
  };
}

/**
 * 执行一次桌面端更新检查（main.mjs 的 updates:check 通道调用）。副作用：网络请求。
 * 按平台选择清单源并按序尝试：地址先过 allow-list 校验，api.github.com 响应走
 * GitHub 归一化，其余走官网清单校验；全部失败才抛错。当前版本非 semver
 * （开发构建）时返回"无法比较"而不是报错，避免破坏更新卡片。
 * @returns {Promise<object>} { status: available|up-to-date|unsupported, update, message }
 */
export async function checkForAppUpdate({
  currentVersion,
  platform,
  arch,
  manifestUrl = process.env.MEETING_ASSISTANT_UPDATE_MANIFEST_URL,
  fetchImpl = globalThis.fetch
}) {
  const checkedAt = new Date().toISOString();
  const platformSources = MANIFEST_SOURCES[platform];
  if (!platformSources) {
    return {
      status: "unsupported",
      currentVersion,
      checkedAt,
      message: "当前平台暂不支持在线更新检测。"
    };
  }
  const manifestUrls = manifestUrl ? [manifestUrl] : platformSources;
  let manifest;
  let lastError;
  for (const candidateUrl of manifestUrls) {
    if (!isOfficialHttpsUrl(candidateUrl)) {
      lastError = new Error("更新清单地址不是受信任的官网地址。");
      continue;
    }
    try {
      const response = await fetchImpl(candidateUrl, {
        headers: { Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}。`);
      const payload = await response.json();
      manifest = new URL(candidateUrl).hostname === "api.github.com"
        ? normalizeGitHubRelease(payload, { platform, arch })
        : validateUpdateManifest(payload, { manifestUrl: response.url || candidateUrl, platform });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!manifest) {
    throw new Error(`无法连接更新服务：${lastError instanceof Error ? lastError.message : "网络错误"}`);
  }
  if (!manifest.architectures.includes(arch) && !manifest.architectures.includes("universal")) {
    return {
      status: "unsupported",
      currentVersion,
      checkedAt,
      update: manifest,
      message: `最新版本暂不支持当前 ${arch} 架构。`
    };
  }
  // Dev/unpackaged builds may report a non-semver app version; treat that as
  // "cannot compare" rather than throwing and breaking the update card.
  let available;
  try {
    available = compareVersions(manifest.version, currentVersion) > 0;
  } catch {
    return {
      status: "up-to-date",
      currentVersion,
      checkedAt,
      update: manifest,
      message: "当前为开发版本，无法比较版本号。"
    };
  }
  return {
    status: available ? "available" : "up-to-date",
    currentVersion,
    checkedAt,
    update: manifest,
    message: available ? `发现新版本 ${manifest.version}。` : "当前已是最新版本。"
  };
}

/** 指定平台的全部清单源（官网 + GitHub 兜底）副本，供测试与其他模块引用。 */
export function updateManifestUrls(platform) {
  const sources = MANIFEST_SOURCES[platform];
  return sources ? [...sources] : [];
}
