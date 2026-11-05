import type { ModelProfile } from "../types";

export interface SettingsDraftSession {
  id: string;
  baseline: ModelProfile | null;
}

/** Transient renderer state only. Never serialize drafts or credentials to disk. */
export interface SettingsProfileDraft extends SettingsDraftSession {
  profile: ModelProfile;
  apiKey: string;
  presetKey: string | null;
}

const editableConfiguration = (profile: ModelProfile | null) => profile && ({
  kind: profile.kind, transport: profile.transport, name: profile.name,
  baseUrl: profile.baseUrl, model: profile.model,
  options: Object.fromEntries(Object.entries(profile.options)
    .filter(([key]) => !["visualSummaryVerifiedAt", "visualSummaryVerifiedFingerprint"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)))
});

export function hasSettingsDraftChanges(profile: ModelProfile | null, baseline: ModelProfile | null, apiKey: string): boolean {
  return Boolean(profile && (apiKey.trim() || JSON.stringify(editableConfiguration(profile)) !== JSON.stringify(editableConfiguration(baseline))));
}

/** Profile ids are stable; unsaved forms get a distinct session id, scoped by task. */
export function settingsDraftKey(profile: ModelProfile, sessionId: string): string {
  return `${profile.kind}:${profile.id ?? sessionId}`;
}
