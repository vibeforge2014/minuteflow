import { describe, expect, it } from "vitest";
import {
  signLicenseState,
  splitSignedState,
  stableStringify,
  verifyLicenseStateSignature
} from "../electron/services/license-state-integrity.mjs";

const key = "test-signing-key-0123456789";
const state = {
  status: "licensed",
  lastVerifiedAt: "2026-11-12T05:00:00.000Z",
  deviceId: "device-1",
  machineFingerprint: "fingerprint-1"
};

describe("授权状态完整性", () => {
  it("键顺序不同也得到同一签名", () => {
    expect(stableStringify({ a: 1, b: { d: 4, c: 3 } }))
      .toBe(stableStringify({ b: { c: 3, d: 4 }, a: 1 }));
    expect(signLicenseState(state, key))
      .toBe(signLicenseState({ machineFingerprint: state.machineFingerprint, deviceId: state.deviceId, lastVerifiedAt: state.lastVerifiedAt, status: state.status }, key));
  });

  it("合法状态可验证，篡改任意字段即失败", () => {
    const signature = signLicenseState(state, key);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyLicenseStateSignature(state, signature, key)).toBe(true);
    expect(verifyLicenseStateSignature({ ...state, lastVerifiedAt: new Date().toISOString() }, signature, key)).toBe(false);
    expect(verifyLicenseStateSignature({ ...state, status: "licensed", extra: true }, signature, key)).toBe(false);
    expect(verifyLicenseStateSignature({ status: "licensed", lastVerifiedAt: state.lastVerifiedAt }, signature, key)).toBe(false);
  });

  it("缺签名、伪造签名、换密钥都失败", () => {
    const signature = signLicenseState(state, key);
    expect(verifyLicenseStateSignature(state, "", key)).toBe(false);
    expect(verifyLicenseStateSignature(state, "deadbeef", key)).toBe(false);
    expect(verifyLicenseStateSignature(state, signature, "another-key")).toBe(false);
    expect(verifyLicenseStateSignature(state, signature, "")).toBe(false);
    expect(signLicenseState(state, "")).toBe("");
  });

  it("拆分带签名的文件时不会把 signature 算进被签名内容", () => {
    const signature = signLicenseState(state, key);
    const stored = JSON.parse(JSON.stringify({ ...state, signature }));
    const { payload, signature: parsed } = splitSignedState(stored);
    expect(payload).toEqual(state);
    expect(parsed).toBe(signature);
    expect(verifyLicenseStateSignature(payload, parsed, key)).toBe(true);
    expect(splitSignedState(null).signature).toBe("");
  });
});
