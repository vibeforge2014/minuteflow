const DEFAULT_MANIFEST_URLS = [
  "https://vibeforge2014.github.io/meeting-assistant/releases/latest-macos.json",
  "https://huiyi-zhushou.xiaohe998.chatgpt.site/releases/latest-macos.json"
];

const OFFICIAL_HOSTS = new Set([
  "vibeforge2014.github.io",
  "github.com"
]);

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(version) {
  const match = String(version || "").trim().match(VERSION_PATTERN);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? []
  };
}

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

export function isOfficialHttpsUrl(value, allowedHosts = OFFICIAL_HOSTS) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

export function validateMacUpdateManifest(input, manifestUrl = DEFAULT_MANIFEST_URLS[0]) {
  if (!input || typeof input !== "object") throw new Error("更新清单格式无效。");
  if (input.schemaVersion !== 1) throw new Error("暂不支持此更新清单版本。");
  if (!parseVersion(input.version)) throw new Error("更新清单中的版本号无效。");
  if (input.platform !== "darwin") throw new Error("更新清单不是 macOS 版本。");
  if (!Array.isArray(input.architectures) || !input.architectures.length) {
    throw new Error("更新清单缺少处理器架构信息。");
  }
  let downloadUrl;
  try {
    downloadUrl = new URL(input.downloadUrl, manifestUrl).href;
  } catch {
    throw new Error("更新下载地址格式无效。");
  }
  if (!isOfficialHttpsUrl(downloadUrl, new Set([...OFFICIAL_HOSTS, "huiyi-zhushou.xiaohe998.chatgpt.site"]))) {
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
    platform: "darwin",
    architectures: input.architectures.map(String),
    publishedAt: typeof input.publishedAt === "string" ? input.publishedAt : "",
    notes: typeof input.notes === "string" ? input.notes.slice(0, 4000) : "",
    downloadUrl,
    releasePageUrl: input.releasePageUrl || input.downloadUrl,
    assetUrl: input.assetUrl || "",
    sha256: typeof input.sha256 === "string" ? input.sha256.replace(/^sha256:/, "") : "",
    minimumSystemVersion:
      typeof input.minimumSystemVersion === "string" ? input.minimumSystemVersion : "14.2"
  };
}

export async function checkForMacUpdate({
  currentVersion,
  platform,
  arch,
  manifestUrl = process.env.MEETING_ASSISTANT_UPDATE_MANIFEST_URL,
  fetchImpl = globalThis.fetch
}) {
  const checkedAt = new Date().toISOString();
  if (platform !== "darwin") {
    return {
      status: "unsupported",
      currentVersion,
      checkedAt,
      message: "当前仅为 macOS 提供官网更新检测。"
    };
  }
  const manifestUrls = manifestUrl ? [manifestUrl] : DEFAULT_MANIFEST_URLS;
  let manifest;
  let lastError;
  for (const candidateUrl of manifestUrls) {
    if (!isOfficialHttpsUrl(candidateUrl, new Set([...OFFICIAL_HOSTS, "huiyi-zhushou.xiaohe998.chatgpt.site"]))) {
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
      manifest = validateMacUpdateManifest(await response.json(), response.url || candidateUrl);
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
  const available = compareVersions(manifest.version, currentVersion) > 0;
  return {
    status: available ? "available" : "up-to-date",
    currentVersion,
    checkedAt,
    update: manifest,
    message: available ? `发现新版本 ${manifest.version}。` : "当前已是最新版本。"
  };
}

export const macUpdateManifestUrl = DEFAULT_MANIFEST_URLS[0];
export const macUpdateManifestUrls = [...DEFAULT_MANIFEST_URLS];
