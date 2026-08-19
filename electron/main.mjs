/**
 * Electron 主进程入口（装配层）。
 * 负责创建主窗口、配置系统权限与受信任页面白名单、注册全部 prefixed IPC 通道
 * （meetings:* / recordings:* / transcription:* / summary:* / models:* / notes:* /
 * imports:* / exports:* / preferences:* / licensing:* / updates:* / system:* / window:*），
 * 并在启动时装配 database、secrets、providers、licensing、local-models、
 * import-queue、updates、exports 等服务模块。
 * 本文件不导出符号，仅由 Electron 运行时加载；渲染层经 preload.cjs 暴露的
 * window.meetingAPI.* 调用这里注册的通道。
 */
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences
} from "electron";
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
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
import { simplifyTranscriptResult } from "./services/chinese.mjs";
import { audioContentType, parseByteRange } from "./services/media.mjs";
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

// 当前文件所在目录：用于定位 preload.cjs 与打包后的前端产物。
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
// minuteflow-media:// 是音频播放专用自定义协议；必须在 app ready 之前注册为
// 特权协议，才能支持 fetch 与流式传输（会议播放器按需读取本地音频文件）。
protocol.registerSchemesAsPrivileged([{ scheme: "minuteflow-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let mainWindow;
let latestUpdateCheck;
// 录音会话的运行时状态（文件句柄 + 串行写队列 + 首个错误），键为 `${sessionId}:${track}`。
// 仅存在于内存中；崩溃重启后由 database 的 markInterruptedRecordings 兜底为 interrupted 状态。
const recordingFiles = new Map();
// 进行中的总结请求（AbortController），键为 meetingId；summary:cancel 据此中止对应请求。
const activeSummaryRequests = new Map();
// 偏好设置写入串行队列：并发触发 preferences:save 时按提交顺序落盘，避免相互覆盖。
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

/**
 * 校验字符串是否为标准 UUID 格式，不合法立即抛错。
 * 安全边界：防止渲染层传入任意字符串后被拼进文件路径或数据库查询。
 * @param {unknown} value 待校验值
 * @param {string} label 出错提示中使用的字段名
 */
function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label}格式无效。`);
  }
}
/** 偏好设置默认值；字段集合需与 persistPreferences 的校验白名单保持一致。 */
const defaultPreferences = {
  summaryIntervalSeconds: 60,
  summaryCadenceVersion: 1,
  defaultMode: "online",
  glossary: [],
  retentionDays: null,
  onboardingCompleted: false,
  systemPermissionsCompleted: false,
  permissionsVersion: 0
};

/** 偏好设置 JSON 文件路径（userData/config/preferences.json）。 */
function preferencesPath() {
  return path.join(app.getPath("userData"), "config", "preferences.json");
}

/** 应用托管的本地 Whisper 模型目录（userData/models/whisper），下载的模型落在这里。 */
function localModelDirectory() {
  return path.join(app.getPath("userData"), "models", "whisper");
}

/**
 * 根据 profile.transport 把本地转录分派到对应的 Whisper 运行时。
 * @param {object} profile 已通过就绪检查的本地模型档案
 * @param {Buffer} audio 待转写的音频数据
 * @returns {Promise<{text: string, segments: Array<{startMs,endMs,text}>, duration?: number}>}
 * 副作用：可能拉起子进程（whisper.cpp / python）并写临时文件。
 */
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

/** 视为"在本机运行"的转录 transport 集合；命中时需先过 resolveLocalTranscriptionProfile 就绪检查。 */
const LOCAL_TRANSCRIPTION_TRANSPORTS = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"];

/**
 * 转录前解析并补全本地模型配置：自动发现缺失的模型文件 / 可执行文件 / FFmpeg 路径，
 * 未就绪则抛错引导用户去设置页下载模型；首次解析出的 modelPath 会回写进模型档案（写库副作用）。
 * @param {object} profile 渲染层提交的模型档案
 * @returns {Promise<object>} 补全后的可用 profile
 */
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

/**
 * 读取偏好设置；文件缺失或 JSON 损坏时回退到默认值（容错兜底，不抛错）。
 * @returns {Promise<object>} 与默认值合并后的偏好对象
 */
async function loadPreferences() {
  try {
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8"));
    const preferences = {
      ...defaultPreferences,
      ...stored,
      // v1 将旧版默认的 2 分钟迁移为用户确认的智能约 1 分钟节奏。
      summaryIntervalSeconds: Number(stored.summaryCadenceVersion) >= 1
        ? Number(stored.summaryIntervalSeconds) || 60
        : 60,
      summaryCadenceVersion: 1
    };
    if (Number(stored.summaryCadenceVersion) < 1) await persistPreferences(preferences);
    return preferences;
  } catch {
    return defaultPreferences;
  }
}

/**
 * 校验并原子化写入偏好设置：字段逐一夹取到安全范围，先写 .tmp 再 rename，
 * 避免进程中途被杀留下半个 JSON 文件。
 * @param {object} preferences 任意来源的偏好输入
 * @returns {Promise<object>} 校验后的最终落盘值
 */
async function persistPreferences(preferences) {
  const validated = {
    summaryIntervalSeconds: Math.max(30, Number(preferences.summaryIntervalSeconds) || 60),
    summaryCadenceVersion: 1,
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

/**
 * 按保留天数清理已完成会议的音频：先删磁盘文件（ENOENT 视为已删），
 * 再删数据库中的 audio_chunks / audio_assets 记录。仅在启动时调用一次。
 */
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

/**
 * 判断 URL 是否属于受信任的渲染页面：开发环境匹配 Vite dev server 前缀，
 * 生产环境只信任 file: 协议（本地打包产物）。IPC 调用与系统权限申请均以此做白名单。
 */
function isTrustedRenderer(url) {
  if (process.env.VITE_DEV_SERVER_URL) {
    return url.startsWith(process.env.VITE_DEV_SERVER_URL);
  }
  return url.startsWith("file:");
}

/**
 * 创建主窗口并加载渲染层（dev server 或打包产物 dist/client/index.html）。
 * 副作用：创建 BrowserWindow；window.open 一律转交系统浏览器，
 * 非受信任目标的导航会被拦截。
 */
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
    // 安全边界：渲染层禁用 Node 集成并启用沙箱，只能通过 preload 的 contextBridge 访问主进程能力。
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

/**
 * 收紧默认 session 的权限面：只有受信任页面可以申请 media / display-capture；
 * 屏幕捕获请求固定接到第一块屏幕，并在 macOS/Windows 上附带 loopback 系统音频。
 */
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
      // 系统音频回环采集仅在 macOS 与 Windows 上可用，其他平台只给视频源。
      callback({
        video: sources[0],
        ...(["darwin", "win32"].includes(process.platform) ? { audio: "loopback" } : {})
      });
    } catch {
      callback({});
    }
  });
}

/** 校验 IPC 事件的发送帧是否为受信任页面，防止被 iframe 等非信任上下文冒用通道。 */
function senderIsTrusted(event) {
  return Boolean(event.senderFrame?.url && isTrustedRenderer(event.senderFrame.url));
}

/**
 * 注册带发送方校验的 ipcMain.handle：非受信任来源直接拒绝。
 * 所有业务通道统一经它注册，构成主进程侧的 IPC 安全边界。
 * @param {string} channel 通道名（prefixed，如 "meetings:list"）
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => any} handler 业务处理函数
 */
function trustedHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!senderIsTrusted(event)) throw new Error("拒绝来自非信任页面的请求。");
    return handler(event, ...args);
  });
}

/** 更新检查的初始状态：仅 macOS 支持官网更新检测，其余平台直接标记 unsupported。 */
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

/**
 * 执行一次 macOS 更新检查并把结果缓存到 latestUpdateCheck（供 updates:get-state 读取）。
 * @param {{notify?: boolean}} options notify=true 且发现新版本时向渲染层推送 updates:available 事件
 * @returns {Promise<object>} 检查结果（status: available / up-to-date / unsupported / error）
 * 副作用：网络请求（updates.mjs）；检查失败降级为 error 状态而不是抛出。
 */
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

/**
 * 注册全部 prefixed IPC 通道（均经 trustedHandle 校验发送方来源）。
 * 渲染层统一通过 preload.cjs 暴露的 window.meetingAPI.* 调用；
 * 涉及付费能力的通道在入口处 await requireLicense()，在主进程侧强制执行授权墙。
 */
function registerIpc() {
  // meetings:list — 按关键词搜索/列出会议（可选包含回收站项），会议库列表页调用。
  trustedHandle("meetings:list", (_event, query, includeDeleted) => listMeetings(query, includeDeleted));
  // meetings:get — 读取单场会议完整数据，会议详情页与文档编辑器调用。
  trustedHandle("meetings:get", (_event, id) => loadMeeting(id));
  // meetings:create — 新建会议（草稿），新建会议入口调用。
  trustedHandle("meetings:create", (_event, input) => createMeeting(input));
  // meetings:save — 保存整场会议（含转录/纪要/笔记），编辑器与各后台流程调用。
  trustedHandle("meetings:save", (_event, meeting) => saveMeeting(meeting));
  // meetings:delete — 软删除（移入回收站），会议库右键/删除操作调用。
  trustedHandle("meetings:delete", (_event, id) => softDeleteMeeting(id));
  // meetings:restore — 从回收站恢复会议。
  trustedHandle("meetings:restore", (_event, id) => restoreMeeting(id));

  // recordings:start — 开始录音（付费功能）：校验授权后为麦克风/系统双轨各建一个
  // .partial 文件与串行写队列；渲染层录音工具栏调用。
  trustedHandle("recordings:start", async (_event, meetingId) => {
    await requireLicense();
    assertUuid(meetingId, "会议 ID");
    const meeting = loadMeeting(meetingId);
    if (!meeting) throw new Error("会议不存在。");
    // 同一场会议同时只允许一个活跃录音会话：清理异常路径遗留的旧会话句柄
    // （否则文件句柄与写队列会一直泄漏到应用退出）。
    for (const [staleKey, staleRecord] of recordingFiles) {
      if (staleRecord.meetingId !== meetingId) continue;
      staleRecord.closing = true;
      await staleRecord.writeQueue.catch(() => {});
      await staleRecord.handle.close().catch(() => {});
      await unlink(staleRecord.filePath).catch(() => {});
      recordingFiles.delete(staleKey);
    }
    const sessionId = randomUUID();
    const directory = path.join(app.getPath("userData"), "meetings", meetingId, "audio");
    await mkdir(directory, { recursive: true });
    // 双轨录音：microphone 为本机麦克风，system 为系统/远端声音。先以 .partial 后缀
    // 落盘，stop 成功后才原子改名为最终扩展名，避免半截文件被当作完整录音。
    for (const track of ["microphone", "system"]) {
      const filePath = path.join(directory, `${sessionId}-${track}.partial`);
      recordingFiles.set(`${sessionId}:${track}`, {
        meetingId,
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

  // recordings:append — 追加一段音频块（付费功能）：进入该轨的串行写队列，写前检查
  // 磁盘剩余空间；瞬时错误只记录在会话上（首个错误即时经 recordings:write-error 推送），
  // stop 时统一上报，避免单个坏块毒化整个会话。
  trustedHandle("recordings:append", async (event, payload) => {
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
      const isFirstError = record.lastError === null;
      record.lastError ??= error instanceof Error ? error : new Error(String(error));
      // 首次写盘失败立即推送给渲染层，让用户在录音过程中就看到磁盘告警
      // （而不是等 stop 收尾时才知道）；写链恢复成功后上面会清掉 lastError。
      if (isFirstError && !event.sender.isDestroyed()) {
        event.sender.send("recordings:write-error", {
          track: payload.track,
          message: record.lastError.message
        });
      }
    });
    await record.writeQueue;
    // A successful write clears a transient error (e.g. disk freed up), so the
    // session can recover instead of being permanently poisoned. The error is
    // still surfaced at stop time if it was never recovered.
    return { ok: true };
  });

  // recordings:stop — 结束录音：等待该会话全部写队列排空、关闭句柄、原子改名为
  // .webm/.m4a 并更新数据库路径；任一轨失败则会议标记 interrupted 并保留 .partial 供诊断。
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
      // 依据实际 MIME 类型决定最终扩展名；只有写入了数据的文件才改名归档，
      // 空文件直接清理，避免留下 0 字节的"完整"录音。
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

  // recordings:abort — 放弃录音：排空在途写入后删除 .partial 文件，会议回到 draft 状态。
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

  // recordings:open — 在系统文件管理器中定位显示该会议的首个录音文件。
  trustedHandle("recordings:open", async (_event, meetingId) => {
    assertUuid(meetingId, "会议 ID");
    const paths = listMeetingAudioPaths(meetingId);
    const target = paths[0];
    if (!target) throw new Error("这场会议还没有可访问的录音文件。");
    shell.showItemInFolder(target);
    return { path: target };
  });
  // recordings:assets — 列出会议音频资产并生成 minuteflow-media:// 播放地址，会议播放器调用。
  trustedHandle("recordings:assets", async (_event, meetingId) => {
    assertUuid(meetingId, "会议 ID");
    const assets = await Promise.all(listMeetingAudioAssets(meetingId).map(async (asset) => {
      const playablePath = asset.playbackPath || asset.path;
      const fileStat = await stat(playablePath).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size <= 0) return null;
      return {
        id: asset.id,
        track: asset.track,
        originalName: asset.originalName,
        durationMs: asset.durationMs,
        url: `minuteflow-media://audio/${asset.id}`
      };
    }));
    return assets.filter(Boolean);
  });

  // transcription:chunk — 对一小段音频执行转录（付费功能）：本地 transport 先做就绪
  // 检查再分派本地运行时，远程走 transcribeRemote；说话人按轨粗分为"我/远端发言人"。
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
    const rawResult = isLocal
      ? await transcribeLocally(localProfile, audio, payload.fileName, payload.language, payload.glossary)
      : await transcribeRemote(
        profile,
        readSecret(profile.secretId),
        audio,
        payload.fileName,
        payload.language,
        payload.glossary
      );
    const result = simplifyTranscriptResult(rawResult);
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

  // summary:generate — 生成或滚动更新会议纪要（付费功能）：显式选择离线纪要走本地规则引擎，
  // 配置了在线 LLM 档案走在线接口（失败时回退本地引擎并在响应中带 degraded 标记告知用户，
  // 不再静默降级），未配置档案同样返回带 degraded 标记的本地纪要；
  // 由渲染层"生成纪要"操作显式触发（录音停止不会自动触发，避免停止时才弹 Keychain）。
  trustedHandle("summary:generate", async (_event, payload) => {
    await requireLicense();
    // 入参防御：转写段必须是数组且逐条至少有文本，避免把任意结构喂给模型或规则引擎。
    const input = payload?.input;
    if (!input || !Array.isArray(input.transcript)) {
      throw new Error("总结请求缺少会议上下文。");
    }
    const sanitized = {
      title: String(input.title ?? ""),
      goals: Array.isArray(input.goals) ? input.goals.map((item) => String(item)) : [],
      notes: Array.isArray(input.notes) ? input.notes.map((item) => String(item)) : [],
      transcript: input.transcript.filter((segment) => segment && typeof segment.text === "string"),
      previousSummary: input.previousSummary ?? {}
    };
    const sourceThroughMs = sanitized.transcript.reduce(
      (maximum, segment) => Math.max(maximum, Number(segment.endMs) || 0),
      0
    );
    const finishedAt = () => new Date().toISOString();
    const profiles = listModelProfiles();
    const profile = profiles.find((item) => item.id === payload.profileId && item.kind === "llm");
    if (profile?.transport === "local-summary") {
      return { ...summarizeLocally(sanitized), updatedAt: finishedAt(), generationMode: "local", sourceThroughMs, stale: false };
    }
    if (!profile) {
      return {
        ...summarizeLocally(sanitized),
        updatedAt: finishedAt(),
        generationMode: "local",
        sourceThroughMs,
        stale: false,
        degraded: true,
        degradedReason: "尚未配置在线总结服务，本次已用本机基础纪要生成；可在设置中选择总结服务获得更好的效果。"
      };
    }
    const meetingKey = typeof payload.meetingId === "string" ? payload.meetingId : "default";
    const controller = new AbortController();
    activeSummaryRequests.set(meetingKey, controller);
    try {
      const summary = await summarizeWithOpenAICompatible(
        profile,
        readSecret(profile.secretId),
        sanitized,
        Boolean(payload.final),
        controller.signal
      );
      return { ...summary, updatedAt: finishedAt(), generationMode: "online", sourceThroughMs, stale: false };
    } catch (error) {
      // 用户主动取消不降级，原样抛出；其余失败（断网/超时/鉴权）回退本地纪要并明确告知。
      if (controller.signal.aborted || error?.name === "AbortError") throw error;
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...summarizeLocally(sanitized),
        updatedAt: finishedAt(),
        generationMode: "local",
        sourceThroughMs,
        stale: false,
        degraded: true,
        degradedReason: `在线总结失败（${reason}），已回退生成本机基础纪要。`
      };
    } finally {
      if (activeSummaryRequests.get(meetingKey) === controller) activeSummaryRequests.delete(meetingKey);
    }
  });

  // summary:cancel — 取消一场会议进行中的总结请求（中止 AbortController，无付费墙）。
  trustedHandle("summary:cancel", (_event, meetingId) => {
    const controller = typeof meetingId === "string" ? activeSummaryRequests.get(meetingId) : undefined;
    controller?.abort();
    return { ok: true };
  });

  // models:list — 列出已保存的模型档案（stt/llm/diarization），设置页服务目录调用。
  trustedHandle("models:list", () => listModelProfiles());
  // models:save — 保存模型档案；随附的 API Key 经 secrets.mjs 加密入库，
  // 保存后唤醒可能因缺模型而暂停的导入队列。
  trustedHandle("models:save", (_event, profile, apiKey) => {
    let secretId = profile.secretId;
    if (apiKey) secretId = storeSecret(apiKey, secretId);
    const saved = saveModelProfile({ ...profile, secretId });
    wakeImportQueue();
    return saved;
  });
  // models:test — 测试模型连通性/本地就绪度，设置页"测试"按钮调用。
  trustedHandle("models:test", async (_event, profile, apiKey) => {
    const resolved = LOCAL_TRANSCRIPTION_TRANSPORTS.includes(profile.transport)
      ? await resolveLocalTranscriptionProfile(profile)
      : profile;
    return testModelProfile(resolved, apiKey || readSecret(profile.secretId));
  });
  // models:delete-secret — 删除指定凭据（删除/切换档案时调用，避免密钥残留）。
  trustedHandle("models:delete-secret", (_event, secretId) => deleteSecret(secretId));
  // models:scan-local — 扫描常见目录发现已有本地 Whisper 模型（下载目录、
  // ~/.cache/whisper、HuggingFace 缓存），设置页本地模型发现流程调用。
  trustedHandle("models:scan-local", async () => discoverLocalModels({
    modelDirectory: localModelDirectory(),
    roots: [
      app.getPath("downloads"),
      path.join(homedir(), ".cache", "whisper"),
      path.join(homedir(), ".cache", "huggingface", "hub")
    ]
  }));
  // models:choose-local — 打开文件选择器手动指定模型文件（.pt/.bin/.gguf），
  // 手动路径兜底入口（默认流程优先自动发现与下载）。
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
  // models:catalog — 列出可下载模型目录及其本机安装状态，设置页下载列表调用。
  trustedHandle("models:catalog", () => listDownloadableModels(localModelDirectory()));
  // models:download — 下载模型到应用托管目录，进度经 models:download-progress 事件推送回渲染层。
  trustedHandle("models:download", (event, modelId) => downloadModel(
    modelId,
    localModelDirectory(),
    (progress) => {
      // Guard against the window closing mid-download: sending to a destroyed
      // webContents throws "Object has been destroyed" and aborts the download.
      if (!event.sender.isDestroyed()) event.sender.send("models:download-progress", progress);
    }
  ));

  // notes:import-markdown — 选择并读入 Markdown 笔记（限 5MB），个人笔记导入入口调用。
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

  // imports:choose — 打开多选文件对话框选择音视频导入源，并把所选路径
  // 记入本会话白名单 recentImportPaths（后续 enqueue 只放行这些路径）。
  trustedHandle("imports:choose", async () => {
    const files = await chooseImportFiles(mainWindow);
    for (const filePath of files) recentImportPaths.add(filePath);
    return describeImportFiles(files);
  });
  // imports:describe-dropped — 描述拖拽进窗口的文件（仅接受绝对路径），同样登记进会话白名单。
  trustedHandle("imports:describe-dropped", async (_event, files) => {
    const allowed = Array.isArray(files) ? files.filter((filePath) => typeof filePath === "string" && path.isAbsolute(filePath)) : [];
    for (const filePath of allowed) recentImportPaths.add(filePath);
    return describeImportFiles(allowed);
  });
  // imports:enqueue — 确认导入（付费功能）：只接受本会话内选择/拖拽过的路径，
  // 入队成功后即从白名单移除，防止重放任意路径读取用户文件。
  trustedHandle("imports:enqueue", async (_event, items, options) => {
    await requireLicense();
    if (!Array.isArray(items) || !items.length) throw new Error("没有可导入的文件。");
    // 安全边界：导入源必须来自本会话内对话框选择或拖拽登记的路径，拒绝任意路径注入。
    for (const item of items) {
      if (!item?.sourcePath || !recentImportPaths.has(item.sourcePath)) {
        throw new Error("文件路径无效，请重新选择要导入的文件。");
      }
    }
    for (const item of items) recentImportPaths.delete(item.sourcePath);
    return enqueueImports(items, options);
  });
  // imports:list — 列出导入任务及状态，导入中心/队列面板调用。
  trustedHandle("imports:list", () => listImportJobs());
  // imports:retry — 重试失败的导入任务（付费功能）。
  trustedHandle("imports:retry", async (_event, id) => { await requireLicense(); assertUuid(id, "任务 ID"); return retryImport(id); });
  // imports:cancel — 取消进行中/排队的导入任务（付费功能）：中止 AbortController 并杀掉子进程。
  trustedHandle("imports:cancel", async (_event, id) => { await requireLicense(); assertUuid(id, "任务 ID"); return cancelImport(id); });
  // exports:save — 导出会议为 md/txt/json/srt/vtt/docx/pdf/zip（付费功能），导出菜单调用。
  trustedHandle("exports:save", async (_event, meeting, format) => {
    await requireLicense();
    return exportMeeting(meeting, format, mainWindow, listMeetingAudioPaths(meeting.id));
  });
  // preferences:get — 读取偏好设置，设置页加载时调用。
  trustedHandle("preferences:get", () => loadPreferences());
  // preferences:save — 保存偏好：写入进入串行队列避免并发覆盖（原子写盘在 persistPreferences 内）。
  trustedHandle("preferences:save", (_event, preferences) => {
    preferenceWriteQueue = preferenceWriteQueue.then(
      () => persistPreferences(preferences),
      () => persistPreferences(preferences)
    );
    return preferenceWriteQueue;
  });
  // updates:get-state — 读取最近一次更新检查结果（未检查时返回初始状态），更新卡片调用。
  trustedHandle("updates:get-state", () => latestUpdateCheck ?? idleUpdateState());
  // updates:check — 手动触发一次更新检查，设置页"检查更新"按钮调用。
  trustedHandle("updates:check", () => runMacUpdateCheck());
  // updates:open-download — 打开官网下载页；下载地址必须再次通过 allow-list HTTPS 校验，
  // 更新从不静默安装，只跳转官方稳定链接。
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
  // licensing:get-status — 查询授权状态（refresh=true 强制走一次远程验证），授权页/付费墙调用。
  trustedHandle("licensing:get-status", (_event, refresh = false) => getLicenseStatus({ refresh }));
  // licensing:activate — 用激活码激活（走 HTTPS 验证服务），激活对话框调用。
  trustedHandle("licensing:activate", (_event, licenseKey) => activateLicense(licenseKey));
  // licensing:deactivate — 停用本机授权（删除密钥并保留设备标识），授权管理页调用。
  trustedHandle("licensing:deactivate", () => deactivateLicense());
  // licensing:open-checkout — 打开购买页（系统浏览器），付费墙"购买"按钮调用。
  trustedHandle("licensing:open-checkout", async () => {
    await shell.openExternal(await checkoutUrl());
    return { opened: true };
  });
  // system:get-permissions — 查询系统麦克风/屏幕权限状态（按平台返回差异字段），
  // 首次运行授权向导调用。
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
  // system:request-microphone — 仅在 macOS 主动申请麦克风权限（其余平台由系统在录制时弹出）。
  trustedHandle("system:request-microphone", async () => {
    if (process.platform === "darwin") await systemPreferences.askForMediaAccess("microphone");
    return process.platform === "darwin" || process.platform === "win32"
      ? systemPreferences.getMediaAccessStatus("microphone")
      : "unknown";
  });
  // system:open-settings — 跳转到系统设置的对应隐私面板，权限被拒后的引导入口调用。
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
  // window:toggle-mini — 切换迷你悬浮条模式（置顶小窗），录音工具栏调用；状态变化经 window:mini-changed 广播。
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
  // 音频播放协议处理器：手动实现 Range 响应，保证 Chromium 可以渐进加载、拖动时间轴；
  // 直接把 Range 转给 file:// 在部分 Electron 版本会得到不可播放的空响应。
  protocol.handle("minuteflow-media", async (request) => {
    const id = new URL(request.url).pathname.split("/").filter(Boolean).pop();
    if (!id || !UUID_PATTERN.test(id)) return new Response("Not found", { status: 404 });
    const asset = loadAudioAsset(id);
    if (!asset) return new Response("Not found", { status: 404 });
    const filePath = asset.playbackPath || asset.path;
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size <= 0) return new Response("Not found", { status: 404 });
    const rangeHeader = request.headers.get("range");
    const range = parseByteRange(rangeHeader, fileStat.size);
    if (rangeHeader && range === undefined) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${fileStat.size}` } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? fileStat.size - 1;
    const headers = {
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Content-Type": audioContentType(filePath),
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${fileStat.size}` } : {})
    };
    if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    const stream = Readable.toWeb(createReadStream(filePath, { start, end }));
    return new Response(stream, { status: range ? 206 : 200, headers });
  });
  configurePermissions();
  registerIpc();
  // 启动即修复上次异常退出遗留的状态：录音中的会议标记 interrupted，
  // 进行中的导入任务复位为 queued 待重试。
  markInterruptedRecordings();
  markRunningJobsInterrupted();
  // 导入队列的任务状态变化经 imports:job-updated 推送给渲染层（后台执行，不抢焦点）。
  configureImportQueue({
    notify: (job) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("imports:job-updated", job);
    },
    notifyMeeting: (meeting) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("imports:meeting-updated", meeting);
    }
  });
  // 按保留策略清理过期音频；失败只记日志，不阻塞启动。
  await pruneExpiredRecordings().catch((error) => {
    console.error("录音保留策略清理失败：", error);
  });
  await createMainWindow();
  // 主窗口就绪后立即唤醒导入队列（含因缺模型/组件而暂停等待的任务）。
  wakeImportQueue();

  // 打包后的 macOS 版本在启动 5 秒后静默检查一次更新；仅提醒，从不自动安装。
  if (process.platform === "darwin" && app.isPackaged) {
    setTimeout(() => runMacUpdateCheck({ notify: true }), 5_000);
  }

  // 系统休眠/唤醒事件转发给渲染层，便于暂停录音与恢复界面状态。
  powerMonitor.on("suspend", () => mainWindow?.webContents.send("system:suspend"));
  powerMonitor.on("resume", () => mainWindow?.webContents.send("system:resume"));

  // macOS 点击 dock 图标且无窗口时重建主窗口（平台惯例）。
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// 非 macOS 平台关闭所有窗口即退出应用（平台惯例）。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let isQuitting = false;
// 退出前冲刷录音写队列并落盘密钥库，保证最后一块音频不丢、密钥不悬在 .tmp 中。
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
