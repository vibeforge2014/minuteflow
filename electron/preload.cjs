const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("meetingAPI", {
  meetings: {
    list: (query = "", includeDeleted = false) => invoke("meetings:list", query, includeDeleted),
    get: (id) => invoke("meetings:get", id),
    create: (input) => invoke("meetings:create", input),
    save: (meeting) => invoke("meetings:save", meeting),
    delete: (id) => invoke("meetings:delete", id),
    restore: (id) => invoke("meetings:restore", id)
  },
  recordings: {
    start: (meetingId) => invoke("recordings:start", meetingId),
    append: (payload) => invoke("recordings:append", payload),
    stop: (payload) => invoke("recordings:stop", payload),
    abort: (payload) => invoke("recordings:abort", payload)
  },
  transcription: {
    processChunk: (payload) => invoke("transcription:chunk", payload)
  },
  summary: {
    generate: (payload) => invoke("summary:generate", payload)
  },
  models: {
    list: () => invoke("models:list"),
    save: (profile, apiKey) => invoke("models:save", profile, apiKey),
    test: (profile, apiKey) => invoke("models:test", profile, apiKey),
    deleteSecret: (secretId) => invoke("models:delete-secret", secretId),
    scanLocal: () => invoke("models:scan-local"),
    chooseLocal: () => invoke("models:choose-local"),
    catalog: () => invoke("models:catalog"),
    download: (modelId) => invoke("models:download", modelId),
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
    process: (payload) => invoke("imports:process", payload)
  },
  exports: {
    save: (meeting, format) => invoke("exports:save", meeting, format)
  },
  preferences: {
    get: () => invoke("preferences:get"),
    save: (preferences) => invoke("preferences:save", preferences)
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
    openSettings: () => invoke("system:open-settings"),
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
