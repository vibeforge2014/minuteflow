import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  powerMonitor,
  session,
  shell
} from "electron";
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  appendAudioChunk,
  createMeeting,
  deleteAudioPathRecord,
  finalizeAudioPath,
  listExpiredAudioPaths,
  listMeetings,
  listMeetingAudioPaths,
  listModelProfiles,
  loadMeeting,
  markInterruptedRecordings,
  restoreMeeting,
  saveMeeting,
  saveModelProfile,
  softDeleteMeeting
} from "./database.mjs";
import { deleteSecret, readSecret, storeSecret } from "./services/secrets.mjs";
import {
  summarizeLocally,
  summarizeWithOpenAICompatible,
  testModelProfile,
  transcribeRemote,
  transcribeWithWhisperCpp,
  transcribeWithPythonWhisper
} from "./services/providers.mjs";
import { chooseImportFiles, exportMeeting } from "./services/exports.mjs";
import { applyDiarization, diarizeWithSherpa } from "./services/diarization.mjs";
import {
  describeLocalModel,
  discoverLocalModels,
  downloadModel,
  listDownloadableModels
} from "./services/local-models.mjs";
import {
  checkForMacUpdate,
  isOfficialHttpsUrl
} from "./services/updates.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let latestUpdateCheck;
const recordingFiles = new Map();
let preferenceWriteQueue = Promise.resolve();
const defaultPreferences = {
  summaryIntervalSeconds: 120,
  defaultMode: "online",
  glossary: [],
  retentionDays: null,
  onboardingCompleted: false
};

function preferencesPath() {
  return path.join(app.getPath("userData"), "config", "preferences.json");
}

function localModelDirectory() {
  return path.join(app.getPath("userData"), "models", "whisper");
}

