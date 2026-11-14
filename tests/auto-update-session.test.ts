import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const fake = vi.hoisted(() => ({ updater: null as any }));
vi.mock("electron", () => ({ app: { isPackaged: true, getVersion: () => "0.1.44" } }));
vi.mock("electron-updater", () => ({
  get autoUpdater() { return fake.updater; },
  CancellationToken: class { cancel = vi.fn(); }
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let service: typeof import("../electron/services/auto-update.mjs");
let updater: any;
const tick = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "darwin" });
  updater = Object.assign(new EventEmitter(), {
    nativeUpdater: new EventEmitter(),
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version: "0.2.0" } })),
    downloadUpdate: vi.fn(() => new Promise(() => {})),
    closeServerIfExists: vi.fn()
  });
  fake.updater = updater;
  service = await import("../electron/services/auto-update.mjs");
});
afterEach(() => {
  service.disposeMacUpdater();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
});

describe("macOS download session orchestration", () => {
  it("cancel settles even if SDK ignores cancellation; snapshot clears and next download starts", async () => {
    const first = service.downloadMacUpdate({ version: "0.2.0" });
    await tick();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    await service.cancelMacDownload();
    expect(service.macDownloadSnapshot()).toBeNull();
    await expect(first).resolves.toMatchObject({ cancelled: true });
    const second = service.downloadMacUpdate({ version: "0.2.0" });
    await tick();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    await service.cancelMacDownload();
    await expect(second).resolves.toMatchObject({ cancelled: true });
  });

  it("cancel during native preparation ignores late ready events and allows DMG fallback", async () => {
    const ready = vi.fn();
    const first = service.downloadMacUpdate({ version: "0.2.0", onReady: ready });
    await tick();
    updater.emit("update-downloaded", { version: "0.2.0" });
    await service.cancelMacDownload();
    await expect(first).resolves.toMatchObject({ cancelled: true });
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.nativeUpdater.emit("update-downloaded");
    expect(ready).not.toHaveBeenCalled();
    expect(service.macDownloadedUpdateVersion()).toBe("");
    expect(service.macDownloadSnapshot()).toBeNull();
    await expect(service.downloadMacUpdate()).rejects.toThrow(service.MAC_AUTO_UPDATE_FALLBACK);
  });

  it("native preparation timeout ends a non-cancellable SDK wait", async () => {
    vi.useFakeTimers();
    const first = service.downloadMacUpdate({ version: "0.2.0" });
    const rejected = expect(first).rejects.toThrow("安装准备超时");
    await tick();
    updater.emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(190_000);
    await rejected;
    expect(service.macDownloadSnapshot()).toBeNull();
  });

  it("joins concurrent calls and reports ready only after native validation", async () => {
    updater.downloadUpdate.mockResolvedValue([]);
    const ready = vi.fn();
    const first = service.downloadMacUpdate({ version: "0.2.0", onReady: ready });
    const second = service.downloadMacUpdate({ version: "0.2.0" });
    await tick();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(ready).not.toHaveBeenCalled();
    updater.nativeUpdater.emit("update-downloaded");
    await Promise.all([first, second]);
    expect(ready).toHaveBeenCalledExactlyOnceWith("0.2.0");
    expect(service.macDownloadedUpdateVersion()).toBe("0.2.0");
  });
});
