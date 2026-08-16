/**
 * 后端桥接层：按运行环境切换 MeetingAPI 的真实实现。
 * Electron 中 preload 已把 IPC 代理挂到 window.meetingAPI，直接使用（本地磁盘/主进程能力）；
 * 纯浏览器/演示模式下回落到下面的 browserApi——用 localStorage 持久化会议/档案/偏好，
 * 转写与总结返回占位结果，仅供 UI 预览，不产生真实模型调用。
 *
 * 所属层：渲染层桥接（环境探测 + 浏览器兜底实现）。
 * 主要导出：api（当前生效的 MeetingAPI 实例）、isElectronRuntime（是否 Electron 环境）。
 */
import { demoMeetings } from "../data/demo";
import type { CreateMeetingInput, ImportCandidate, ImportJob, Meeting, MeetingAPI, MeetingPreferences, MeetingSummary, ModelProfile } from "../types";

// —— 浏览器兜底实现的 localStorage 键位与内存事件总线 ——
const storageKey = "meeting-assistant-demo-state-v3";
const profileKey = "meeting-assistant-demo-profiles-v1";
const preferencesKey = "meeting-assistant-demo-preferences-v1";
const importJobsKey = "meeting-assistant-demo-import-jobs-v1";
// 浏览器端没有主进程推送，用内存监听器集合模拟 imports.onJobUpdated 事件流。
const importListeners = new Set<(job: ImportJob) => void>();
const defaultPreferences: MeetingPreferences = {
  summaryIntervalSeconds: 120,
  defaultMode: "online",
  glossary: [],
  retentionDays: null,
  onboardingCompleted: false,
  systemPermissionsCompleted: false,
  permissionsVersion: 0
};

// 深拷贝：把演示数据克隆后再返回，避免调用方修改直接污染模块内的 demoMeetings 常量。
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 读取 localStorage 中的会议列表；首次访问时写入演示数据，损坏时回落到演示数据。 */
function loadBrowserMeetings(): Meeting[] {
  const stored = localStorage.getItem(storageKey);
  if (!stored) {
    localStorage.setItem(storageKey, JSON.stringify(demoMeetings));
    return clone(demoMeetings);
  }
  try {
    return JSON.parse(stored) as Meeting[];
  } catch {
    return clone(demoMeetings);
  }
}

/** 把会议列表整体写回 localStorage（浏览器端的“持久化”）。 */
function saveBrowserMeetings(meetings: Meeting[]) {
  localStorage.setItem(storageKey, JSON.stringify(meetings));
}

/** 把浏览器 File 转成导入候选描述（浏览器端无法读绝对路径，用文件名代替 sourcePath）。 */
const describeBrowserFiles = (files: File[]): ImportCandidate[] => files.map((file) => {
  const extension = file.name.split(".").pop()?.toUpperCase() || "AUDIO";
  return {
    sourcePath: file.name,
    name: file.name,
    title: file.name.replace(/\.[^.]+$/, ""),
    extension,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    lastModifiedAt: new Date(file.lastModified).toISOString()
  };
});

function loadBrowserImportJobs(): ImportJob[] {
  return JSON.parse(localStorage.getItem(importJobsKey) || "[]") as ImportJob[];
}

/** 保存一个导入任务：按 id 去重后写回 localStorage，并同步广播给所有 onJobUpdated 监听器。 */
function saveBrowserImportJob(job: ImportJob) {
  const jobs = [job, ...loadBrowserImportJobs().filter((item) => item.id !== job.id)];
  localStorage.setItem(importJobsKey, JSON.stringify(jobs));
  importListeners.forEach((listener) => listener(job));
}

/** 浏览器端的“伪 AI 总结”：取最近 6 条转写追加进要点（去重、截尾 8 条），仅用于演示 UI。 */
function localSummary(input: {
  goals: string[];
  notes: string[];
  transcript: Meeting["transcript"];
  previousSummary: MeetingSummary;
}): MeetingSummary {
  const recent = input.transcript.slice(-6);
  return {
    ...input.previousSummary,
    topics: input.previousSummary.topics.length ? input.previousSummary.topics : input.goals.slice(0, 3),
    keyPoints: Array.from(new Set([
      ...input.previousSummary.keyPoints,
      ...recent.map((item) => item.text)
    ])).slice(-8),
    updatedAt: new Date().toISOString(),
    stale: false
  };
}

