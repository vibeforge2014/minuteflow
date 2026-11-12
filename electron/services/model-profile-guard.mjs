/**
 * 模型档案的网络输入校验。
 *
 * 背景：models:test / models:list-models 直接接收渲染层构造的 profile。此前主进程用
 * `apiKey || readSecret(profile.secretId)` 解出真实密钥后请求 profile.baseUrl，而
 * apiUrl 的 override 还允许完整 URL —— 渲染层一旦被注入即可把全部已存 API Key
 * 发到任意主机，或让主进程探测云元数据端点。这里把所有「带密钥出网」的入口收口。
 */
const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
  "100.100.100.200",
  "169.254.170.2"
]);

/** 允许本地/内网自建模型服务，但拒绝云元数据与链路本地地址。 */
function isBlockedHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return BLOCKED_HOSTNAMES.has(host)
    || host.startsWith("169.254.")
    || host.startsWith("fd00:ec2:");
}

export function assertSafeHttpUrl(raw, label = "服务地址") {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label}不能为空。`);
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${label}格式无效，请填写完整的 http(s) 地址。`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}只支持 http(s) 协议。`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`${label}指向了不允许的内部地址。`);
  }
  return url;
}

/** 自定义端点覆盖里若写了完整 URL，必须仍落在同一个域名上。 */
const ENDPOINT_OPTION_KEYS = [
  "chatEndpoint", "transcriptionEndpoint", "modelsEndpoint",
  "responsesEndpoint", "endpoint", "apiUrl"
];

export function assertEndpointOverrides(profile, baseUrl) {
  const base = assertSafeHttpUrl(baseUrl, "模型服务地址");
  for (const key of ENDPOINT_OPTION_KEYS) {
    const value = profile?.options?.[key];
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;
    const url = assertSafeHttpUrl(value, `自定义端点 ${key}`);
    if (url.hostname !== base.hostname) {
      throw new Error(`自定义端点 ${key} 与模型服务地址不属于同一域名，请检查配置。`);
    }
  }
}

/**
 * 决定本次网络调用可以携带哪个密钥。
 * - 用户现场输入的明文 apiKey：照常使用（地址仍需通过校验）。
 * - 走已存 secretId 时：只有该密钥归属档案的服务域名与本次地址一致才放行，
 *   否则要求重新输入密钥，杜绝「拿 A 服务的密钥发给 B 地址」。
 * @returns {{apiKey: string, useStoredSecret: boolean}}
 */
export function resolveProfileCredential(profile, apiKey, savedProfiles = []) {
  const baseUrl = typeof profile?.baseUrl === "string" ? profile.baseUrl.trim() : "";
  if (baseUrl) {
    assertSafeHttpUrl(baseUrl, "模型服务地址");
    assertEndpointOverrides(profile, baseUrl);
  }
  if (typeof apiKey === "string" && apiKey.trim()) {
    return { apiKey: apiKey.trim(), useStoredSecret: false };
  }
  const secretId = typeof profile?.secretId === "string" ? profile.secretId : "";
  if (!secretId || !baseUrl) return { apiKey: "", useStoredSecret: false };
  const owner = savedProfiles.find((item) => item?.secretId === secretId && item?.baseUrl);
  if (!owner) {
    throw new Error("该配置引用的密钥没有对应的服务地址，请重新输入 API Key 后再试。");
  }
  let ownerHost;
  try {
    ownerHost = new URL(owner.baseUrl).hostname;
  } catch {
    throw new Error("已保存的模型服务地址无效，请重新保存配置。");
  }
  if (ownerHost !== new URL(baseUrl).hostname) {
    throw new Error("服务地址与保存密钥时不一致，为防止密钥泄露，请重新输入 API Key 后再试。");
  }
  return { apiKey: "", useStoredSecret: true };
}