function transcribeLocally(profile, audio, fileName, language, glossary) {
  return profile.transport === "whisper-python"
    ? transcribeWithPythonWhisper(profile, audio, fileName, language, glossary)
    : transcribeWithWhisperCpp(profile, audio, fileName, language, glossary);
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
    onboardingCompleted: Boolean(preferences.onboardingCompleted)
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
    title: "会议助手",
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
        ...(process.platform === "win32" ? { audio: "loopback" } : {})
      });
    } catch {
      callback({});
    }
  }, { useSystemPicker: process.platform === "darwin" });
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
    mainWindow?.webContents.send("updates:available", latestUpdateCheck);
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
        closing: false
      });
    }
    saveMeeting({ ...meeting, status: "recording", updatedAt: new Date().toISOString() });
    return { sessionId, startedAt: Date.now() };
  });

  trustedHandle("recordings:append", async (_event, payload) => {
    const record = recordingFiles.get(`${payload.sessionId}:${payload.track}`);
    if (!record) throw new Error("录音会话已失效。");
    if (record.closing) throw new Error("录音正在完成写盘，请勿重复提交音频块。");
    record.mimeType = payload.mimeType || record.mimeType;
    record.writeQueue = record.writeQueue.then(async () => {
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
    });
    await record.writeQueue;
    return { ok: true };
  });

  trustedHandle("recordings:stop", async (_event, payload) => {
    const output = {};
    let writeError;
    for (const track of ["microphone", "system"]) {
      const key = `${payload.sessionId}:${track}`;
      const record = recordingFiles.get(key);
      if (!record) continue;
      record.closing = true;
      try {
        await record.writeQueue;
      } catch (error) {
        writeError ??= error;
      }
      await record.handle.close().catch((error) => { writeError ??= error; });
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
      saveMeeting({
        ...meeting,
        status: "complete",
        durationSeconds: payload.durationSeconds,
        updatedAt: new Date().toISOString()
      });
    }
    if (writeError) {
      throw new Error(`录音文件写入未完成：${writeError instanceof Error ? writeError.message : "未知错误"}`);
    }
    return output;
  });

  trustedHandle("recordings:abort", async (_event, payload) => {
    for (const track of ["microphone", "system"]) {
      const key = `${payload.sessionId}:${track}`;
      const record = recordingFiles.get(key);
      if (!record) continue;
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

  trustedHandle("transcription:chunk", async (_event, payload) => {
    const profiles = listModelProfiles();
    const profile = profiles.find((item) => item.id === payload.profileId && item.kind === "stt");
    if (!profile) throw new Error("尚未配置转录模型。");
    const audio = Buffer.from(payload.data);
    const result = ["whisper-cpp", "whisper-python"].includes(profile.transport)
      ? await transcribeLocally(profile, audio, payload.fileName, payload.language, payload.glossary)
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
    return saveModelProfile({ ...profile, secretId });
  });
  trustedHandle("models:test", (_event, profile, apiKey) =>
    testModelProfile(profile, apiKey || readSecret(profile.secretId)));
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
    (progress) => event.sender.send("models:download-progress", progress)
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
    return { filePath, content: await readFile(filePath, "utf8") };
  });

  trustedHandle("imports:choose", () => chooseImportFiles(mainWindow));
  trustedHandle("imports:process", async (_event, payload) => {
    const profiles = listModelProfiles();
    const sttProfile = profiles.find((item) =>
      item.id === payload.sttProfileId && item.kind === "stt" && item.enabled);
    if (!sttProfile) throw new Error("导入前请先配置并启用转录模型。");
    const llmProfile = profiles.find((item) =>
      item.id === payload.llmProfileId && item.kind === "llm" && item.enabled);
    const diarizationProfile = profiles.find((item) =>
      item.kind === "diarization" && item.transport === "sherpa-onnx" && item.enabled);
    const fileName = path.basename(payload.filePath);
    const title = path.basename(fileName, path.extname(fileName));
    const preferences = await loadPreferences();
    const meeting = createMeeting({
      title,
      mode: "offline",
      participants: ["待识别"],
      goals: ["转录并整理导入的录音"],
      tags: ["导入"]
    });

    try {
      const audio = await readFile(payload.filePath);
      const result = ["whisper-cpp", "whisper-python"].includes(sttProfile.transport)
        ? await transcribeLocally(
          sttProfile,
          audio,
          fileName,
          payload.language || "zh",
          preferences.glossary
        )
        : await transcribeRemote(
          sttProfile,
          readSecret(sttProfile.secretId),
          audio,
          fileName,
          payload.language || "zh",
          preferences.glossary
        );
      const durationSeconds = Math.max(0, Math.round(result.duration ?? 0));
      let transcript = result.segments?.length
        ? result.segments.map((segment) => ({
          id: randomUUID(),
          startMs: segment.startMs,
          endMs: segment.endMs,
          speakerId: "speaker-1",
          speakerName: "Speaker 1",
          text: segment.text,
          status: "final",
          track: "mixed"
        }))
        : result.text.trim()
          ? [{
            id: randomUUID(),
            startMs: 0,
            endMs: durationSeconds ? durationSeconds * 1000 : 1,
            speakerId: "speaker-1",
            speakerName: "Speaker 1",
            text: result.text.trim(),
            status: "final",
            track: "mixed"
          }]
          : [];
      if (diarizationProfile && transcript.length) {
        const turns = await diarizeWithSherpa(
          diarizationProfile,
          payload.filePath,
          { expectedSpeakers: -1 }
        );
        transcript = applyDiarization(transcript, turns);
      }
      const summaryInput = {
        title: meeting.title,
        goals: meeting.goals,
        notes: [`导入文件：${fileName}`],
        transcript,
        previousSummary: meeting.summary
      };
      const summary = llmProfile
        ? await summarizeWithOpenAICompatible(
          llmProfile,
          readSecret(llmProfile.secretId),
          summaryInput,
          true
        )
        : summarizeLocally(summaryInput);
      return saveMeeting({
        ...meeting,
        status: "complete",
        durationSeconds,
        notes: [`导入文件：${fileName}`],
        notesMarkdown: `导入文件：${fileName}`,
        transcript,
        summary: {
          ...summary,
          updatedAt: new Date().toISOString(),
          stale: false
        }
      });
    } catch (error) {
      saveMeeting({
        ...meeting,
        status: "interrupted",
        notes: [
          `导入文件：${fileName}`,
          `处理失败：${error instanceof Error ? error.message : "未知错误"}`
        ],
        notesMarkdown: `导入文件：${fileName}\n\n处理失败：${error instanceof Error ? error.message : "未知错误"}`
      });
      throw error;
    }
  });
  trustedHandle("exports:save", (_event, meeting, format) =>
    exportMeeting(meeting, format, mainWindow, listMeetingAudioPaths(meeting.id)));
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
  trustedHandle("system:open-settings", () => {
    if (process.platform === "darwin") {
      return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    }
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
  configurePermissions();
  registerIpc();
  markInterruptedRecordings();
  await pruneExpiredRecordings().catch((error) => {
    console.error("录音保留策略清理失败：", error);
  });
  await createMainWindow();

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

app.on("before-quit", async () => {
  for (const record of recordingFiles.values()) {
    record.closing = true;
    await record.writeQueue.catch(() => {});
    await record.handle.close().catch(() => {});
  }
});
