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
import type { CreateMeetingInput, DownloadableModel, ImportCandidate, ImportJob, Meeting, MeetingAPI, MeetingPreferences, MeetingSummary, ModelProfile } from "../types";
import { simplifyChinese, simplifySummary } from "./chinese";

// —— 浏览器兜底实现的 localStorage 键位与内存事件总线 ——
const storageKey = "meeting-assistant-demo-state-v3";
const profileKey = "meeting-assistant-demo-profiles-v1";
const preferencesKey = "meeting-assistant-demo-preferences-v1";
const importJobsKey = "meeting-assistant-demo-import-jobs-v1";
// 浏览器端没有主进程推送，用内存监听器集合模拟 imports.onJobUpdated 事件流。
const importListeners = new Set<(job: ImportJob) => void>();
const defaultPreferences: MeetingPreferences = {
  summaryIntervalSeconds: 60,
  summaryCadenceVersion: 1,
  defaultMode: "online",
  glossary: [],
  retentionDays: null,
  onboardingCompleted: false,
  systemPermissionsCompleted: false,
  permissionsVersion: 0,
  modelDownloadSourceKind: "official",
  modelDownloadCustomBase: ""
};

/**
 * 浏览器预览与桌面端保持相同的模型目录；预览只展示，真实下载由 Electron 主进程执行。
 * 三组：multilingual 多语言推荐 / quantized 轻量量化 / english 英文专用（体积与桌面端 catalog 一致）。
 */
const browserModelCatalog: DownloadableModel[] = [
  ["ggml-tiny", "Whisper Tiny（GGML）", "最快、占用最低，适合快速草稿和低配置设备。", 77_691_713, "ggml-tiny.bin", "multilingual"],
  ["ggml-base", "Whisper Base（GGML）", "轻量日常转写，速度和准确率优于 Tiny。", 147_951_465, "ggml-base.bin", "multilingual"],
  ["ggml-small", "Whisper Small（GGML）", "中英混合表现均衡，推荐大多数会议使用。", 487_601_967, "ggml-small.bin", "multilingual"],
  ["ggml-medium", "Whisper Medium（GGML）", "更重视中文和复杂音频准确率，推荐 16GB 内存。", 1_533_763_059, "ggml-medium.bin", "multilingual"],
  ["ggml-large-v3-turbo-q5_0", "Whisper Large v3 Turbo Q5（GGML）", "Turbo 的 5-bit 量化版，约 0.55GB，中低配设备的准确率优选。", 574_041_195, "ggml-large-v3-turbo-q5_0.bin", "multilingual"],
  ["ggml-large-v3-turbo", "Whisper Large v3 Turbo（GGML）", "高准确率与速度兼顾，适合性能较好的新款电脑。", 1_624_555_275, "ggml-large-v3-turbo.bin", "multilingual"],
  ["ggml-large-v3", "Whisper Large v3（GGML）", "最高准确率，下载和运行占用较高，推荐 24GB 以上内存。", 3_095_033_483, "ggml-large-v3.bin", "multilingual"],
  ["ggml-medium-q5_0", "Whisper Medium Q5（GGML）", "Medium 的 5-bit 量化版，约 0.52GB，存储紧张时的中文优选。", 539_212_467, "ggml-medium-q5_0.bin", "quantized"],
  ["ggml-medium-q8_0", "Whisper Medium Q8（GGML）", "Medium 的 8-bit 量化版，约 0.8GB，接近原版准确率。", 823_369_779, "ggml-medium-q8_0.bin", "quantized"],
  ["ggml-large-v3-q5_0", "Whisper Large v3 Q5（GGML）", "Large v3 的 5-bit 量化版，约 1GB，以更小体积获得旗舰准确率。", 1_081_140_203, "ggml-large-v3-q5_0.bin", "quantized"],
  ["ggml-large-v3-turbo-q8_0", "Whisper Large v3 Turbo Q8（GGML）", "Turbo 的 8-bit 量化版，约 0.86GB，速度与准确率更均衡。", 874_188_075, "ggml-large-v3-turbo-q8_0.bin", "quantized"],
  ["ggml-tiny.en", "Whisper Tiny.en（GGML）", "仅英文。占用最低的英文会议速记。", 77_704_715, "ggml-tiny.en.bin", "english"],
  ["ggml-base.en", "Whisper Base.en（GGML）", "仅英文。轻量英文转写，速度和准确率优于 Tiny.en。", 147_964_211, "ggml-base.en.bin", "english"],
  ["ggml-small.en", "Whisper Small.en（GGML）", "仅英文。英文会议的均衡之选。", 487_614_201, "ggml-small.en.bin", "english"],
  ["ggml-medium.en", "Whisper Medium.en（GGML）", "仅英文。复杂英文音频的准确率优选。", 1_533_774_781, "ggml-medium.en.bin", "english"]
].map(([id, name, description, sizeBytes, fileName, group]) => ({
  id: id as string,
  name: name as string,
  description: description as string,
  engine: "whisper-cpp" as const,
  format: "GGML",
  group: group as "multilingual" | "quantized" | "english",
  sizeBytes: sizeBytes as number,
  fileName: fileName as string,
  source: "ggerganov/whisper.cpp",
  license: "MIT",
  installed: false
}));

