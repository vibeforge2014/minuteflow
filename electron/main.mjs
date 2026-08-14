import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences
} from "electron";
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  appendAudioChunk,
  createMeeting,
  deleteAudioPathRecord,
  finalizeAudioPath,
  listExpiredAudioPaths,
  listMeetings,
  listMeetingAudioAssets,
  listMeetingAudioPaths,
  listModelProfiles,
  loadMeeting,
  loadAudioAsset,
  markRunningJobsInterrupted,
  markInterruptedRecordings,
  restoreMeeting,
  saveMeeting,
  saveModelProfile,
  softDeleteMeeting
} from "./database.mjs";
import { deleteSecret, flushSecrets, readSecret, storeSecret, warmSecretCache } from "./services/secrets.mjs";
import {
  summarizeLocally,
  summarizeWithOpenAICompatible,
  testModelProfile,
  transcribeRemote,
  transcribeWithWhisperCpp,
  transcribeWithPythonWhisper,
  transcribeWithFasterWhisper,
  transcribeWithMlxWhisper
} from "./services/providers.mjs";
import { chooseImportFiles, exportMeeting } from "./services/exports.mjs";
import {
  describeLocalModel,
  discoverLocalModels,
  downloadModel,
  listDownloadableModels,
  resolveLocalModelProfile
} from "./services/local-models.mjs";
import {
  checkForMacUpdate,
  isOfficialHttpsUrl
} from "./services/updates.mjs";
import {
  activateLicense,
  checkoutUrl,
  deactivateLicense,
  getLicenseStatus,
  requireLicense
} from "./services/licensing.mjs";
import {
  cancelImport,
  configureImportQueue,
  describeImportFiles,
  enqueueImports,
  listImportJobs,
  retryImport,
  wakeImportQueue
} from "./services/import-queue.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: "minuteflow-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let mainWindow;
let latestUpdateCheck;
const recordingFiles = new Map();
let preferenceWriteQueue = Promise.resolve();
// File paths the renderer obtained from a native dialog within this session.
// imports:enqueue may only read paths explicitly chosen or dropped this session.
const recentImportPaths = new Set();

