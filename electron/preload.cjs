const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
  voiceprints: {
    list: () => invoke("voiceprints:list"),
    enroll: (payload) => invoke("voiceprints:enroll", payload),
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
  models: {
    list: () => invoke("models:list"),
    save: (profile, apiKey) => invoke("models:save", profile, apiKey),
    test: (profile, apiKey) => invoke("models:test", profile, apiKey),
    deleteSecret: (secretId) => invoke("models:delete-secret", secretId),
    scanLocal: () => invoke("models:scan-local"),
    chooseLocal: () => invoke("models:choose-local"),
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
    openCheckout: () => invoke("licensing:open-checkout")
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
