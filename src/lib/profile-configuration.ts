import type { ModelProfile } from "../types";

export type ProfileField = "name" | "baseUrl" | "model" | "apiKey";

/** Validate before either testing or saving; compatible self-hosted services may omit a key. */
export function validateProfileConfiguration(profile: ModelProfile, apiKey: string, requiresKey = false): Partial<Record<ProfileField, string>> {
  const errors: Partial<Record<ProfileField, string>> = {};
  if (!profile.name.trim()) errors.name = "请填写配置名称。";
  try {
    const url = new URL(profile.baseUrl.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || /YOUR[-_]/i.test(url.hostname)) throw new Error();
    if (url.username || url.password) throw new Error();
  } catch {
    errors.baseUrl = "请填写完整的服务地址，例如 https://example.com/v1。";
  }
  if (!profile.model.trim()) errors.model = "请选择或输入模型名称。";
  if (requiresKey && !apiKey.trim() && !profile.secretId) errors.apiKey = "请填写服务商提供的 API Key。";
  return errors;
}

/** No credentials in the fingerprint: callers invalidate separately when the key changes. */
export function profileConfigurationKey(profile: ModelProfile | null): string {
  return JSON.stringify(profile);
}
