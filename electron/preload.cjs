const { contextBridge, ipcRenderer, webUtils } = require("electron");

// ipcRenderer.invoke 会把主进程抛出的错误包装成 "Error invoking remote method 'x': <原因>"，
// 渲染层（尤其设置页的错误反馈）只需要真实原因，这里统一剥掉包装。
const invoke = async (channel, ...args) => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ""));
  }
};

contextBridge.exposeInMainWorld("meetingAPI", {
  meetings: {
    list: (query = "", includeDeleted = false) => invoke("meetings:list", query, includeDeleted),
    get: (id) => invoke("meetings:get", id),
    create: (input) => invoke("meetings:create", input),
    save: (meeting) => invoke("meetings:save", meeting),
    delete: (id) => invoke("meetings:delete", id),
    restore: (id) => invoke("meetings:restore", id)
  },
  voiceprints: {
    list: () => invoke("voiceprints:list"),
    enroll: (payload) => invoke("voiceprints:enroll", payload),
    rename: (fromName, toName) => invoke("voiceprints:rename", fromName, toName),
    forget: (name) => invoke("voiceprints:forget", name)
  },
  recordings: {
    start: (meetingId) => invoke("recordings:start", meetingId),
    append: (payload) => invoke("recordings:append", payload),
    stop: (payload) => invoke("recordings:stop", payload),
    abort: (payload) => invoke("recordings:abort", payload),
    open: (meetingId) => invoke("recordings:open", meetingId),
    assets: (meetingId) => invoke("recordings:assets", meetingId),
    onWriteError: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("recordings:write-error", listener);
      return () => ipcRenderer.removeListener("recordings:write-error", listener);
    }
  },
  transcription: {
    processChunk: (payload) => invoke("transcription:chunk", payload)
  },
  summary: {
    generate: (payload) => invoke("summary:generate", payload),
    generateVisual: (payload) => invoke("summary:generate-visual", payload),
    cancel: (meetingId) => invoke("summary:cancel", meetingId)
  },
  chat: {
    // 流式问答：传入 onDelta 时生成 streamId 并订阅 chat:delta 增量（按 id 过滤），
    // invoke 结束（成功/失败）后注销监听；不传 onDelta 则保持一次性返回。
    send: (question, history, context, onDelta) => {
      if (typeof onDelta !== "function") {
        return invoke("chat:send", { question, history, context });
      }
      const streamId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
        ? globalThis.crypto.randomUUID()
        : `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const listener = (_event, payload) => {
        if (payload?.id === streamId) onDelta({ content: payload.content, reasoning: payload.reasoning });
      };
      ipcRenderer.on("chat:delta", listener);
      return invoke("chat:send", { streamId, question, history, context })
        .finally(() => ipcRenderer.removeListener("chat:delta", listener));
    }
  },
  models: {
    list: () => invoke("models:list"),
    save: (profile, apiKey) => invoke("models:save", profile, apiKey),
    test: (profile, apiKey) => invoke("models:test", profile, apiKey),
    listModels: (profile, apiKey) => invoke("models:list-models", profile, apiKey),
    deleteSecret: (secretId) => invoke("models:delete-secret", secretId),
    scanLocal: () => invoke("models:scan-local"),
    scanDiarization: () => invoke("models:scan-diarization"),
    chooseLocal: (kind) => invoke("models:choose-local", kind),
    catalog: () => invoke("models:catalog"),
    download: (modelId) => invoke("models:download", modelId),
    downloadFromUrl: (url) => invoke("models:download-url", url),
    onDownloadProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on("models:download-progress", listener);
      return () => ipcRenderer.removeListener("models:download-progress", listener);
    }
  },
  notes: {
    importMarkdown: () => invoke("notes:import-markdown")
  },
  imports: {
    choose: () => invoke("imports:choose"),
    fromDropped: (files) => invoke("imports:describe-dropped", Array.from(files, (file) => webUtils.getPathForFile(file))),
    enqueue: (items, options) => invoke("imports:enqueue", items, options),
    list: () => invoke("imports:list"),
    retry: (id) => invoke("imports:retry", id),
    cancel: (id) => invoke("imports:cancel", id),
    remove: (id) => invoke("imports:remove", id),
    onJobUpdated: (callback) => {
      const listener = (_event, job) => callback(job);
      ipcRenderer.on("imports:job-updated", listener);
      return () => ipcRenderer.removeListener("imports:job-updated", listener);
    },
    onMeetingUpdated: (callback) => {
      const listener = (_event, meeting) => callback(meeting);
      ipcRenderer.on("imports:meeting-updated", listener);
      return () => ipcRenderer.removeListener("imports:meeting-updated", listener);
    }
  },
  exports: {
    save: (meeting, format) => invoke("exports:save", meeting, format)
  },
  preferences: {
    get: () => invoke("preferences:get"),
    save: (preferences) => invoke("preferences:save", preferences)
  },
  licensing: {
    getStatus: (refresh = false) => invoke("licensing:get-status", refresh),
    activate: (licenseKey) => invoke("licensing:activate", licenseKey),
    deactivate: () => invoke("licensing:deactivate"),
    openCheckout: () => invoke("licensing:open-checkout"),
    openRecover: () => invoke("licensing:open-recover")
  },
  updates: {
    getState: () => invoke("updates:get-state"),
    check: () => invoke("updates:check"),
    openDownload: () => invoke("updates:open-download"),
    onAvailable: (callback) => {
      const listener = (_event, result) => callback(result);
      ipcRenderer.on("updates:available", listener);
      return () => ipcRenderer.removeListener("updates:available", listener);
    }
  },
  system: {
    platform: process.platform,
    getPermissions: () => invoke("system:get-permissions"),
    requestMicrophone: () => invoke("system:request-microphone"),
    openSettings: (kind = "microphone") => invoke("system:open-settings", kind),
    startAppDrag: () => ipcRenderer.send("system:start-app-drag"),
    revealApplication: () => invoke("system:reveal-application"),
    relaunchForPermissionSetup: () => invoke("system:relaunch-for-permission-setup"),
    closePermissionHelper: () => ipcRenderer.send("system:close-permission-helper"),
    onSuspend: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("system:suspend", listener);
      return () => ipcRenderer.removeListener("system:suspend", listener);
    },
    onResume: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("system:resume", listener);
      return () => ipcRenderer.removeListener("system:resume", listener);
    }
  },
  window: {
    toggleMini: (enabled) => invoke("window:toggle-mini", enabled),
    onMiniChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled);
      ipcRenderer.on("window:mini-changed", listener);
      return () => ipcRenderer.removeListener("window:mini-changed", listener);
    }
  }
});
