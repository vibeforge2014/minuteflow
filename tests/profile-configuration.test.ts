import { describe, expect, it } from "vitest";
import { profileConfigurationKey, validateProfileConfiguration } from "../src/lib/profile-configuration";
import type { ModelProfile } from "../src/types";

const profile: ModelProfile = {
  name: "在线服务", kind: "stt", transport: "openai-audio",
  baseUrl: "https://example.com/v1", model: "whisper-1", options: {}, enabled: true
};

describe("profile configuration validation", () => {
  it("accepts complete transcription endpoints and localhost services", () => {
    for (const baseUrl of ["https://example.com/v1/audio/transcriptions", "http://127.0.0.1:11434", " https://example.com/v1 "]) {
      expect(validateProfileConfiguration({ ...profile, baseUrl }, "key", true)).toEqual({});
    }
  });

  it("rejects incomplete URLs, preset placeholders, unsafe schemes and embedded credentials", () => {
    for (const baseUrl of ["", "example.com", "https://YOUR-NEW-API.example/v1", "file:///tmp/model", "javascript:alert(1)", "https://key:secret@example.com"]) {
      expect(validateProfileConfiguration({ ...profile, baseUrl }, "key").baseUrl).toBeTruthy();
    }
  });

  it("reports missing fields together before making a request", () => {
    expect(Object.keys(validateProfileConfiguration({ ...profile, name: " ", model: "", baseUrl: "" }, "", true)).sort())
      .toEqual(["apiKey", "baseUrl", "model", "name"]);
  });

  it("retains a securely saved key and permits unauthenticated compatible services", () => {
    expect(validateProfileConfiguration({ ...profile, secretId: "stored-key" }, "", true)).toEqual({});
    expect(validateProfileConfiguration(profile, "", false)).toEqual({});
    expect(validateProfileConfiguration(profile, " ", true).apiKey).toBeTruthy();
  });

  it("invalidates displayed test results when protocol or capability options change", () => {
    const original = profileConfigurationKey(profile);
    expect(profileConfigurationKey({ ...profile, options: { responseFormat: "text" } })).not.toBe(original);
    expect(profileConfigurationKey({ ...profile, options: { visualSummaryEnabled: true } })).not.toBe(original);
  });
});