// Last-resort handlers so an unawaited rejection (e.g. a progress callback
// firing after the window closed) is logged instead of swallowed silently.
process.on("unhandledRejection", (reason) => {
  console.error("未处理的 Promise 拒绝：", reason);
});
process.on("uncaughtException", (error) => {
  console.error("未捕获的异常：", error);
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label}格式无效。`);
  }
}
const defaultPreferences = {
  summaryIntervalSeconds: 120,
  defaultMode: "online",
  glossary: [],
  retentionDays: null,
  onboardingCompleted: false,
  systemPermissionsCompleted: false,
  permissionsVersion: 0
};

function preferencesPath() {
  return path.join(app.getPath("userData"), "config", "preferences.json");
}

function localModelDirectory() {
  return path.join(app.getPath("userData"), "models", "whisper");
}

function transcribeLocally(profile, audio, fileName, language, glossary) {
  switch (profile.transport) {
    case "whisper-python":
      return transcribeWithPythonWhisper(profile, audio, fileName, language, glossary);
    case "faster-whisper":
      return transcribeWithFasterWhisper(profile, audio, fileName, language, glossary);
    case "mlx-whisper":
      return transcribeWithMlxWhisper(profile, audio, fileName, language, glossary);
    default:
      return transcribeWithWhisperCpp(profile, audio, fileName, language, glossary);
  }
}

const LOCAL_TRANSCRIPTION_TRANSPORTS = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"];

async function resolveLocalTranscriptionProfile(profile) {
  if (!LOCAL_TRANSCRIPTION_TRANSPORTS.includes(profile.transport)) return profile;
  const resolution = await resolveLocalModelProfile(profile, {
    modelDirectory: localModelDirectory(),
    roots: [
      app.getPath("downloads"),
      path.join(homedir(), ".cache", "whisper"),
      path.join(homedir(), ".cache", "huggingface", "hub")
    ]
  });
  if (resolution.readiness.status !== "ready") {
    throw new Error(`${resolution.readiness.message}请在转录设置中下载模型后重试。`);
  }
  if (!profile.options?.modelPath && resolution.profile.options?.modelPath) {
    saveModelProfile({
      ...profile,
      options: { ...profile.options, modelPath: resolution.profile.options.modelPath }
    });
  }
  return resolution.profile;
}

async function loadPreferences() {
  try {
    return { ...defaultPreferences, ...JSON.parse(await readFile(preferencesPath(), "utf8")) };
  } catch {
    return defaultPreferences;
  }
}

async function persistPreferences(preferences) {
  const validated = {
    summaryIntervalSeconds: Math.max(30, Number(preferences.summaryIntervalSeconds) || 120),
    defaultMode: preferences.defaultMode === "offline" ? "offline" : "online",
    glossary: Array.isArray(preferences.glossary)
      ? preferences.glossary.map((item) => String(item).trim()).filter(Boolean).slice(0, 500)
      : [],
    retentionDays: preferences.retentionDays === null
      ? null
      : Math.max(0, Number(preferences.retentionDays) || 0),
    onboardingCompleted: Boolean(preferences.onboardingCompleted),
    systemPermissionsCompleted: Boolean(preferences.systemPermissionsCompleted),
    permissionsVersion: Math.max(0, Number(preferences.permissionsVersion) || 0)
  };
  const target = preferencesPath();
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return validated;
}

async function pruneExpiredRecordings() {
  const preferences = await loadPreferences();
  if (preferences.retentionDays === null) return;
  for (const audioPath of listExpiredAudioPaths(preferences.retentionDays)) {
    await unlink(audioPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    deleteAudioPathRecord(audioPath);
  }
}

function isTrustedRenderer(url) {
  if (process.env.VITE_DEV_SERVER_URL) {
    return url.startsWith(process.env.VITE_DEV_SERVER_URL);
  }
  return url.startsWith("file:");
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f7f7f8",
    title: "MinuteFlow",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRenderer(url)) event.preventDefault();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(currentDirectory, "..", "dist", "client", "index.html"));
  }
}

function configurePermissions() {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!isTrustedRenderer(requestingOrigin)) return false;
    return ["media", "display-capture"].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedRenderer(webContents.getURL()) && ["media", "display-capture"].includes(permission));
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 }
      });
      if (!sources.length) return callback({});
      callback({
        video: sources[0],
        ...(["darwin", "win32"].includes(process.platform) ? { audio: "loopback" } : {})
      });
    } catch {
      callback({});
    }
  });
}

function senderIsTrusted(event) {
  return Boolean(event.senderFrame?.url && isTrustedRenderer(event.senderFrame.url));
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!senderIsTrusted(event)) throw new Error("拒绝来自非信任页面的请求。");
    return handler(event, ...args);
  });
}

function idleUpdateState() {
  return {
    status: process.platform === "darwin" ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
    checkedAt: "",
    message: process.platform === "darwin"
      ? "尚未检查更新。"
      : "当前仅为 macOS 提供官网更新检测。"
  };
}

async function runMacUpdateCheck({ notify = false } = {}) {
  try {
    latestUpdateCheck = await checkForMacUpdate({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    });
  } catch (error) {
    latestUpdateCheck = {
      status: "error",
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "检查更新失败。"
    };
  }
  if (notify && latestUpdateCheck.status === "available") {
    // Guard against the window being closed during the 5s startup delay.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("updates:available", latestUpdateCheck);
    }
  }
  return latestUpdateCheck;
}

function registerIpc() {
  trustedHandle("meetings:list", (_event, query, includeDeleted) => listMeetings(query, includeDeleted));
  trustedHandle("meetings:get", (_event, id) => loadMeeting(id));
  trustedHandle("meetings:create", (_event, input) => createMeeting(input));
  trustedHandle("meetings:save", (_event, meeting) => saveMeeting(meeting));
  trustedHandle("meetings:delete", (_event, id) => softDeleteMeeting(id));
  trustedHandle("meetings:restore", (_event, id) => restoreMeeting(id));

  trustedHandle("recordings:start", async (_event, meetingId) => {
    await requireLicense();
    assertUuid(meetingId, "会议 ID");
    const meeting = loadMeeting(meetingId);
    if (!meeting) throw new Error("会议不存在。");
    const sessionId = randomUUID();
    const directory = path.join(app.getPath("userData"), "meetings", meetingId, "audio");
    await mkdir(directory, { recursive: true });
    for (const track of ["microphone", "system"]) {
      const filePath = path.join(directory, `${sessionId}-${track}.partial`);
      recordingFiles.set(`${sessionId}:${track}`, {
        filePath,
        handle: await open(filePath, "a"),
        mimeType: "audio/webm",
        writeQueue: Promise.resolve(),
        closing: false,
        lastError: null
      });
    }
    saveMeeting({ ...meeting, status: "recording", updatedAt: new Date().toISOString() });
    return { sessionId, startedAt: Date.now() };
  });

  trustedHandle("recordings:append", async (_event, payload) => {
    await requireLicense();
    assertUuid(payload.sessionId, "录音会话 ID");
    assertUuid(payload.meetingId, "会议 ID");
    const record = recordingFiles.get(`${payload.sessionId}:${payload.track}`);
    if (!record) throw new Error("录音会话已失效。");
    if (record.closing) throw new Error("录音正在完成写盘，请勿重复提交音频块。");
    record.mimeType = payload.mimeType || record.mimeType;
    // Recover the chain after any prior rejection so a single transient write
    // failure (e.g. low disk) does not permanently poison every later chunk.
    // Record the first error on the session and surface it at stop time.
    record.writeQueue = record.writeQueue.catch(() => {}).then(async () => {
      const fileSystem = await statfs(path.dirname(record.filePath));
      const availableBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
      if (availableBytes < 256 * 1024 * 1024) {
        throw new Error("磁盘剩余空间低于 256MB，请尽快停止录音并清理空间。");
      }
      const buffer = Buffer.from(payload.data);
      await record.handle.write(buffer);
      appendAudioChunk({
        meetingId: payload.meetingId,
        sessionId: payload.sessionId,
        track: payload.track,
        sequence: payload.sequence,
        byteLength: buffer.byteLength,
        path: record.filePath
      });
      // A successful write clears a prior transient error so the session can
      // recover instead of being permanently poisoned.
      record.lastError = null;
    }).catch((error) => {
      record.lastError ??= error instanceof Error ? error : new Error(String(error));
    });
    await record.writeQueue;
    // A successful write clears a transient error (e.g. disk freed up), so the
    // session can recover instead of being permanently poisoned. The error is
    // still surfaced at stop time if it was never recovered.
    return { ok: true };
  });

  trustedHandle("recordings:stop", async (_event, payload) => {
    assertUuid(payload.sessionId, "录音会话 ID");
    assertUuid(payload.meetingId, "会议 ID");
    const output = {};
    const errors = [];
    for (const track of ["microphone", "system"]) {
      const key = `${payload.sessionId}:${track}`;
      const record = recordingFiles.get(key);
      if (!record) continue;
      record.closing = true;
      await record.writeQueue.catch((error) => {
        record.lastError ??= error instanceof Error ? error : new Error(String(error));
      });
      await record.handle.close().catch((error) => {
        record.lastError ??= error instanceof Error ? error : new Error(String(error));
      });
      if (record.lastError) {
        // Keep the .partial file for diagnostics; do not finalize a corrupted
        // track. Surface the error at the end so the meeting is marked
        // interrupted rather than silently complete.
        errors.push(`${track}: ${record.lastError.message}`);
        recordingFiles.delete(key);
        continue;
      }
      const extension = record.mimeType?.includes("mp4") ? ".m4a" : ".webm";
      const target = record.filePath.replace(/\.partial$/, extension);
      const fileStat = await stat(record.filePath).catch(() => null);
      if (fileStat?.size) {
        await rename(record.filePath, target);
        finalizeAudioPath(payload.sessionId, track, target);
        output[track] = target;
      } else {
        await unlink(record.filePath).catch(() => {});
      }
      recordingFiles.delete(key);
    }
    const meeting = loadMeeting(payload.meetingId);
    if (meeting) {
      const hasError = errors.length > 0;
      saveMeeting({
        ...meeting,
        status: hasError ? "interrupted" : "complete",
        durationSeconds: payload.durationSeconds,
        notes: hasError
          ? [...meeting.notes, `[${new Date().toISOString()}] 录音未完整写盘：${errors.join("；")}`]
          : meeting.notes,
        updatedAt: new Date().toISOString()
      });
      if (hasError) {
        throw new Error(`录音文件写入未完成：${errors.join("；")}`);
      }
    }
    return output;
  });

  trustedHandle("recordings:abort", async (_event, payload) => {
    assertUuid(payload.sessionId, "录音会话 ID");
    assertUuid(payload.meetingId, "会议 ID");
    for (const track of ["microphone", "system"]) {
      const key = `${payload.sessionId}:${track}`;
      const record = recordingFiles.get(key);
      if (!record) continue;
      // Drain pending writes before unlinking so an in-flight buffer write
      // cannot race with the close/unlink below.
      await record.writeQueue.catch(() => {});
      await record.handle.close().catch(() => {});
      await unlink(record.filePath).catch(() => {});
      recordingFiles.delete(key);
    }
    const meeting = loadMeeting(payload.meetingId);
    if (meeting) {
      saveMeeting({ ...meeting, status: "draft", updatedAt: new Date().toISOString() });
    }
    return { ok: true };
  });

  trustedHandle("recordings:open", async (_event, meetingId) => {
    assertUuid(meetingId, "会议 ID");
    const paths = listMeetingAudioPaths(meetingId);
    const target = paths[0];
    if (!target) throw new Error("这场会议还没有可访问的录音文件。");
    shell.showItemInFolder(target);
    return { path: target };
  });
  trustedHandle("recordings:assets", (_event, meetingId) => {
    assertUuid(meetingId, "会议 ID");
    return listMeetingAudioAssets(meetingId).map((asset) => ({
      id: asset.id,
      track: asset.track,
      originalName: asset.originalName,
      durationMs: asset.durationMs,
      url: `minuteflow-media://audio/${asset.id}`
    }));
  });

  trustedHandle("transcription:chunk", async (_event, payload) => {
    await requireLicense();
    const profiles = listModelProfiles();
    const profile = profiles.find((item) => item.id === payload.profileId && item.kind === "stt");
    if (!profile) throw new Error("尚未配置转录模型。");
    const audio = Buffer.from(payload.data);
    const isLocal = LOCAL_TRANSCRIPTION_TRANSPORTS.includes(profile.transport);
    const localProfile = isLocal
      ? await resolveLocalTranscriptionProfile(profile)
      : profile;
    const result = isLocal
      ? await transcribeLocally(localProfile, audio, payload.fileName, payload.language, payload.glossary)
      : await transcribeRemote(
        profile,
        readSecret(profile.secretId),
        audio,
        payload.fileName,
        payload.language,
        payload.glossary
      );
    return {
      id: randomUUID(),
      startMs: payload.startMs,
      endMs: payload.endMs,
      speakerId: payload.track === "microphone" ? "me" : "remote",
      speakerName: payload.track === "microphone" ? "我" : "远端发言人",
      text: result.text,
      status: "final",
      track: payload.track
    };
  });

  trustedHandle("summary:generate", async (_event, payload) => {
    await requireLicense();
    const profiles = listModelProfiles();
    const profile = profiles.find((item) => item.id === payload.profileId && item.kind === "llm");
    const summary = profile
      ? await summarizeWithOpenAICompatible(profile, readSecret(profile.secretId), payload.input, payload.final)
      : summarizeLocally(payload.input);
    return { ...summary, updatedAt: new Date().toISOString(), stale: false };
  });

  trustedHandle("models:list", () => listModelProfiles());
  trustedHandle("models:save", (_event, profile, apiKey) => {
    let secretId = profile.secretId;
    if (apiKey) secretId = storeSecret(apiKey, secretId);
    const saved = saveModelProfile({ ...profile, secretId });
    wakeImportQueue();
    return saved;
  });
  trustedHandle("models:test", async (_event, profile, apiKey) => {
    const resolved = LOCAL_TRANSCRIPTION_TRANSPORTS.includes(profile.transport)
      ? await resolveLocalTranscriptionProfile(profile)
      : profile;
    return testModelProfile(resolved, apiKey || readSecret(profile.secretId));
  });
  trustedHandle("models:delete-secret", (_event, secretId) => deleteSecret(secretId));
  trustedHandle("models:scan-local", async () => discoverLocalModels({
    modelDirectory: localModelDirectory(),
    roots: [
      app.getPath("downloads"),
      path.join(homedir(), ".cache", "whisper"),
      path.join(homedir(), ".cache", "huggingface", "hub")
    ]
  }));
  trustedHandle("models:choose-local", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择本地 Whisper 模型",
      properties: ["openFile"],
      filters: [
        { name: "Whisper 模型", extensions: ["pt", "bin", "gguf"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const fileStat = await stat(filePath);
    const model = describeLocalModel(filePath, fileStat.size);
    if (!model) throw new Error("暂不支持该模型格式，请选择 .pt、.bin 或 .gguf 文件。");
    return model;
  });
  trustedHandle("models:catalog", () => listDownloadableModels(localModelDirectory()));
  trustedHandle("models:download", (event, modelId) => downloadModel(
    modelId,
    localModelDirectory(),
    (progress) => {
      // Guard against the window closing mid-download: sending to a destroyed
      // webContents throws "Object has been destroyed" and aborts the download.
      if (!event.sender.isDestroyed()) event.sender.send("models:download-progress", progress);
    }
  ));

  trustedHandle("notes:import-markdown", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入 Markdown 笔记",
      properties: ["openFile"],
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat && fileStat.size > 5 * 1024 * 1024) {
      throw new Error("Markdown 文件过大（超过 5MB），请拆分后再导入。");
    }
    return { filePath, content: await readFile(filePath, "utf8") };
  });

  trustedHandle("imports:choose", async () => {
    const files = await chooseImportFiles(mainWindow);
    for (const filePath of files) recentImportPaths.add(filePath);
    return describeImportFiles(files);
  });
  trustedHandle("imports:describe-dropped", async (_event, files) => {
    const allowed = Array.isArray(files) ? files.filter((filePath) => typeof filePath === "string" && path.isAbsolute(filePath)) : [];
    for (const filePath of allowed) recentImportPaths.add(filePath);
    return describeImportFiles(allowed);
  });
  trustedHandle("imports:enqueue", async (_event, items, options) => {
    await requireLicense();
    if (!Array.isArray(items) || !items.length) throw new Error("没有可导入的文件。");
    for (const item of items) {
      if (!item?.sourcePath || !recentImportPaths.has(item.sourcePath)) {
        throw new Error("文件路径无效，请重新选择要导入的文件。");
      }
    }
    for (const item of items) recentImportPaths.delete(item.sourcePath);
    return enqueueImports(items, options);
  });
  trustedHandle("imports:list", () => listImportJobs());
  trustedHandle("imports:retry", async (_event, id) => { await requireLicense(); assertUuid(id, "任务 ID"); return retryImport(id); });
  trustedHandle("imports:cancel", async (_event, id) => { await requireLicense(); assertUuid(id, "任务 ID"); return cancelImport(id); });
  trustedHandle("exports:save", async (_event, meeting, format) => {
    await requireLicense();
    return exportMeeting(meeting, format, mainWindow, listMeetingAudioPaths(meeting.id));
  });
  trustedHandle("preferences:get", () => loadPreferences());
  trustedHandle("preferences:save", (_event, preferences) => {
    preferenceWriteQueue = preferenceWriteQueue.then(
      () => persistPreferences(preferences),
      () => persistPreferences(preferences)
    );
    return preferenceWriteQueue;
  });
  trustedHandle("updates:get-state", () => latestUpdateCheck ?? idleUpdateState());
  trustedHandle("updates:check", () => runMacUpdateCheck());
  trustedHandle("updates:open-download", async () => {
    if (latestUpdateCheck?.status !== "available" || !latestUpdateCheck.update?.downloadUrl) {
      throw new Error("请先检查更新。");
    }
    if (!isOfficialHttpsUrl(latestUpdateCheck.update.downloadUrl)) {
      throw new Error("更新下载地址未通过安全校验。");
    }
    await shell.openExternal(latestUpdateCheck.update.downloadUrl);
    return { opened: true };
  });
  trustedHandle("licensing:get-status", (_event, refresh = false) => getLicenseStatus({ refresh }));
  trustedHandle("licensing:activate", (_event, licenseKey) => activateLicense(licenseKey));
  trustedHandle("licensing:deactivate", () => deactivateLicense());
  trustedHandle("licensing:open-checkout", async () => {
    await shell.openExternal(await checkoutUrl());
    return { opened: true };
  });
  trustedHandle("system:get-permissions", () => {
    if (process.platform === "darwin") {
      return {
        microphone: systemPreferences.getMediaAccessStatus("microphone"),
        screen: systemPreferences.getMediaAccessStatus("screen"),
        systemAudioRequired: true,
        // CoreAudio Tap authorization is completed during first-run setup; the
        // app-controlled source avoids reopening the native picker per meeting.
        systemAudioPickerHint: false
      };
    }
    if (process.platform === "win32") {
      return {
        microphone: systemPreferences.getMediaAccessStatus("microphone"),
        screen: "granted",
        systemAudioRequired: false,
        systemAudioPickerHint: false
      };
    }
    return { microphone: "unknown", screen: "unknown", systemAudioRequired: false, systemAudioPickerHint: false };
  });
  trustedHandle("system:request-microphone", async () => {
    if (process.platform === "darwin") await systemPreferences.askForMediaAccess("microphone");
    return process.platform === "darwin" || process.platform === "win32"
      ? systemPreferences.getMediaAccessStatus("microphone")
      : "unknown";
  });
  trustedHandle("system:open-settings", (_event, kind = "microphone") => {
    if (process.platform === "darwin") {
      const pane = kind === "screen" ? "Privacy_ScreenCapture" : "Privacy_Microphone";
      return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    }
    // Windows: route both microphone and screen capture to the microphone
    // privacy page (Windows treats desktop/audio capture under microphone
    // access). broadfilesystemaccess was the wrong pane.
    return shell.openExternal("ms-settings:privacy-microphone");
  });
  trustedHandle("window:toggle-mini", (_event, enabled) => {
    if (!mainWindow) return false;
    if (enabled) {
      mainWindow.setAlwaysOnTop(true, "floating");
      mainWindow.setMinimumSize(420, 104);
      mainWindow.setSize(420, 104, true);
    } else {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setMinimumSize(1080, 720);
      mainWindow.setSize(1440, 960, true);
    }
    mainWindow.webContents.send("window:mini-changed", enabled);
    return enabled;
  });
}