// 深拷贝：把演示数据克隆后再返回，避免调用方修改直接污染模块内的 demoMeetings 常量。
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 读取 localStorage 中的会议列表；首次访问时写入演示数据，损坏时回落到演示数据。 */
function loadBrowserMeetings(): Meeting[] {
  const stored = localStorage.getItem(storageKey);
  if (!stored) {
    localStorage.setItem(storageKey, JSON.stringify(demoMeetings));
    return clone(demoMeetings).map(normalizeBrowserMeetingAiText);
  }
  try {
    return (JSON.parse(stored) as Meeting[]).map(normalizeBrowserMeetingAiText);
  } catch {
    return clone(demoMeetings).map(normalizeBrowserMeetingAiText);
  }
}

function normalizeBrowserMeetingAiText(meeting: Meeting): Meeting {
  return {
    ...meeting,
    transcript: meeting.transcript.map((segment) => ({ ...segment, text: simplifyChinese(segment.text) })),
    summary: simplifySummary(meeting.summary)
  };
}

/** 把会议列表整体写回 localStorage（浏览器端的“持久化”）。 */
function saveBrowserMeetings(meetings: Meeting[]) {
  localStorage.setItem(storageKey, JSON.stringify(meetings.map(normalizeBrowserMeetingAiText)));
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

/** 浏览器预览中的本机基础纪要：压缩高信息句，避免把右侧转录原样复制到文档。 */
function localSummary(input: {
  goals: string[];
  notes: string[];
  transcript: Meeting["transcript"];
  previousSummary: MeetingSummary;
}): MeetingSummary {
  const candidates = input.transcript
    .flatMap((segment) => segment.text.split(/(?<=[。！？!?])\s*/))
    .map((text) => simplifyChinese(text).replace(/^(嗯+|啊+|呃+|然后|就是|那个)[，,。.!！\s]*/, "").trim())
    .filter((text) => text.length >= 8 && !/[？?]$/.test(text))
    .map((text) => ({
      text,
      score: (text.match(/(确认|决定|结论|完成|进展|方案|问题|结果|计划|建议|需要|风险|负责)/g)?.length ?? 0) * 3 + text.length / 30
    }))
    .sort((left, right) => right.score - left.score);
  const keyPoints: string[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.text.replace(/[\s，。！？、,.!?]/g, "");
    if (keyPoints.some((item) => item.replace(/[\s，。！？、,.!?]/g, "").includes(normalized))) continue;
    keyPoints.push(/^(已|将|需|本次|当前|会议)/.test(candidate.text) ? candidate.text : `会议明确：${candidate.text}`);
    if (keyPoints.length >= 6) break;
  }
  const sourceThroughMs = input.transcript.reduce((maximum, segment) => Math.max(maximum, segment.endMs), 0);
  return simplifySummary({
    ...input.previousSummary,
    topics: input.previousSummary.topics.length ? input.previousSummary.topics : input.goals.slice(0, 3),
    keyPoints: Array.from(new Set(keyPoints)).slice(-8),
    updatedAt: new Date().toISOString(),
    generationMode: "local",
    sourceThroughMs,
    stale: false
  });
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
    async assets() { return []; },
    onWriteError() { return () => {}; }
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
    },
    async cancel() {
      return { ok: true };
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
      return browserModelCatalog;
    },
    async download() {
      throw new Error("请在 Electron 桌面应用中下载本地模型。");
    },
    async downloadFromUrl() {
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
    },
    onMeetingUpdated() { return () => {}; }
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
      const stored = JSON.parse(localStorage.getItem(preferencesKey) || "{}");
      const preferences = {
        ...defaultPreferences,
        ...stored,
        summaryIntervalSeconds: Number(stored.summaryCadenceVersion) >= 1
          ? Number(stored.summaryIntervalSeconds) || 60
          : 60,
        summaryCadenceVersion: 1
      };
      localStorage.setItem(preferencesKey, JSON.stringify(preferences));
      return preferences;
    },
    async save(preferences) {
      const validated = { ...preferences, summaryCadenceVersion: 1 };
      localStorage.setItem(preferencesKey, JSON.stringify(validated));
      return validated;
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