/**
 * 浏览器/演示模式的 MeetingAPI 兜底实现：接口签名与 Electron preload 桥完全一致。
 * 数据落在 localStorage；文件/录音/下载等本地能力要么用 <input> 模拟，要么直接抛出引导用户回到桌面端。
 */
const browserApi: MeetingAPI = {
  meetings: {
    async list(query = "", includeDeleted = false) {
      const normalized = query.trim().toLowerCase();
      // 搜索范围：标题、笔记（含 Markdown 源）、目标、标签与全部转写文本，拼接后做大小写不敏感匹配。
      return loadBrowserMeetings().filter((meeting) => {
        if (!includeDeleted && meeting.deletedAt) return false;
        if (!normalized) return true;
        return [
          meeting.title,
          meeting.notesMarkdown || "",
          ...meeting.notes,
          ...meeting.goals,
          ...meeting.tags,
          ...meeting.transcript.map((item) => item.text)
        ].join(" ").toLowerCase().includes(normalized);
      });
    },
    async get(id) {
      return loadBrowserMeetings().find((meeting) => meeting.id === id) ?? null;
    },
    async create(input: CreateMeetingInput) {
      const meeting: Meeting = {
        id: crypto.randomUUID(),
        title: input.title || "未命名会议",
        scheduledAt: input.scheduledAt || new Date().toISOString(),
        durationSeconds: 0,
        status: "draft",
        mode: input.mode,
        favorite: false,
        participants: input.participants,
        tags: input.tags ?? [],
        goals: input.goals,
        notes: [],
        notesMarkdown: "",
        summary: {
          topics: [], keyPoints: [], decisions: [], actionItems: [],
          openQuestions: [], risks: [], nextSteps: [], stale: false
        },
        transcript: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      saveBrowserMeetings([meeting, ...loadBrowserMeetings()]);
      return meeting;
    },
    async save(meeting) {
      const meetings = loadBrowserMeetings();
      const next = meetings.some((item) => item.id === meeting.id)
        ? meetings.map((item) => item.id === meeting.id ? meeting : item)
        : [meeting, ...meetings];
      saveBrowserMeetings(next);
      return meeting;
    },
    async delete(id) {
      const meetings = loadBrowserMeetings().map((meeting) =>
        meeting.id === id ? { ...meeting, deletedAt: new Date().toISOString() } : meeting);
      saveBrowserMeetings(meetings);
      return true;
    },
    async restore(id) {
      const meetings = loadBrowserMeetings();
      const meeting = meetings.find((item) => item.id === id);
      if (!meeting) throw new Error("会议不存在");
      const restored = { ...meeting, deletedAt: undefined };
      saveBrowserMeetings(meetings.map((item) => item.id === id ? restored : item));
      return restored;
    }
  },
  recordings: {
    // 浏览器端没有主进程会话，仅返回占位会话 id；append/stop 全部直接成功，stop 无产物文件。
    async start() {
      return { sessionId: crypto.randomUUID(), startedAt: Date.now() };
    },
    async append() {
      return { ok: true };
    },
    async stop() {
      return {};
    },
    async abort() {
      return { ok: true };
    },
    async open() {
      throw new Error("浏览器预览无法打开本地录音。");
    },
    async assets() { return []; }
  },
  transcription: {
    // 模拟 700ms 转写延迟后返回占位段落：本地麦克风轨记为“我”，其余记为远端发言人。
    async processChunk(payload) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        id: crypto.randomUUID(),
        startMs: payload.startMs,
        endMs: payload.endMs,
        speakerId: payload.track === "microphone" ? "me" : "remote",
        speakerName: payload.track === "microphone" ? "我" : "远端发言人",
        text: "浏览器预览未连接转录模型，Electron 运行时会处理真实音频。",
        status: "final",
        track: payload.track
      };
    }
  },
  summary: {
    // 模拟 900ms 生成延迟后返回本地拼装的伪纪要。
    async generate(payload) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return localSummary(payload.input);
    }
  },
  models: {
    // 档案读写同样落在 localStorage；test 仅模拟 500ms 后返回成功。
    async list() {
      return JSON.parse(localStorage.getItem(profileKey) || "[]") as ModelProfile[];
    },
    async save(profile) {
      const profiles = JSON.parse(localStorage.getItem(profileKey) || "[]") as ModelProfile[];
      const saved = { ...profile, id: profile.id || crypto.randomUUID() };
      const next = profiles.some((item) => item.id === saved.id)
        ? profiles.map((item) => item.id === saved.id ? saved : item)
        : [...profiles, saved];
      localStorage.setItem(profileKey, JSON.stringify(next));
      return saved;
    },
    async test() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ok: true, message: "浏览器预览配置有效；Electron 中会发起真实连接测试。" };
    },
    async deleteSecret() {},
    async scanLocal() {
      return { models: [], runtimes: {} };
    },
    async chooseLocal() {
      return null;
    },
    async catalog() {
      // 目录只展示一条 GGML 示例；真实下载必须回到 Electron 桌面端。
      return [
        {
          id: "ggml-base",
          name: "Whisper Base（GGML）",
          description: "速度优先，适合普通办公电脑。",
          engine: "whisper-cpp" as const,
          format: "GGML",
          sizeBytes: 148_000_000,
          fileName: "ggml-base.bin",
          source: "ggerganov/whisper.cpp",
          license: "MIT",
          installed: false
        }
      ];
    },
    async download() {
      throw new Error("请在 Electron 桌面应用中下载本地模型。");
    },
    onDownloadProgress() { return () => {}; }
  },
  notes: {
    // 浏览器没有系统文件对话框，用隐藏 <input type="file"> 模拟 Markdown 导入。
    async importMarkdown() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".md,.markdown,.mdown,.txt,text/markdown,text/plain";
        input.addEventListener("change", async () => {
          const file = input.files?.[0];
          resolve(file ? { filePath: file.name, content: await file.text() } : null);
        }, { once: true });
        input.click();
      });
    }
  },
  imports: {
    // 同样用 <input multiple> 模拟系统文件选择器。
    async choose() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = ".mp3,.m4a,.wav,.flac,.ogg,.webm,.mp4,.mov,audio/*,video/mp4,video/quicktime";
        input.addEventListener("change", () => resolve(describeBrowserFiles(Array.from(input.files || []))), { once: true });
        input.click();
      });
    },
    async fromDropped(files) {
      return describeBrowserFiles(files);
    },
    async enqueue(items, options) {
      const now = new Date().toISOString();
      // 入队即归档：浏览器端没有后台 Worker，直接为每个候选创建占位会议与任务记录；
      // 未选转写档案时任务停在 waiting_for_model，与桌面端的可恢复等待语义保持一致。
      const meetings = loadBrowserMeetings();
      const jobs = items.map((item): ImportJob => {
        const meetingId = crypto.randomUUID();
        meetings.unshift({
          id: meetingId, title: item.title, scheduledAt: now, durationSeconds: 0,
          status: "draft", mode: "offline", favorite: false, participants: ["待识别"],
          tags: ["导入"], goals: ["转录并整理导入的录音"], notes: [`已归档：${item.name}`],
          notesMarkdown: `已归档：${item.name}`, transcript: [], createdAt: now, updatedAt: now,
          summary: { topics: [], keyPoints: [], decisions: [], actionItems: [], openQuestions: [], risks: [], nextSteps: [], stale: false }
        });
        return {
          id: crypto.randomUUID(), meetingId, type: "import", title: item.title, sourceName: item.name,
          status: options.sttProfileId ? "queued" : "waiting_for_model", stage: options.sttProfileId ? "copying" : "transcribing",
          progress: options.sttProfileId ? 0.08 : 0.2, language: options.language || "auto",
          sttProfileId: options.sttProfileId, llmProfileId: options.llmProfileId,
          diarizationEnabled: options.diarizationEnabled !== false, autoSummarize: options.autoSummarize !== false,
          createdAt: now, updatedAt: now
        };
      });
      saveBrowserMeetings(meetings);
      jobs.forEach(saveBrowserImportJob);
      return jobs;
    },
    async list() { return loadBrowserImportJobs(); },
    async retry(id) {
      const current = loadBrowserImportJobs().find((job) => job.id === id);
      if (!current) throw new Error("导入任务不存在。");
      const job = { ...current, status: "queued" as const, error: undefined, updatedAt: new Date().toISOString() };
      saveBrowserImportJob(job);
      return job;
    },
    async cancel(id) {
      const current = loadBrowserImportJobs().find((job) => job.id === id);
      if (!current) throw new Error("导入任务不存在。");
      const job = { ...current, status: "cancelled" as const, updatedAt: new Date().toISOString() };
      saveBrowserImportJob(job);
      return job;
    },
    onJobUpdated(callback) {
      importListeners.add(callback);
      return () => importListeners.delete(callback);
    }
  },
  exports: {
    // 无系统保存框，用 Blob + <a download> 触发浏览器下载。
    async save(meeting, format) {
      const content = format === "json"
        ? JSON.stringify(meeting, null, 2)
        : `# ${meeting.title}\n\n${meeting.summary.keyPoints.map((item) => `- ${item}`).join("\n")}`;
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${meeting.title}.${format === "json" ? "json" : "md"}`;
      link.click();
      URL.revokeObjectURL(url);
      return { canceled: false, filePath: link.download };
    }
  },
  preferences: {
    async get() {
      return JSON.parse(localStorage.getItem(preferencesKey) || JSON.stringify(defaultPreferences));
    },
    async save(preferences) {
      localStorage.setItem(preferencesKey, JSON.stringify(preferences));
      return preferences;
    }
  },
  licensing: {
    // ?preview=desktop 的本地预览视为已授权，方便完整走通付费功能；正式激活必须回到桌面端。
    async getStatus() {
      const previewLicensed = new URLSearchParams(window.location.search).get("preview") === "desktop";
      return {
        state: previewLicensed ? "licensed" as const : "unlicensed" as const,
        productId: "minuteflow-desktop",
        offline: false,
        verificationConfigured: false,
        checkoutConfigured: false,
        insecureStorage: false
      };
    },
    async activate() {
      throw new Error("请在 MinuteFlow 桌面应用中激活授权。");
    },
    async deactivate() {
      return {
        state: "unlicensed" as const,
        productId: "minuteflow-desktop",
        offline: false,
        verificationConfigured: false,
        checkoutConfigured: false,
        insecureStorage: false
      };
    },
    async openCheckout() {
      window.open("https://vibeforge2014.github.io/minuteflow/pricing/", "_blank", "noopener,noreferrer");
      return { opened: true as const };
    }
  },
  updates: {
    // 浏览器端不支持应用内更新，仅提供跳转官网下载页。
    async getState() {
      return {
        status: "unsupported",
        currentVersion: "0.1.3",
        checkedAt: "",
        message: "请在 macOS 桌面应用中检查更新。"
      };
    },
    async check() {
      return {
        status: "unsupported",
        currentVersion: "0.1.3",
        checkedAt: new Date().toISOString(),
        message: "请在 macOS 桌面应用中检查更新。"
      };
    },
    async openDownload() {
      window.open("https://vibeforge2014.github.io/minuteflow/downloads/macos/latest/", "_blank", "noopener,noreferrer");
      return { opened: true } as const;
    },
    onAvailable() { return () => {}; }
  },
  system: {
    // 浏览器端伪装权限已授予、无睡眠事件，保证 UI 流程可预览。
    platform: "web",
    async getPermissions() { return { microphone: "granted", screen: "granted", systemAudioRequired: false, systemAudioPickerHint: false }; },
    async requestMicrophone() { return "granted"; },
    async openSettings() {},
    onSuspend() { return () => {}; },
    onResume() { return () => {}; }
  },
  window: {
    async toggleMini() { return false; },
    onMiniChanged() { return () => {}; }
  }
};

// 环境切换点：Electron 下 window.meetingAPI（preload 注入的 IPC 桥）存在则优先使用，否则用浏览器兜底。
export const api = window.meetingAPI ?? browserApi;
// 是否运行在 Electron 桌面端（决定 main.tsx 渲染桌面工作台还是官网）。
export const isElectronRuntime = Boolean(window.meetingAPI);
