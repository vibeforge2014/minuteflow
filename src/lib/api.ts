import { demoMeetings } from "../data/demo";
import type { CreateMeetingInput, Meeting, MeetingAPI, MeetingPreferences, MeetingSummary, ModelProfile } from "../types";

const storageKey = "meeting-assistant-demo-state-v3";
const profileKey = "meeting-assistant-demo-profiles-v1";
const preferencesKey = "meeting-assistant-demo-preferences-v1";
const defaultPreferences: MeetingPreferences = {
  summaryIntervalSeconds: 120,
  defaultMode: "online",
  glossary: [],
  retentionDays: null,
  onboardingCompleted: false,
  systemPermissionsCompleted: false,
  permissionsVersion: 0
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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

function saveBrowserMeetings(meetings: Meeting[]) {
  localStorage.setItem(storageKey, JSON.stringify(meetings));
}

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

const browserApi: MeetingAPI = {
  meetings: {
    async list(query = "", includeDeleted = false) {
      const normalized = query.trim().toLowerCase();
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
    }
  },
  transcription: {
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
    async generate(payload) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return localSummary(payload.input);
    }
  },
  models: {
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
        },
        {
          id: "pt-small",
          name: "Whisper Small（PyTorch）",
          description: "支持 OpenAI Whisper .pt 权重。",
          engine: "whisper-python" as const,
          format: "PyTorch PT",
          sizeBytes: 461_000_000,
          fileName: "small.pt",
          source: "openai/whisper",
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
    async choose() {
      return [];
    },
    async process() {
      throw new Error("浏览器预览无法读取本地录音，请在 Electron 应用中导入。");
    }
  },
  exports: {
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
    async getStatus() {
      return {
        state: "unlicensed" as const,
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

export const api = window.meetingAPI ?? browserApi;
export const isElectronRuntime = Boolean(window.meetingAPI);