app.whenReady().then(async () => {
  // Resolve any existing Keychain-backed credentials once at app startup so
  // recording and finalization never become the first surprise access point.
  warmSecretCache();
  protocol.handle("minuteflow-media", (request) => {
    const id = new URL(request.url).pathname.split("/").filter(Boolean).pop();
    if (!id || !UUID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
    const asset = loadAudioAsset(id);
    if (!asset) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(asset.playbackPath || asset.path).toString(), { headers: request.headers });
  });
  configurePermissions();
  registerIpc();
  markInterruptedRecordings();
  markRunningJobsInterrupted();
  configureImportQueue({
    notify: (job) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("imports:job-updated", job);
    }
  });
  await pruneExpiredRecordings().catch((error) => {
    console.error("录音保留策略清理失败：", error);
  });
  await createMainWindow();
  wakeImportQueue();

  if (process.platform === "darwin" && app.isPackaged) {
    setTimeout(() => runMacUpdateCheck({ notify: true }), 5_000);
  }

  powerMonitor.on("suspend", () => mainWindow?.webContents.send("system:suspend"));
  powerMonitor.on("resume", () => mainWindow?.webContents.send("system:resume"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let isQuitting = false;
app.on("before-quit", (event) => {
  // Electron does not await async before-quit handlers, so we must
  // preventDefault, drain the recording write queues synchronously, then exit.
  // Without this, the last audio chunk can be lost and .partial files are
  // never renamed on quit-while-recording.
  if (isQuitting || recordingFiles.size === 0) return;
  event.preventDefault();
  isQuitting = true;
  void (async () => {
    for (const record of recordingFiles.values()) {
      record.closing = true;
      await record.writeQueue.catch(() => {});
      await record.handle.close().catch(() => {});
    }
    recordingFiles.clear();
    await flushSecrets().catch(() => {});
    app.exit();
  })();
});
