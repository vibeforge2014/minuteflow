import { describe, expect, it } from "vitest";
import { hasSettingsDraftChanges, settingsDraftKey } from "../src/lib/settings-drafts";
import type { ModelProfile } from "../src/types";

const saved: ModelProfile = {
  id: "summary-1", name: "总结服务", kind: "llm", transport: "openai-chat",
  baseUrl: "https://example.com/v1", model: "meeting-model", options: { apiFlavor: "openai", timeoutMs: 60_000 }, enabled: true
};

describe("settings draft identity and dirty state", () => {
  it("keeps multiple new forms and different tasks independent", () => {
    const { id, ...draft } = saved;
    expect(settingsDraftKey(draft, "first")).not.toBe(settingsDraftKey(draft, "second"));
    expect(settingsDraftKey(draft, "first")).not.toBe(settingsDraftKey({ ...draft, kind: "stt" }, "first"));
    expect(settingsDraftKey(saved, "first")).toBe(settingsDraftKey(saved, "second"));
  });
  it("does not create pending edits for verification or default-status changes", () => {
    const metadata = { ...saved, isDefault: true, enabled: false, secretId: "stored-secret", options: { ...saved.options, visualSummaryVerifiedAt: "now", visualSummaryVerifiedFingerprint: "valid" } };
    expect(hasSettingsDraftChanges(metadata, saved, "")).toBe(false);
  });
  it("recognizes credentials, model changes and capability edits", () => {
    expect(hasSettingsDraftChanges(saved, saved, "new-secret")).toBe(true);
    expect(hasSettingsDraftChanges({ ...saved, model: "another-model" }, saved, "")).toBe(true);
    expect(hasSettingsDraftChanges({ ...saved, options: { ...saved.options, visualSummaryEnabled: true } }, saved, "")).toBe(true);
  });
  it("does not confuse option order or whitespace-only key input with edits", () => {
    const reordered = { ...saved, options: { timeoutMs: 60_000, apiFlavor: "openai" as const } };
    expect(hasSettingsDraftChanges(reordered, saved, "  ")).toBe(false);
    expect(hasSettingsDraftChanges(null, saved, "secret")).toBe(false);
  });
  it("detects a restoration to the baseline without marking it pending", () => {
    const modified = { ...saved, name: "改名", baseUrl: "https://other.example/v1" };
    expect(hasSettingsDraftChanges(modified, saved, "")).toBe(true);
    expect(hasSettingsDraftChanges({ ...saved }, saved, "")).toBe(false);
  });
});
