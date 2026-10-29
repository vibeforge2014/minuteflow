/**
 * 设置工作台：左侧分类导航 + 中栏二级服务目录 + 右侧配置面板。
 * 五个标签页：AI 总结（llm）、转录设置（stt）、通用设置、存储与隐私、软件更新（macOS / Windows）。
 * AI 总结/转录页共用「模型目录 + 档案编辑器」结构：本地（Ollama/本地 Whisper 零路径配置）与
 * 在线服务预设（国内外厂商 + New API 网关）一键预填端点/接口格式/推荐模型，通常只需填密钥。
 * 实际的模型调用与本地运行时解析在 electron/services/providers.mjs 与 local-models.mjs。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  CloudArrowDown,
  Cpu,
  Database,
  DotsThree,
  GearSix,
  DownloadSimple,
  FingerprintSimple,
  FolderOpen,
  HardDrives,
  Info,
  Key,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Waveform,
  X
} from "@phosphor-icons/react";
import { api, isElectronRuntime } from "../lib/api";
import { useMeetingStore } from "../store/meetingStore";
import { ConfirmDialog, useConfirmDialog } from "./ConfirmDialog";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useExitPresence } from "../hooks/useExitPresence";
import {
  describeRuntimeMemory,
  formatHardwareLine,
  formatModelBytes,
  ollamaGuidance,
  ollamaModelFit,
  recommendWhisperModelId,
  WHISPER_MODEL_MIN_RAM_GB,
  whisperModelFit
} from "../lib/model-recommendation";
import type {
  DiarizationScanResult,
  DownloadableModel,
  HardwareInfo,
  LicenseStatus,
  LocalModelFile,
  LocalModelScanResult,
  ModelDownloadProgress,
  ModelProfile,
  AppUpdateCheckResult,
  AppUpdateDownloadProgress,
  VoiceprintPerson
} from "../types";

/** 四种本地 Whisper 运行时（whisper.cpp GGML/GGUF、Python .pt、CT2、MLX）统一呈现为一个「本地 Whisper」。 */
const LOCAL_WHISPER_TRANSPORTS = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"] as const;

/** 已保存档案副标题里的运行时短标注：同名的 ggml-small 档案也能一眼分清是谁在跑。 */
const LOCAL_WHISPER_RUNTIME_LABELS: Partial<Record<string, string>> = {
  "whisper-cpp": "whisper.cpp",
  "whisper-python": "Python",
  "faster-whisper": "CTranslate2",
  "mlx-whisper": "MLX"
};

/** 视觉纪要验证指纹（与主进程 visualSummaryProfileFingerprint 同构）：
 *  传输协议/地址/模型/兼容协议/聊天端点任一变化即视为未验证，保存或测试时需重新验证。 */
const visualFingerprint = (profile: ModelProfile) => JSON.stringify({
  transport: profile.transport,
  baseUrl: (profile.baseUrl || "").trim().replace(/\/+$/, ""),
  model: (profile.model || "").trim(),
  apiFlavor: profile.options.apiFlavor ?? "openai",
  chatEndpoint: profile.options.chatEndpoint ?? ""
});
const isLocalWhisperTransport = (transport: string | undefined) =>
  !!transport && (LOCAL_WHISPER_TRANSPORTS as readonly string[]).includes(transport);
/** 已保存档案的排序：默认档置顶，其余保持名称序。 */
const defaultFirst = (left: ModelProfile, right: ModelProfile) =>
  Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault));
/** 本机转写家族：本地 Whisper 四种运行时与 Apple 系统识别。 */
const isLocalSttProfile = (profile: ModelProfile) =>
  isLocalWhisperTransport(profile.transport) || profile.transport === "apple-speech";
/** 本机总结家族：离线规则纪要与 Ollama。 */
const isLocalLlmProfile = (profile: ModelProfile) =>
  profile.transport === "local-summary" || profile.transport === "ollama";
/** 本机服务：选完即生效，不出现保存底栏（说话人分离也归入本机）。 */
const isLocalServiceProfile = (profile: ModelProfile) =>
  isLocalSttProfile(profile) || profile.transport === "sherpa-onnx" || profile.transport === "local-summary";
/** 档案的服务商标识：按端点/传输匹配预设，名称只作展示——改名不会掉回「自定义配置」。 */
const providerKeyForProfile = (profile: ModelProfile): string => {
  if (isLocalWhisperTransport(profile.transport)) return "whisper";
  if (profile.transport === "apple-speech") return "appleSpeech";
  if (profile.transport === "sherpa-onnx") return "sherpa";
  if (profile.transport === "local-summary") return "localSummary";
  if (profile.transport === "ollama") return "ollama";
  let host = "";
  try {
    host = new URL(profile.baseUrl.trim()).host.toLowerCase();
  } catch {
    // 手填地址尚未成型：保持自定义配置。
  }
  // 草稿没有 id：先按预设名称认回来（Azure 这类占位端点无法从 host 反推）。
  if (!profile.id) {
    const named = Object.entries(providerPresets).find(([, preset]) =>
      preset.name === profile.name && preset.transport === profile.transport && preset.kind === profile.kind
    );
    if (named) return named[0];
  }
  const key = host ? presetHostIndexByKind.get(profile.kind)?.get(host) : undefined;
  return key ?? "";
};
/** 目录副标题里的问题提示：只报需要用户动手的状态，不用正向徽标占位。 */
const profileIssue = (profile: ModelProfile): string | null => {
  if (profile.kind === "diarization") {
    return profile.options.segmentationModelPath && profile.options.embeddingModelPath ? null : "缺少声纹模型";
  }
  if (profile.transport === "apple-speech" || profile.transport === "local-summary" || profile.transport === "ollama") return null;
  if (isLocalWhisperTransport(profile.transport)) return profile.options.modelPath ? null : "缺少本地模型";
  if (!profile.model) return "缺少模型名称";
  if (!profile.secretId) return "缺少 API Key";
  return null;
};
/** 标题旁的本机/在线标签：把「音频是否离开设备」放在第一眼。 */
const describeTransport = (profile: ModelProfile): { text: string; online: boolean } => {
  if (profile.transport === "apple-speech") {
    return profile.options.allowServer === true
      ? { text: "在线 · 音频发送至 Apple", online: true }
      : { text: "本机 · 音频不出设备", online: false };
  }
  if (profile.transport === "sherpa-onnx") return { text: "本机 · 数据不出设备", online: false };
  if (profile.transport === "local-summary") return { text: "本机 · 完全离线", online: false };
  if (isLocalWhisperTransport(profile.transport)) return { text: "本机 · 音频不出设备", online: false };
  if (profile.transport === "ollama") return { text: "本机 · Ollama 服务", online: false };
  return profile.kind === "stt"
    ? { text: "在线 · 音频发送至服务商", online: true }
    : { text: "在线 · 文本发送至服务商", online: true };
};
/** 本地 Whisper 的展示名：去掉 ggml 前缀与扩展名（ggml-small → Small）。 */
const whisperModelLabel = (model: string) => {
  const raw = (model || "")
    .replace(/^ggml[-_]/i, "")
    .replace(/\.(?:pt|bin|gguf)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return raw ? raw.replace(/\b[a-z]/g, (character) => character.toUpperCase()) : "";
};
/** 本机档案的自动名称：不再要求用户为配置起名，同名副本自然消失。 */
const localProfileName = (profile: ModelProfile): string => {
  if (profile.transport === "apple-speech") return "Apple 语音识别";
  if (profile.transport === "sherpa-onnx") return "本地声纹识别";
  if (profile.transport === "local-summary") return "本机基础纪要";
  if (isLocalWhisperTransport(profile.transport)) {
    const label = whisperModelLabel(profile.model);
    return label ? `本地 Whisper · ${label}` : "本地 Whisper";
  }
  return profile.name;
};
/** 新建档案的空白模板（自定义服务从这里开始）。 */
const emptyProfile: ModelProfile = {
  name: "OpenAI 兼容模型",
  kind: "llm",
  transport: "openai-chat",
  baseUrl: "",
  model: "",
  options: { timeoutMs: 60_000 },
  enabled: true
};

/**
 * 服务商预设表：预填官方端点、接口格式（apiFlavor）与推荐模型，用户通常只需输入密钥。
 * Anthropic/Gemini 走原生协议；MiniMax 等特殊端点通过 chatEndpoint 适配；New API 是 OpenAI 兼容网关预设。
 */
const providerPresets: Record<string, Partial<ModelProfile>> = {
  openai: {
    name: "OpenAI",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini"
  },
  anthropic: {
    name: "Anthropic Claude",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    options: { timeoutMs: 60_000, apiFlavor: "anthropic" }
  },
  gemini: {
    name: "Google Gemini",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-3.6-flash",
    options: { timeoutMs: 60_000, apiFlavor: "gemini" }
  },
  azure: {
    name: "Azure OpenAI",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    model: ""
  },
  deepseek: {
    name: "DeepSeek",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  },
  dashscope: {
    name: "通义千问",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus"
  },
  doubao: {
    name: "火山方舟 · 豆包",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260215"
  },
  zhipu: {
    name: "智谱 GLM",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3"
  },
  kimi: {
    name: "Moonshot Kimi",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6"
  },
  minimax: {
    name: "MiniMax",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "minimax-m3",
    options: { timeoutMs: 60_000, chatEndpoint: "text/chatcompletion_v2" }
  },
  siliconflow: {
    name: "SiliconFlow",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Pro/zai-org/GLM-4.7"
  },
  openrouter: {
    name: "OpenRouter",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "~openai/gpt-latest"
  },
  ollama: {
    name: "Ollama",
    kind: "llm",
    transport: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3"
  },
  localSummary: {
    name: "本机基础纪要",
    kind: "llm",
    transport: "local-summary",
    baseUrl: "",
    model: ""
  },
  newApiLlm: {
    name: "New API 大模型",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://YOUR-NEW-API.example/v1",
    model: "gpt-4.1-mini",
    options: { timeoutMs: 60_000, apiFlavor: "openai" }
  },
  whisper: {
    name: "本地 Whisper",
    kind: "stt",
    transport: "whisper-cpp",
    baseUrl: "",
    model: "multilingual-small"
  },
  appleSpeech: {
    name: "Apple 语音识别",
    kind: "stt",
    transport: "apple-speech",
    baseUrl: "",
    model: ""
  },
  openaiWhisper: {
    name: "OpenAI Whisper",
    kind: "stt",
    transport: "openai-audio",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1"
  },
  newApiWhisper: {
    name: "New API 语音转录",
    kind: "stt",
    transport: "openai-audio",
    baseUrl: "https://YOUR-NEW-API.example/v1",
    model: "whisper-1",
    options: {
      // DSM 反向代理等待上游 300 秒；客户端多留 30 秒用于传输与错误响应收尾。
      timeoutMs: 330_000,
      apiFlavor: "openai",
      responseFormat: "json"
    }
  },
  pythonWhisper: {
    name: "本地 Whisper",
    kind: "stt",
    transport: "whisper-python",
    baseUrl: "",
    model: "",
    options: { timeoutMs: 120_000 }
  },
  sherpa: {
    name: "本地声纹识别",
    kind: "diarization",
    transport: "sherpa-onnx",
    baseUrl: "",
    model: "Pyannote + 3D-Speaker"
  }
};

/** LLM 目录的分组展示顺序：国内厂商 → 国际厂商 → 兼容服务。 */
const llmProviderGroups = [
  {
    label: "国内厂商",
    providers: [
      { key: "deepseek", name: "DeepSeek", icon: "DS", description: "推理与通用总结" },
      { key: "dashscope", name: "通义千问", icon: "QW", description: "阿里云百炼" },
      { key: "doubao", name: "豆包", icon: "DB", description: "火山方舟" },
      { key: "zhipu", name: "智谱 GLM", icon: "GL", description: "智谱开放平台" },
      { key: "kimi", name: "Kimi", icon: "KM", description: "Moonshot 开放平台" },
      { key: "minimax", name: "MiniMax", icon: "MM", description: "MiniMax 开放平台" },
      { key: "siliconflow", name: "SiliconFlow", icon: "SF", description: "多模型聚合平台" }
    ]
  },
  {
    label: "国际厂商",
    providers: [
      { key: "openai", name: "OpenAI", icon: "AI", description: "GPT 系列模型" },
      { key: "anthropic", name: "Claude", icon: "CL", description: "Anthropic 原生接口" },
      { key: "gemini", name: "Gemini", icon: "GM", description: "Google AI 原生接口" },
      { key: "azure", name: "Azure OpenAI", icon: "AZ", description: "企业 Azure 部署" },
      { key: "openrouter", name: "OpenRouter", icon: "OR", description: "全球模型聚合平台" }
    ]
  },
  {
    label: "兼容服务",
    providers: [
      { key: "newApiLlm", name: "New API", icon: "NA", description: "自建或聚合模型服务" }
    ]
  }
] as const;

/** 预设的一句话说明（目录聚合进表单后，厂商信息集中展示在下拉下方）。 */
const presetDescribe: Record<string, { text: string; protocol?: string }> = {
  localSummary: { text: "完全离线的规则纪要，不发起任何网络请求", protocol: "本机" },
  ollama: { text: "数据留在本机 · 需要已安装 Ollama 服务", protocol: "本机" },
  whisper: { text: "自动适配 GGML/GGUF、.pt、CT2 与 MLX", protocol: "本机" },
  openaiWhisper: { text: "OpenAI 官方音频接口，无需下载本地模型", protocol: "OpenAI 兼容" },
  newApiWhisper: { text: "自建或中转的 OpenAI 音频兼容接口（New API 等）", protocol: "OpenAI 兼容" },
  sherpa: { text: "多人会议区分发言人 · 数据不出本机", protocol: "内置引擎" },
  azure: { text: "企业 Azure 部署 · 密钥走 api-key 头", protocol: "OpenAI 兼容" },
  newApiLlm: { text: "自建或聚合的大模型服务（New API / one-api 等）", protocol: "OpenAI 兼容" }
};

/** 取预设的说明行：厂商预设沿用 llmProviderGroups 的描述，协议按 apiFlavor 推导。 */
const describePreset = (key: string): { text: string; protocol: string } | null => {
  if (!key) return null;
  const preset = providerPresets[key as keyof typeof providerPresets];
  if (!preset) return null;
  if (presetDescribe[key]) return presetDescribe[key] as { text: string; protocol: string };
  const groupProvider = llmProviderGroups
    .flatMap((group) => group.providers as readonly { key: string; description: string }[])
    .find((provider) => provider.key === key);
  const flavor = preset.options?.apiFlavor;
  return {
    text: groupProvider?.description ?? "",
    protocol: flavor === "anthropic" ? "Anthropic 原生" : flavor === "gemini" ? "Gemini 原生" : "OpenAI 兼容"
  };
};

/** 端点域名 → 预设键索引（按任务类型分桶）：粘贴 Base URL 时识别厂商并建议套用预设。
 *  同一域名（如 api.openai.com）会同时命中总结与转录预设，必须按 kind 取，否则会在
 *  AI 总结页把 OpenAI 总结档案识别成「Whisper 端点」并套用成转录档案。 */
const presetHostIndexByKind = new Map<string, Map<string, string>>();
for (const [key, preset] of Object.entries(providerPresets)) {
  if (!preset.baseUrl || !preset.kind) continue;
  let host: string;
  try {
    host = new URL(preset.baseUrl).host.toLowerCase();
  } catch {
    continue;
  }
  const bucket = presetHostIndexByKind.get(preset.kind) ?? new Map<string, string>();
  bucket.set(host, key);
  presetHostIndexByKind.set(preset.kind, bucket);
}

/** 旧版曾把 New API 误当成协议；编辑/保存时自动迁移为 OpenAI 兼容格式。 */
const normalizeLegacyProviderProfile = (profile: ModelProfile): ModelProfile => profile.options?.apiFlavor === "new-api"
  ? { ...profile, options: { ...profile.options, apiFlavor: "openai" } }
  : profile;

/** 端点、协议或模型变化后旧的视觉 schema 验证不再可信。 */
const invalidateVisualVerification = (options: ModelProfile["options"]): ModelProfile["options"] => ({
  ...options,
  visualSummaryVerifiedAt: undefined,
  visualSummaryVerifiedFingerprint: undefined
});

/** 设置页标签：五个标签页（软件更新仅桌面端展示）。 */
export type SettingsTab = "llm" | "transcription" | "general" | "storage" | "updates";

/** 打开设置时的定位意图：直接把编辑器切到对应表单，而不是让用户自己在目录里找。 */
export type SettingsFocus = "local-whisper" | "online-transcription" | "apple-speech";

type StatusTone = "info" | "success" | "error";

/** 反馈归属：字段一改或切页，旧结果自动失效，不会停在已改过的配置旁边。 */
const profileStatusKey = (tab: SettingsTab, profile: ModelProfile | null) =>
  [tab, profile?.id ?? "new", profile?.name ?? "", profile?.transport ?? "", profile?.baseUrl ?? "", profile?.model ?? ""].join("|");

export function SettingsDialog({ open, initialTab, initialFocus, onClose, licenseStatus, onLicenseStatusChange, recordingActive = false }: { open: boolean; initialTab?: SettingsTab; initialFocus?: SettingsFocus; onClose(): void; licenseStatus: LicenseStatus | null; onLicenseStatusChange(status: LicenseStatus): void; recordingActive?: boolean }) {
  const profiles = useMeetingStore((state) => state.profiles);
  const setProfiles = useMeetingStore((state) => state.setProfiles);
  const preferences = useMeetingStore((state) => state.preferences);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);
  const updatePreferences = useMeetingStore((state) => state.updatePreferences);
  /** 当前设置页。 */
  const [tab, setTab] = useState<SettingsTab>("transcription");
  /** 正在编辑的模型档案（目录选中项或新建草稿）。 */
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  /** 密钥输入框的明文值（保存后只留 secretId 引用，不回显）。 */
  const [apiKey, setApiKey] = useState("");
  /** 测试/保存的结果反馈：带 tone 与归属键，错误不再显示成成功色。 */
  const [status, setStatus] = useState<{ text: string; tone: StatusTone; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 目录「添加服务」展开态；没有已保存档案时强制展开。 */
  const [addOpen, setAddOpen] = useState(false);
  /** 标题区「⋯」菜单（删除档案 / 删除密钥）。 */
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const profileConfirm = useConfirmDialog();
  /** 配置面板“世代”：目录里切换选中服务（预设/已保存/自定义）时 +1，
   *  驱动编辑器面板重放进场过渡；字段编辑不递增，打字不会打断输入。 */
  const [editorGeneration, setEditorGeneration] = useState(0);
  /** 模型下拉：远端列表（随服务地址/协议变化失效）、拉取状态与菜单开合。 */
  const [modelList, setModelList] = useState<string[] | null>(null);
  /** Ollama 模型名 → 磁盘体积（随 modelList 一起失效），按设备内存标注适配建议。 */
  const [modelSizes, setModelSizes] = useState<Record<string, number> | null>(null);
  const [modelListBusy, setModelListBusy] = useState(false);
  const [modelListError, setModelListError] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  /** 已保存列表「设为默认」的行级忙碌态，防止连点。 */
  const [switchBusy, setSwitchBusy] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  /** 应用内下载安装包：进度来自主进程推送，失败原因与「已打开安装程序」共用同一份状态。 */
  const [downloadState, setDownloadState] = useState<AppUpdateDownloadProgress | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  /** 授权卡片：停用的内联二次确认、忙碌态与失败文案（成功即整卡切换状态，无需文案）。 */
  const [deactivateConfirm, setDeactivateConfirm] = useState(false);
  const [deactivateBusy, setDeactivateBusy] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  // macOS 自动更新的显式安装进行中（「立即重启并更新」按钮的忙碌态）。
  // 必须声明在 if (!mounted) return 之前的无条件区：放在其后会让关闭态
  // 与打开态的 hook 数量不一致，触发 React #310 白屏（0.1.33 的线上事故）。
  const [installingUpdate, setInstallingUpdate] = useState(false);
  /** 停用本机授权：先由主进程尽力释放服务端设备绑定，再清除本地密钥；释放失败也会完成本地停用。 */
  const handleDeactivate = async () => {
    setDeactivateBusy(true);
    setLicenseError(null);
    try {
      onLicenseStatusChange(await api.licensing.deactivate());
      setDeactivateConfirm(false);
    } catch (caught) {
      setLicenseError(caught instanceof Error ? caught.message : "停用失败，请稍后再试。");
    } finally {
      setDeactivateBusy(false);
    }
  };
  const handleOpenCheckout = async () => {
    setLicenseError(null);
    try {
      await api.licensing.openCheckout();
    } catch (caught) {
      setLicenseError(caught instanceof Error ? caught.message : "无法打开购买页，请稍后再试。");
    }
  };
  const dialogRef = useDialogFocus<HTMLDivElement>(open, {
    initialFocus: ".settings-nav button.is-active",
    onEscape: onClose
  });
  const { mounted, closing } = useExitPresence(open, 170);
  /** 当前反馈是否仍属于这份配置：字段/页面一变就隐藏，避免旧结果误导。 */
  const statusKey = profileStatusKey(tab, editing);
  const visibleStatus = status && status.key === statusKey ? status : null;
  const pushStatus = (text: string, tone: StatusTone, key = statusKey) => setStatus({ text, tone, key });
  const statusClass = (tone: StatusTone) =>
    `connection-status${tone === "error" ? " is-error" : tone === "info" ? " is-info" : " is-success"}`;
  // 正式桌面端支持 macOS / Windows；开发环境额外显示，便于用 ?preview=desktop 做浏览器视觉验收。
  const showUpdateSettings = api.system.platform === "darwin"
    || api.system.platform === "win32"
    || import.meta.env.DEV;

  // 打开设置时刷新档案列表。
  useEffect(() => {
    if (open) loadProfiles();
  }, [loadProfiles, open]);

  // 本机芯片/内存：本地模型推荐（Whisper 目录与 Ollama 编辑器）共用一份检测结果。
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  useEffect(() => {
    if (!open || hardware) return;
    let active = true;
    api.system.hardware().then((info) => active && setHardware(info)).catch(() => {});
    return () => { active = false; };
  }, [open, hardware]);

  // 重新打开时清掉上一次会话的测试/保存反馈，避免陈旧状态误导。
  useEffect(() => {
    if (open) setStatus(null);
  }, [open]);

  // 指定初始页时（如更新提示 Toast 直达「软件更新」），打开瞬间切到该页。
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // 切到 AI 总结/转录页时，为编辑器选一个初始档案：
  // 默认档优先（与目录置顶一致）；没有已保存档案时保持空态，由「添加服务」引导。
  // 转录页还承载说话人分离档案（diarization），已在编辑时不要用 stt 档案把它顶掉。
  useEffect(() => {
    if (!open || (tab !== "llm" && tab !== "transcription")) return;
    const targetKind: ModelProfile["kind"] = tab === "llm" ? "llm" : "stt";
    const acceptedKinds = tab === "llm" ? ["llm"] : ["stt", "diarization"];
    if (editing && acceptedKinds.includes(editing.kind)) return;
    const saved = [...profiles.filter((profile) => profile.kind === targetKind)].sort(defaultFirst)[0];
    setEditing(saved ? normalizeLegacyProviderProfile(saved) : null);
  }, [editing, open, profiles, tab]);

  // 切页时收起添加面板与「⋯」菜单，避免跨页浮层残留。
  useEffect(() => {
    setAddOpen(false);
    setProfileMenuOpen(false);
  }, [tab]);

  // 档案切换后收起「⋯」菜单。
  useEffect(() => {
    setProfileMenuOpen(false);
  }, [editing?.id]);

  // 「⋯」菜单点外部关闭（与模型下拉一致）。
  useEffect(() => {
    if (!profileMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [profileMenuOpen]);

  // 深链定位（转写失败横幅 / 引导里的「去配置」）：跳过目录浏览，直接把编辑器切到
  // 对应表单。本地已有同类档案时优先复用并标记为启用——保存即生效，不会凭空多一份副本。
  useEffect(() => {
    if (!open || !initialFocus) return;
    setTab("transcription");
    const saved = initialFocus === "local-whisper"
      ? profiles.find((profile) => profile.kind === "stt" && isLocalWhisperTransport(profile.transport))
      : initialFocus === "apple-speech"
        ? profiles.find((profile) => profile.kind === "stt" && profile.transport === "apple-speech")
        : profiles.find((profile) => profile.kind === "stt" && profile.transport === "openai-audio");
    if (saved) {
      setEditing({
        ...normalizeLegacyProviderProfile(saved),
        ...(initialFocus === "local-whisper" ? { enabled: true } : {})
      });
    } else {
      const preset = initialFocus === "local-whisper"
        ? providerPresets.whisper
        : initialFocus === "apple-speech"
          ? providerPresets.appleSpeech
          : providerPresets.openaiWhisper;
      setEditing({
        ...emptyProfile,
        ...preset,
        options: { ...emptyProfile.options, ...(preset.options ?? {}) }
      });
    }
    setApiKey("");
    setStatus(null);
    setEditorGeneration((value) => value + 1);
    // profiles 只在打开瞬间用于挑选可复用档案；后续 loadProfiles 刷新不应覆盖用户选择。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFocus]);

  // 进入「软件更新」页时读取主进程缓存的更新状态（启动时已静默检查过一次）。
  // macOS 自动更新若已下载就绪（readyVersion），直接进入「待重启」状态。
  useEffect(() => {
    if (!open || tab !== "updates") return;
    api.updates.getState().then((state) => {
      setUpdateState(state);
      if (state.readyVersion) {
        setDownloadState({
          status: "ready",
          version: state.readyVersion,
          receivedBytes: 0, totalBytes: 0, fraction: 1
        });
      }
    }).catch((error) => {
      setUpdateState({
        status: "error",
        currentVersion: "",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "无法读取更新状态。"
      });
    });
  }, [open, tab]);
  // 安装包下载进度由主进程推送；对话框打开期间持续订阅，关闭设置不打断下载本身。
  useEffect(() => api.updates.onDownloadProgress(setDownloadState), []);
  // 服务地址/协议/端点变化后旧列表作废；切预设/切档案（editorGeneration）同样重置。
  useEffect(() => {
    setModelList(null);
    setModelSizes(null);
    setModelListError(null);
    setModelMenuOpen(false);
  }, [editorGeneration, editing?.baseUrl, editing?.options?.apiFlavor, editing?.options?.chatEndpoint]);

  // 模型下拉打开时点外部关闭（与系统 select 行为一致）。
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [modelMenuOpen]);

  // 服务商标识按端点/传输匹配预设（名称只作展示）：改名后下拉与服务商标签不会掉回自定义。
  const activePresetKey = editing ? providerKeyForProfile(editing) : "";

  /** 模型下拉的候选：预设推荐（含当前值）置顶带徽标，其余为远端列表按字母序、随输入过滤。 */
  const modelSuggestions = useMemo(() => {
    const recommended: string[] = [];
    const preset = activePresetKey ? providerPresets[activePresetKey as keyof typeof providerPresets] : undefined;
    if (preset?.model) recommended.push(preset.model);
    const current = (editing?.model ?? "").trim();
    if (current && !recommended.includes(current)) recommended.push(current);
    const filter = current.toLowerCase();
    const matches = (id: string) => !filter || id.toLowerCase().includes(filter);
    return {
      recommended: recommended.filter(matches).map((id) => ({ id, recommended: true })),
      fetched: (modelList ?? [])
        .filter((id) => !recommended.includes(id))
        .sort((a, b) => a.localeCompare(b))
        .filter(matches)
        .slice(0, 60)
        .map((id) => ({ id, recommended: false })),
      total: modelList?.length ?? 0
    };
  }, [activePresetKey, editing?.model, modelList]);

  /** 粘贴的 Base URL 命中已知厂商域名时建议套用预设（不自动切换，避免覆盖用户输入）。 */
  const [urlPresetSuggestion, setUrlPresetSuggestion] = useState<string | null>(null);
  const editingBaseUrl = editing?.baseUrl ?? "";
  useEffect(() => {
    const value = editingBaseUrl.trim();
    if (!value) {
      setUrlPresetSuggestion(null);
      return;
    }
    let host: string;
    try {
      host = new URL(value).host.toLowerCase();
    } catch {
      setUrlPresetSuggestion(null);
      return;
    }
    const matchedKey = editing?.kind ? presetHostIndexByKind.get(editing.kind)?.get(host) : undefined;
    setUrlPresetSuggestion(matchedKey && matchedKey !== activePresetKey ? matchedKey : null);
  }, [editingBaseUrl, activePresetKey]);

  /** 套用识别出的预设字段，但保留用户刚粘贴的 Base URL。 */
  const applyUrlPreset = (key: string) => {
    const preset = providerPresets[key as keyof typeof providerPresets];
    if (!preset || !editing) return;
    setEditing({
      ...editing,
      ...preset,
      baseUrl: editing.baseUrl,
      options: { ...emptyProfile.options, ...(preset.options ?? {}) }
    });
    setUrlPresetSuggestion(null);
  };

  if (!mounted) return null;

  /** 从预设开始编辑：套用预设字段并清空密钥/状态。 */
  const startPreset = (key: keyof typeof providerPresets) => {
    const preset = providerPresets[key];
    setEditing({
      ...emptyProfile,
      ...preset,
      options: { ...emptyProfile.options, ...(preset.options ?? {}) }
    });
    setApiKey("");
    setStatus(null);
    setEditorGeneration((value) => value + 1);
  };

  /** 新建自定义服务档案（OpenAI 兼容协议，按当前页决定 stt/llm）。 */
  const startCustomProfile = () => {
    const isTranscription = tab === "transcription";
    setEditing({
      ...emptyProfile,
      name: isTranscription ? "自定义转录服务" : "自定义总结服务",
      kind: isTranscription ? "stt" : "llm",
      transport: isTranscription ? "openai-audio" : "openai-chat",
      model: ""
    });
    setApiKey("");
    setStatus(null);
    setEditorGeneration((value) => value + 1);
  };

  /** 保存后就地合并档案列表：用后端返回值同步目录，避免整表 loadProfiles
   *  与 setEditing 分成两帧渲染，造成保存瞬间表单与目录连跳（闪烁）。 */
  const mergeSavedProfile = (saved: ModelProfile) => {
    setProfiles(
      profiles.some((profile) => profile.id === saved.id)
        ? profiles.map((profile) => profile.id === saved.id ? saved : profile)
        : [...profiles, saved]
    );
    return saved;
  };

  /** 拉取在线服务的可用模型列表（OpenAI 兼容与 Ollama）；已有缓存时直接展开菜单。 */
  const fetchModelList = async () => {
    if (!editing || modelListBusy) return;
    if (modelList) {
      setModelMenuOpen((open) => !open);
      return;
    }
    setModelListBusy(true);
    setModelListError(null);
    try {
      const result = await api.models.listModels(editing, apiKey.trim() || undefined);
      if (result.models === null) {
        setModelListError("该服务的原生协议暂不支持自动获取，可直接输入模型名。");
        return;
      }
      if (!result.models.length) {
        setModelListError("服务没有返回任何模型，可直接输入模型名。");
        return;
      }
      setModelList(result.models);
      setModelSizes(result.sizes ?? null);
      setModelMenuOpen(true);
    } catch (error) {
      setModelListError(`未能获取列表：${error instanceof Error ? error.message : "网络错误"}。可直接输入模型名。`);
    } finally {
      setModelListBusy(false);
    }
  };

  /** 把档案设为该类默认档（同类互斥）：未显式选模的任务（快速录音/滚动纪要/说话人分离）走默认档；
   *  智谱式多可用语义下所有档案同时可用，默认档只是兜底，不影响任务时勾选其他模型。 */
  const makeDefaultProfile = async (profile: ModelProfile) => {
    if (!profile.id || switchBusy) return;
    setSwitchBusy(profile.id);
    try {
      await api.models.setDefault(profile.kind, profile.id!);
      await loadProfiles();
      if (editing?.id === profile.id) setEditing({ ...editing, isDefault: true });
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "设置默认失败", "error");
    } finally {
      setSwitchBusy(null);
    }
  };

  /** 在线服务保存前的最小校验：缺项留在弹窗内说明原因，不创建不可用档案。 */
  const saveValidationError = (profile: ModelProfile): string | null => {
    if (!profile.name.trim()) return "请填写配置名称。";
    if (isLocalWhisperTransport(profile.transport)) {
      return profile.options.modelPath ? null : "请选择或下载一个本地模型。";
    }
    if (profile.transport === "sherpa-onnx") {
      return profile.options.segmentationModelPath && profile.options.embeddingModelPath ? null : "请先补齐两个声纹模型。";
    }
    if (profile.transport === "apple-speech" || profile.transport === "local-summary") return null;
    if (!profile.baseUrl.trim()) return "请填写 Base URL。";
    if (!profile.model.trim()) return "请填写模型名称。";
    return null;
  };

  /** 保存档案：密钥随请求送到主进程安全存储，渲染层不再持有明文。
   *  勾选了视觉纪要但未通过真实验证时，保存过程顺带完成验证——失败留在弹窗内给出原因，
   *  杜绝「已保存却静默不生效」；保存成功即关闭弹窗，收回动画就是“已保存”的反馈。 */
  const saveProfile = async () => {
    if (!editing) return;
    // 本机档案不需要命名：名称跟着模型自动更新。
    let toSave = isLocalServiceProfile(editing) ? { ...editing, name: localProfileName(editing) } : editing;
    const validationError = saveValidationError(toSave);
    if (validationError) {
      pushStatus(validationError, "error");
      return;
    }
    const key = apiKey.trim();
    const keyAtStart = statusKey;
    setBusy(true);
    setStatus(null);
    try {
      if (
        toSave.kind === "llm"
        && toSave.options.visualSummaryEnabled
        && toSave.options.visualSummaryVerifiedFingerprint !== visualFingerprint(toSave)
      ) {
        pushStatus("正在验证视觉纪要…", "info", keyAtStart);
        const result = await api.models.test(toSave, key || undefined);
        toSave = {
          ...toSave,
          options: {
            ...toSave.options,
            visualSummaryVerifiedAt: result.visualSummaryVerifiedAt,
            visualSummaryVerifiedFingerprint: result.visualSummaryVerifiedFingerprint
          }
        };
        setStatus(null);
      }
      const saved = mergeSavedProfile(await api.models.save(toSave, key || undefined));
      setEditing(saved);
      setApiKey("");
      pushStatus("配置已安全保存。", "success", keyAtStart);
      // 保存即启用（同类首条自动成为默认档），整表刷新让目录立即反映。
      await loadProfiles();
      onClose();
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "保存失败", "error", keyAtStart);
    } finally {
      setBusy(false);
    }
  };

  /** 测试连接：主进程对所选端点发一次最小请求（见 providers.mjs 的 testModelProfile）。 */
  const testProfile = async () => {
    if (!editing) return;
    const keyAtStart = statusKey;
    setBusy(true);
    // 立即给出"已在测试"的反馈：远程接口的测试可能要数秒到 20 秒，
    // 只禁用按钮没有任何文字变化，用户会以为点击没生效。
    pushStatus("正在测试连接…", "info", keyAtStart);
    try {
      const result = await api.models.test(editing, apiKey.trim() || undefined);
      if (result.visualSummaryVerifiedAt && result.visualSummaryVerifiedFingerprint) {
        const verified: ModelProfile = {
          ...editing,
          options: {
            ...editing.options,
            visualSummaryVerifiedAt: result.visualSummaryVerifiedAt,
            visualSummaryVerifiedFingerprint: result.visualSummaryVerifiedFingerprint
          }
        };
        const saved = mergeSavedProfile(await api.models.save(verified, apiKey || undefined));
        setEditing(saved);
        setApiKey("");
      }
      pushStatus(result.message, "success", keyAtStart);
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "连接失败", "error", keyAtStart);
    } finally {
      setBusy(false);
    }
  };

  /** 本机服务（Apple 在线识别）改动即写入：保存失败回滚开关并用红字说明。 */
  const updateAppleServerMode = async (allowServer: boolean) => {
    if (!editing) return;
    const previous = editing;
    const next = { ...editing, options: { ...editing.options, allowServer } };
    setEditing(next);
    setBusy(true);
    pushStatus("正在保存…", "info");
    try {
      const saved = mergeSavedProfile(await api.models.save(next));
      setEditing(saved);
      await loadProfiles();
      pushStatus("已生效，无需再保存。", "success", profileStatusKey(tab, saved));
    } catch (error) {
      setEditing(previous);
      pushStatus(error instanceof Error ? error.message : "保存失败", "error", profileStatusKey(tab, previous));
    } finally {
      setBusy(false);
    }
  };

  /** 本机档案的即时写入：声纹高级字段这类零散改动直接落库，不需要底栏保存。 */
  const saveLocalProfile = async (next: ModelProfile) => {
    const named = { ...next, name: localProfileName(next) };
    setBusy(true);
    pushStatus("正在保存…", "info");
    try {
      const saved = mergeSavedProfile(await api.models.save(named));
      setEditing(saved);
      await loadProfiles();
      pushStatus("已生效，无需再保存。", "success", profileStatusKey(tab, saved));
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  /** 标题区「⋯」：删除档案（默认档由主进程按名称序补位）。 */
  const deleteProfile = async () => {
    if (!editing?.id) return;
    setProfileMenuOpen(false);
    const target = editing;
    if (!(await profileConfirm.confirm({
      title: `删除「${target.name}」？`,
      body: "只会移除这份配置，历史会议、转写与纪要都不受影响。",
      confirmLabel: "删除配置"
    }))) return;
    setBusy(true);
    try {
      await api.models.delete(target.id!);
      setEditing(null);
      setStatus(null);
      await loadProfiles();
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setBusy(false);
    }
  };

  /** 标题区「⋯」：删除已保存的密钥（档案保留，副标题会提示缺少 API Key）。 */
  const deleteProfileSecret = async () => {
    if (!editing?.secretId) return;
    setProfileMenuOpen(false);
    const target = editing;
    if (!(await profileConfirm.confirm({
      title: "删除已保存的密钥？",
      body: "配置会保留；需要重新填写 API Key 才能继续使用这个在线服务。",
      confirmLabel: "删除密钥"
    }))) return;
    setBusy(true);
    try {
      await api.models.deleteSecret(target.secretId!);
      const cleared = { ...target, secretId: undefined };
      setEditing(cleared);
      await api.models.save(cleared);
      await loadProfiles();
      pushStatus("密钥已删除。", "success", profileStatusKey(tab, cleared));
    } catch (error) {
      pushStatus(error instanceof Error ? error.message : "删除密钥失败", "error");
    } finally {
      setBusy(false);
    }
  };

  /** 「添加服务」选择：无模型可选的本机服务（Apple / 本机纪要）点选即落库；
   *  其余进入草稿，由模型选择或底部保存完成配置。 */
  const addService = async (key: "whisper" | "appleSpeech" | "openaiWhisper" | "sherpa" | "localSummary" | "ollama" | "openai") => {
    setAddOpen(false);
    const preset = providerPresets[key];
    // 本机服务天然只有一份：已有配置时直接打开，不产生同名副本。
    // 在线服务相反——「添加在线服务」就是要新建一份，不复用已有档案。
    const singleton = key === "whisper" || key === "appleSpeech" || key === "sherpa" || key === "localSummary" || key === "ollama";
    const reusable = singleton
      ? profiles
        .filter((profile) => profile.kind === preset.kind && (
          key === "whisper" ? isLocalWhisperTransport(profile.transport)
            : key === "sherpa" ? profile.transport === "sherpa-onnx"
            : profile.transport === preset.transport
        ))
        .sort(defaultFirst)[0]
      : undefined;
    if (reusable) {
      setEditing(normalizeLegacyProviderProfile(reusable));
      setApiKey("");
      setStatus(null);
      setEditorGeneration((value) => value + 1);
      return;
    }
    if (key === "appleSpeech" || key === "localSummary") {
      const draft: ModelProfile = {
        ...emptyProfile,
        ...preset,
        options: { ...emptyProfile.options, ...(preset.options ?? {}) }
      };
      setEditing(draft);
      setApiKey("");
      setStatus(null);
      setEditorGeneration((value) => value + 1);
      try {
        const saved = mergeSavedProfile(await api.models.save({ ...draft, name: localProfileName(draft) }));
        setEditing(saved);
        await loadProfiles();
      } catch (error) {
        pushStatus(error instanceof Error ? error.message : "添加失败", "error", profileStatusKey(tab, draft));
      }
      return;
    }
    startPreset(key as Parameters<typeof startPreset>[0]);
  };

  /** 手动检查更新：主进程拉取并校验官网 JSON 清单（updates.mjs）。 */
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      setUpdateState(await api.updates.check());
    } catch (error) {
      setUpdateState({
        status: "error",
        currentVersion: updateState?.currentVersion || "",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "检查更新失败。"
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  /** 应用内下载更新：主进程负责下载、SHA-256 校验并打开安装程序。 */
  const downloadUpdate = async () => {
    setDownloadBusy(true);
    setDownloadState({
      status: "downloading",
      version: updateState?.update?.version || "",
      receivedBytes: 0, totalBytes: 0, fraction: 0
    });
    try {
      await api.updates.download();
    } catch (error) {
      setDownloadState((current) => ({
        status: current?.status === "cancelled" ? "cancelled" : "error",
        version: current?.version || updateState?.update?.version || "",
        receivedBytes: current?.receivedBytes || 0,
        totalBytes: current?.totalBytes || 0,
        fraction: current?.fraction || 0,
        message: error instanceof Error ? error.message : "下载安装包失败。"
      }));
    } finally {
      setDownloadBusy(false);
    }
  };
  const cancelUpdateDownload = async () => {
    try {
      await api.updates.cancelDownload();
    } catch {
      // 取消失败不影响主进程的下载状态；错误会在下载通道里回到这里。
    }
  };

  /** macOS 自动更新就绪后的显式安装：原地替换并重启（录音期间由 UI 禁用）。 */
  const restartToUpdate = async () => {
    setInstallingUpdate(true);
    try {
      await api.updates.restartToUpdate();
    } catch (error) {
      setDownloadState((current) => ({
        status: "error",
        version: current?.version || updateState?.update?.version || "",
        receivedBytes: 0, totalBytes: 0, fraction: 0,
        message: error instanceof Error ? error.message : "启动更新失败。"
      }));
      setInstallingUpdate(false);
    }
  };

  /** 打开官网下载页：应用内下载不可用时的稳定兜底。 */
  const openUpdateDownload = async () => {
    try {
      await api.updates.openDownload();
    } catch (error) {
      setUpdateState((current) => ({
        status: "error",
        currentVersion: current?.currentVersion || "",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "无法打开官网下载地址。"
      }));
    }
  };

  const downloadPercent = Math.round((downloadState?.fraction || 0) * 100);
  const downloadSize = downloadState?.totalBytes
    ? `${(downloadState.receivedBytes / 1024 / 1024).toFixed(0)} / ${(downloadState.totalBytes / 1024 / 1024).toFixed(0)} MB`
    : "";
  /** 下载进度的可读文案：区分下载、校验、打开、就绪与完成。 */
  const downloadLabel = !downloadState
    ? ""
    : downloadState.status === "downloading"
      ? `正在后台下载更新 ${downloadPercent}%${downloadSize ? `（${downloadSize}）` : ""}`
      : downloadState.status === "verifying"
        ? "正在校验更新…"
        : downloadState.status === "ready"
          ? `新版本已就绪：点「立即重启并更新」马上升级，或退出应用后自动安装${recordingActive ? "（录音进行中，不会打断你）" : ""}。`
          : downloadState.status === "installing"
            ? "正在更新 MinuteFlow…"
            : downloadState.status === "opening"
              ? "正在打开安装程序…"
              : downloadState.status === "done"
                ? api.system.platform === "win32"
                  ? "安装包已打开：按安装程序提示完成升级，应用会自动重启。"
                  : "安装包已打开：把 MinuteFlow 拖入“应用程序”即可完成升级。"
                : downloadState.message || (downloadState.status === "cancelled" ? "已取消下载。" : "下载更新失败。");

  /** 安装方式按平台区分：macOS 自动原地更新（无拖拽），Windows 运行 Squirrel 安装程序。 */
  const updateInstallHint = api.system.platform === "win32"
    ? "更新只接受 HTTPS 官网清单和官方安装包；下载完成后会先校验 SHA-256，再打开 MinuteFlow-Setup.exe 完成升级。"
    : api.system.platform === "darwin"
      ? "发现新版本后会自动在后台下载；完成 SHA-512 与开发者签名校验后原地更新，全程无需拖拽 DMG。退出应用时也会自动装好新版本，录音期间绝不会自动重启。"
      : "应用只接受 HTTPS 官网清单和官方发布地址。";
  /** macOS 自动更新已就绪的版本（下载完成，等待重启安装）。 */
  const updateReadyVersion = downloadState?.status === "ready"
    ? downloadState.version
    : updateState?.readyVersion || "";

  // 已保存档案按「本机 / 在线 / 说话人分离」分组展示：
  // 智谱式多可用——全部档案同时可用，组内默认档排在最前，任务开启时再按需勾选其他模型。
  const savedTranscriptionProfiles = [...profiles.filter((profile) => profile.kind === "stt")].sort(defaultFirst);
  const localSttProfiles = savedTranscriptionProfiles.filter(isLocalSttProfile);
  const onlineSttProfiles = savedTranscriptionProfiles.filter((profile) => !isLocalSttProfile(profile));
  const savedDiarizationProfiles = [...profiles.filter((profile) => profile.kind === "diarization")].sort(defaultFirst);
  const savedLlmProfiles = [...profiles.filter((profile) => profile.kind === "llm")].sort(defaultFirst);
  const localLlmProfiles = savedLlmProfiles.filter(isLocalLlmProfile);
  const onlineLlmProfiles = savedLlmProfiles.filter((profile) => !isLocalLlmProfile(profile));

  /** 模型页用标题替代面包屑；「添加服务」在没有配置时强制展开。 */
  const modelTab = tab === "llm" || tab === "transcription";
  const totalSaved = tab === "llm"
    ? savedLlmProfiles.length
    : savedTranscriptionProfiles.length + savedDiarizationProfiles.length;
  const addExpanded = addOpen || totalSaved === 0;
  /** 标题区标签：本机/在线语义 + 在线服务商（名称只作展示，改名不影响识别）。 */
  const transportInfo = editing ? describeTransport(editing) : null;
  const chipPresetKey = editing && !isLocalServiceProfile(editing) && !isLocalLlmProfile(editing)
    ? providerKeyForProfile(editing)
    : "";
  const chipPreset = chipPresetKey ? providerPresets[chipPresetKey as keyof typeof providerPresets] : undefined;
  const chipProtocol = chipPresetKey ? describePreset(chipPresetKey)?.protocol : undefined;

  /**
   * 已保存档案行的统一渲染（目录各任务分区共用）。
   * 智谱式多可用：保存即启用、全部可用；右侧是「默认档」状态——默认档供未显式选模的
   * 任务兜底，点「设为默认」切换；具体用哪个模型在任务开启时勾选（录音条/导入抽屉/问答面板）。
   * 副标题只报需要动手的问题（缺密钥/缺模型），不再用正向徽标占据目录宽度。
   */
  const renderSavedRow = (profile: ModelProfile, taskLabel: string) => {
    const issue = profileIssue(profile);
    const subtitle = profile.kind === "diarization"
      ? (issue ?? "声纹识别已就绪")
      : profile.transport === "apple-speech"
        ? (profile.options.allowServer === true ? "系统内置 · 在线识别" : "系统内置 · 本机离线")
        : profile.transport === "local-summary"
          ? "完全离线 · 无需模型"
          : isLocalWhisperTransport(profile.transport)
            ? (issue ?? `已就绪 · ${LOCAL_WHISPER_RUNTIME_LABELS[profile.transport] ?? "本地模型"}`)
            : `${profile.model || "尚未选择模型"}`;
    return (
      <div key={profile.id} className={`model-catalog__row ${editing?.id === profile.id ? "is-selected" : ""}`}>
        <button className="model-catalog__row-main" onClick={() => { setEditing(normalizeLegacyProviderProfile(profile)); setApiKey(""); setStatus(null); setEditorGeneration((value) => value + 1); }}>
          <span className="profile-icon">{profile.kind === "stt" ? "STT" : profile.kind === "llm" ? "LLM" : "SPK"}</span>
          <span className="model-catalog__text">
            <span className="model-catalog__titleline">
              <strong>{profile.name}</strong>
            </span>
            <small className={issue ? "is-issue" : undefined}>{subtitle}</small>
          </span>
        </button>
        {profile.isDefault ? (
          <span className="model-default-badge" title={`${taskLabel}的默认模型：未手动选择时的新任务用它`}>默认</span>
        ) : (
          <button
            type="button"
            className="model-set-default"
            aria-label={`将 ${profile.name} 设为${taskLabel}的默认模型`}
            title={`设为${taskLabel}默认：未手动选择模型的新任务（如快速录音）将使用它`}
            disabled={switchBusy === profile.id}
            onClick={() => void makeDefaultProfile(profile)}
          >设为默认</button>
        )}
      </div>
    );
  };

  return (
    <div className={`modal-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <div className="settings-nav__title">
              <span id="settings-dialog-title">设置</span>
              <small>MinuteFlow</small>
            </div>
            <div className="settings-nav__group">
              <span className="settings-nav__label">应用</span>
              <button aria-current={tab === "general" ? "page" : undefined} className={tab === "general" ? "is-active" : ""} onClick={() => setTab("general")}><GearSix size={18} />通用设置</button>
              <button aria-current={tab === "llm" ? "page" : undefined} className={tab === "llm" ? "is-active" : ""} onClick={() => setTab("llm")}><Sparkle size={18} />AI 总结</button>
              <button aria-current={tab === "transcription" ? "page" : undefined} className={tab === "transcription" ? "is-active" : ""} onClick={() => setTab("transcription")}><Waveform size={18} />转录设置</button>
              <button aria-current={tab === "storage" ? "page" : undefined} className={tab === "storage" ? "is-active" : ""} onClick={() => setTab("storage")}><ShieldCheck size={18} />存储与隐私</button>
            </div>
            <div className="settings-nav__group settings-nav__group--bottom">
              <span className="settings-nav__label">关于</span>
            {showUpdateSettings && (
              <button aria-current={tab === "updates" ? "page" : undefined} className={tab === "updates" ? "is-active" : ""} onClick={() => setTab("updates")}><ArrowClockwise size={18} />软件更新</button>
            )}
              <div className="settings-nav__privacy"><ShieldCheck size={15} weight="fill" /><span>本地优先<br /><small>你的会议数据默认留在本机</small></span></div>
            </div>
          </nav>
          <main className="settings-main">
            <header className="settings-header">
              {modelTab ? (
                <div className="settings-header__title">
                  <h1>{tab === "llm" ? "AI 总结" : "转录设置"}</h1>
                  <p>{tab === "llm" ? "选择会议内容的整理方式" : "选择声音转文字的方式"}</p>
                </div>
              ) : (
                <div className="settings-breadcrumb"><span>设置</span><CaretRight size={14} /><strong>{tab === "general" ? "通用设置" : tab === "storage" ? "存储与隐私" : "软件更新"}</strong></div>
              )}
              <button className="icon-button" onClick={onClose} aria-label="关闭设置" disabled={busy}><X size={18} /></button>
            </header>
          <div key={tab} className={`settings-content ${(tab === "llm" || tab === "transcription") ? "settings-content--models" : `settings-content--${tab}`}`}>
            {(tab === "llm" || tab === "transcription") && (
              <div className="model-settings">
                <aside className="model-catalog">
                  {tab === "transcription" ? (
                    <>
                      {!!localSttProfiles.length && (
                        <div className="model-catalog__section"><span>在本机运行</span>
                          {localSttProfiles.map((profile) => renderSavedRow(profile, "转写"))}
                        </div>
                      )}
                      {!!onlineSttProfiles.length && (
                        <div className="model-catalog__section"><span>在线服务</span>
                          {onlineSttProfiles.map((profile) => renderSavedRow(profile, "转写"))}
                        </div>
                      )}
                      {/* 说话人分离是独立的可选增强：只有配置过才出现在目录里。 */}
                      {!!savedDiarizationProfiles.length && (
                        <div className="model-catalog__enhancement">
                          <div className="model-catalog__enhancement-heading">
                            <span>说话人分离</span>
                            <small>可选增强 · 多人会议自动区分发言人</small>
                          </div>
                          {savedDiarizationProfiles.map((profile) => renderSavedRow(profile, "说话人分离"))}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {!!localLlmProfiles.length && (
                        <div className="model-catalog__section"><span>在本机运行</span>
                          {localLlmProfiles.map((profile) => renderSavedRow(profile, "总结"))}
                        </div>
                      )}
                      {!!onlineLlmProfiles.length && (
                        <div className="model-catalog__section"><span>在线服务</span>
                          {onlineLlmProfiles.map((profile) => renderSavedRow(profile, "总结"))}
                        </div>
                      )}
                    </>
                  )}
                  {/* 没有配置时添加入口贴顶，避免整列只剩一大片空白。 */}
                  <div className={`model-catalog__add${addExpanded ? " is-open" : ""}${totalSaved === 0 ? " is-empty" : ""}`}>
                    <button
                      type="button"
                      className="model-catalog__add-trigger"
                      aria-expanded={addExpanded}
                      onClick={() => setAddOpen((value) => !value)}
                    >
                      <Plus size={15} />
                      <span>
                        <strong>添加服务</strong>
                        <small>{tab === "llm"
                          ? "本机纪要 · Ollama · 在线服务"
                          : api.system.platform === "darwin" ? "本地 Whisper · Apple · 在线 · 声纹" : "本地 Whisper · 在线 · 声纹"}</small>
                      </span>
                    </button>
                    {addExpanded && (
                      <div className="model-catalog__add-options">
                        {tab === "llm" ? (
                          <>
                            <button type="button" onClick={() => void addService("localSummary")}><strong>本机基础纪要</strong><small>完全离线 · 无需模型</small></button>
                            <button type="button" onClick={() => void addService("ollama")}><strong>Ollama</strong><small>需已安装本机服务</small></button>
                            <button type="button" onClick={() => void addService("openai")}><strong>在线服务</strong><small>DeepSeek、Kimi、智谱等</small></button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => void addService("whisper")}><strong>本地 Whisper</strong><small>离线 · 需下载模型</small></button>
                            {api.system.platform === "darwin" && (
                              <button type="button" onClick={() => void addService("appleSpeech")}><strong>Apple 语音识别</strong><small>系统内置 · 零下载</small></button>
                            )}
                            <button type="button" onClick={() => void addService("openaiWhisper")}><strong>在线服务</strong><small>OpenAI Whisper 或兼容接口</small></button>
                            <button type="button" onClick={() => void addService("sherpa")}><strong>说话人分离</strong><small>可选增强 · 本地声纹</small></button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </aside>
                {editing ? (
                  <div key={editorGeneration} className="profile-editor-wrap">
                    <div className="profile-editor-heading">
                      <span className="profile-editor-heading__icon">{editing.kind === "stt" ? <Waveform size={24} /> : editing.kind === "diarization" ? <FingerprintSimple size={24} /> : <Sparkle size={24} />}</span>
                      <div className="profile-editor-heading__text">
                        <h2>{editing.name}</h2>
                        <div className="profile-editor-heading__meta">
                          <span className={`profile-chip${transportInfo?.online ? " is-online" : ""}`}>{transportInfo?.text}</span>
                          {chipPreset && (
                            <span className="profile-chip">{chipPreset.name}{chipProtocol ? ` · ${chipProtocol}` : ""}</span>
                          )}
                        </div>
                      </div>
                      {editing.id && (
                        <div className="profile-menu" ref={profileMenuRef}>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="更多操作"
                            aria-expanded={profileMenuOpen}
                            onClick={() => setProfileMenuOpen((value) => !value)}
                          ><DotsThree size={18} weight="bold" /></button>
                          {profileMenuOpen && (
                            <div className="profile-menu__panel" role="menu">
                              {editing.secretId && <button type="button" role="menuitem" onClick={() => void deleteProfileSecret()}>删除密钥</button>}
                              <button type="button" role="menuitem" className="is-danger" onClick={() => void deleteProfile()}>删除档案</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="profile-editor-divider" />
                  <div className="profile-editor">
                    {!isLocalServiceProfile(editing) && (
                    <div className="form-grid">
                      {!editing.id && (
                      <label className="field form-grid__full"><span>服务商</span>
                        <select value={activePresetKey} onChange={(event) => {
                          if (!event.target.value) {
                            startCustomProfile();
                            return;
                          }
                          const preset = providerPresets[event.target.value as keyof typeof providerPresets];
                          if (!preset) return;
                          // 换服务商等于换一份配置：丢掉旧草稿的档案绑定与密钥，避免把 A 的密钥留给 B。
                          setEditing({
                            ...emptyProfile,
                            ...preset,
                            id: undefined,
                            secretId: undefined,
                            options: { ...emptyProfile.options, ...(preset.options ?? {}) }
                          });
                          setApiKey("");
                          setStatus(null);
                          setModelList(null);
                          setModelListError(null);
                        }}>
                          <option value="">自定义配置</option>
                          {tab === "llm" ? (<>
                            {llmProviderGroups.map((group) => <optgroup label={group.label} key={group.label}>{group.providers.map((provider) => <option value={provider.key} key={provider.key}>{provider.name}</option>)}</optgroup>)}
                            <option value="ollama">Ollama（本机服务）</option>
                          </>) : (<>
                            <option value="openaiWhisper">OpenAI Whisper</option>
                            <option value="newApiWhisper">New API</option>
                          </>)}
                        </select>
                        {(() => {
                          const describe = describePreset(activePresetKey);
                          if (!describe) return <small className="preset-describe">自由填写端点与密钥的 OpenAI 兼容服务</small>;
                          return <small className="preset-describe">{describe.text}{describe.protocol ? ` · ${describe.protocol}` : ""}</small>;
                        })()}
                      </label>
                      )}
                          <label className="field"><span>名称</span><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
                          {!isLocalWhisperTransport(editing.transport) && editing.transport !== "local-summary" && editing.transport !== "sherpa-onnx" && editing.transport !== "apple-speech" && (
                            <div className="field field--model-picker form-grid__full" ref={modelMenuRef}>
                              <span>模型</span>
                              <div className={`model-picker ${modelMenuOpen ? "is-open" : ""}`}>
                                <input
                                  value={editing.model}
                                  onChange={(event) => setEditing({ ...editing, model: event.target.value, options: invalidateVisualVerification(editing.options) })}
                                  onFocus={() => { if (modelList) setModelMenuOpen(true); }}
                                  onKeyDown={(event) => { if (event.key === "Escape") setModelMenuOpen(false); }}
                                  placeholder={tab === "llm" ? "点击右侧获取列表，或直接输入" : "例如 whisper-1"}
                                />
                                {editing.options.apiFlavor !== "anthropic" && editing.options.apiFlavor !== "gemini" && (
                                  <button type="button" className="model-picker__trigger" onClick={() => void fetchModelList()} disabled={modelListBusy} aria-label={modelList ? "展开或收起模型列表" : "获取可用模型列表"} title={modelList ? "展开/收起模型列表" : "从服务获取可用模型列表"}>
                                    {modelListBusy ? <span className="model-picker__spinner" aria-hidden="true" /> : <CaretDown size={14} />}
                                  </button>
                                )}
                                {modelMenuOpen && (
                                  <div className="model-picker__menu" role="listbox" aria-label="可用模型">
                                    {modelSuggestions.recommended.map((item) => (
                                      <button key={`rec-${item.id}`} type="button" role="option" aria-selected={item.id === editing.model} className={`model-picker__option is-recommended ${item.id === editing.model ? "is-current" : ""}`} onClick={() => { setEditing({ ...editing, model: item.id, options: invalidateVisualVerification(editing.options) }); setModelMenuOpen(false); }}>
                                        <span>{item.id}</span><small>推荐</small>
                                      </button>
                                    ))}
                                    {!!modelSuggestions.recommended.length && !!modelSuggestions.fetched.length && <div className="model-picker__divider" />}
                                    {modelSuggestions.fetched.map((item) => {
                                      const size = editing.transport === "ollama" ? modelSizes?.[item.id] : undefined;
                                      const fit = size ? ollamaModelFit(size, hardware?.memoryBytes ?? 0) : "unknown";
                                      return (
                                        <button key={item.id} type="button" role="option" aria-selected={item.id === editing.model} className={`model-picker__option ${item.id === editing.model ? "is-current" : ""}`} onClick={() => { setEditing({ ...editing, model: item.id, options: invalidateVisualVerification(editing.options) }); setModelMenuOpen(false); }}>
                                          <span>{item.id}</span>
                                          {size ? (
                                            <small className={fit === "heavy" ? "is-heavy" : fit === "best" ? "is-fit" : undefined}>
                                              {formatModelBytes(size)}{fit === "best" ? " · 适合本机" : fit === "heavy" ? " · 可能超出内存" : ""}
                                            </small>
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                    {!modelSuggestions.recommended.length && !modelSuggestions.fetched.length && (
                                      <div className="model-picker__empty">{modelList ? "没有匹配的模型，将按输入内容保存。" : "点击右侧按钮获取可用模型列表。"}</div>
                                    )}
                                    {modelList && !!modelSuggestions.total && (
                                      <div className="model-picker__meta">服务返回 {modelSuggestions.total} 个模型{modelSuggestions.fetched.length < modelSuggestions.total ? `，显示前 ${modelSuggestions.fetched.length} 个匹配项` : ""}{editing.transport === "ollama" && modelSizes && hardware ? `；已按${formatHardwareLine(hardware)}标注适配` : ""}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                              {modelListError && <small className="model-picker__hint">{modelListError}</small>}
                            </div>
                          )}
                    </div>
                    )}
                    {editing.transport === "local-summary" ? (
                      <>
                        <div className="field"><span>说明</span><div className="readonly-control">完全离线的规则纪要：不发起任何网络请求，也不需要下载模型。</div></div>
                        <details className="advanced-provider-options">
                          <summary>它能做什么</summary>
                          <div className="readonly-control">从转录中提取要点、决策、行动项与风险，适合无网环境或隐私优先场景；追求更高质量可另配在线总结服务。</div>
                        </details>
                      </>
                    ) : isLocalWhisperTransport(editing.transport) ? (
                      <LocalModelManager profile={editing} onChange={setEditing} />
                    ) : editing.transport === "apple-speech" ? (
                      <>
                        <div className="field"><span>说明</span><div className="readonly-control">macOS 内置的语音识别：免费、无需下载模型，默认只在本机运行、音频不出设备。</div></div>
                        <details className="advanced-provider-options">
                          <summary>权限与故障排除</summary>
                          <div className="readonly-control">首次测试或使用时，系统会请求「语音识别」权限；若识别反复超时，请到 系统设置 → 键盘 → 听写 下载对应语言的离线资源。</div>
                        </details>
                        <section className="visual-capability-setting">
                          <label>
                            <input
                              type="checkbox"
                              checked={editing.options.allowServer === true}
                              disabled={busy}
                              onChange={(event) => void updateAppleServerMode(event.target.checked)}
                            />
                            <span><strong>使用 Apple 在线识别</strong><small>改用 Apple 服务器上的语音模型，专业术语与连续讲话的识别更完整；开启后音频会发送至 Apple。改动立即生效。</small></span>
                          </label>
                        </section>
                        <div className="local-test-row">
                          <button type="button" className="text-button" disabled={busy} onClick={() => void testProfile()}>测试识别</button>
                          <small>用一段真实语音验证是否可用（首次会请求系统权限）</small>
                        </div>
                      </>
                    ) : editing.transport === "sherpa-onnx" ? (
                      <>
                        <div className="field"><span>说明</span><div className="readonly-control">引擎应用内置、无需安装；补齐两个模型后，多人会议会自动区分发言人。</div></div>
                        <DiarizationSetup profile={editing} onChange={setEditing} onCommit={(next) => void saveLocalProfile(next)} />
                        <VoiceprintBookCard />
                      </>
                    ) : (
                      <>
                        {editing.transport === "ollama" && (
                          <div className="field field--device-info"><span>本机配置</span><div className="readonly-control">
                            {hardware
                              ? <>{formatHardwareLine(hardware)}。{ollamaGuidance(hardware.memoryBytes)}；获取模型列表后会按内存标注体积与适配。</>
                              : "正在读取设备信息…"}
                          </div></div>
                        )}
                        <label className="field"><span>Base URL</span><input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value, options: invalidateVisualVerification(editing.options) })} placeholder={editing.transport === "openai-audio" ? "https://example.com/v1，也可粘贴完整转录端点" : "https://example.com/v1"} /></label>
                        {urlPresetSuggestion && (
                          <div className="url-recognize">
                            <span>已识别为 {providerPresets[urlPresetSuggestion as keyof typeof providerPresets].name} 端点</span>
                            <button type="button" className="text-button" onClick={() => applyUrlPreset(urlPresetSuggestion)}>套用预设</button>
                          </div>
                        )}
                        {editing.transport !== "ollama" && <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing.secretId ? "已安全保存；留空保持不变" : "sk-…"} /></label>}
                        {editing.transport !== "ollama" && <details className="advanced-provider-options">
                          <summary>高级设置</summary>
                          {editing.transport === "openai-audio" ? (
                            <label className="field"><span>返回格式</span>
                              <select value={editing.options.responseFormat || (editing.options.apiFlavor === "new-api" ? "json" : "verbose_json")} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, responseFormat: event.target.value as "json" | "verbose_json" | "text" } })}>
                                <option value="json">JSON（兼容性最好）</option>
                                <option value="verbose_json">Verbose JSON（含时间戳）</option>
                                <option value="text">纯文本</option>
                              </select>
                            </label>
                          ) : (
                            <label className="field"><span>兼容协议</span>
                              <select value={editing.options.apiFlavor || "openai"} onChange={(event) => setEditing({ ...editing, options: { ...invalidateVisualVerification(editing.options), apiFlavor: event.target.value as "openai" | "anthropic" | "gemini" } })}>
                                <option value="openai">OpenAI 兼容</option>
                                <option value="anthropic">Anthropic 原生</option>
                                <option value="gemini">Google Gemini 原生</option>
                              </select>
                            </label>
                          )}
                          {editing.transport === "openai-audio" ? (
                            <label className="field"><span>转录端点（可选）</span><input value={editing.options.transcriptionEndpoint || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, transcriptionEndpoint: event.target.value } })} placeholder="留空自动尝试 /v1/audio/transcriptions" /></label>
                          ) : (
                            <label className="field"><span>聊天端点（可选）</span><input value={editing.options.chatEndpoint || ""} onChange={(event) => setEditing({ ...editing, options: { ...invalidateVisualVerification(editing.options), chatEndpoint: event.target.value } })} placeholder="留空自动使用 /v1/chat/completions" /></label>
                          )}
                        </details>}
                      </>
                    )}
                    {tab === "llm" && editing.transport !== "local-summary" && (
                      <section className="visual-capability-setting">
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(editing.options.visualSummaryEnabled)}
                            onChange={(event) => setEditing({
                              ...editing,
                              options: {
                                ...invalidateVisualVerification(editing.options),
                                visualSummaryEnabled: event.target.checked
                              }
                            })}
                          />
                          <span><strong>启用视觉纪要</strong><small>最终纪要完成后，再用结构化内容生成可分享的信息图。</small></span>
                        </label>
                        <span className={editing.options.visualSummaryVerifiedAt ? "is-verified" : ""}>
                          {editing.options.visualSummaryVerifiedAt
                            ? "已通过结构验证"
                            : editing.options.visualSummaryEnabled
                              ? "保存或测试时自动验证"
                              : "开启后保存时自动验证"}
                        </span>
                      </section>
                    )}
                    {isLocalServiceProfile(editing) ? (
                      visibleStatus && <div className={statusClass(visibleStatus.tone)} role="status" aria-live="polite">{visibleStatus.text}</div>
                    ) : (
                      <div className="profile-actions">
                        {visibleStatus && <div className={statusClass(visibleStatus.tone)} role="status" aria-live="polite">{visibleStatus.text}</div>}
                        <span />
                        <button className="button" disabled={busy} onClick={testProfile}>测试连接</button>
                        <button className="button button--primary" disabled={busy} onClick={saveProfile}>保存配置</button>
                      </div>
                    )}
                  </div>
                  </div>
                ) : (
                  <div className="profile-editor-wrap">
                    <div className="profile-editor-empty">
                      <span className="profile-editor-empty__icon"><Plus size={20} /></span>
                      <h2>还没有配置{tab === "llm" ? "总结服务" : "转录服务"}</h2>
                      <p>从左侧「添加服务」开始：本机服务选完即生效，在线服务只需填写一次密钥。</p>
                    </div>
                  </div>
                )}
              </div>
            )}
            {tab === "general" && (
              <div className="preference-settings">
                <div className="settings-page-intro"><h2>通用设置</h2><p>设置新会议的默认行为，减少每次开始前的重复选择。</p></div>
                <section className="settings-card"><div className="settings-card__title"><SlidersHorizontal size={19} /><div><strong>会议偏好</strong><small>适用于之后创建的会议</small></div></div>
                  <label><span><strong>默认会议模式</strong><small>决定新会议的录音来源提示</small></span><select value={preferences.defaultMode} onChange={(event) => updatePreferences({ ...preferences, defaultMode: event.target.value as "online" | "offline" })}><option value="online">线上会议</option><option value="offline">线下会议</option></select></label>
                  <label><span><strong>AI 会议纪要间隔</strong><small>有足够新内容时自动归纳的频率</small></span><select value={preferences.summaryIntervalSeconds} onChange={(event) => updatePreferences({ ...preferences, summaryIntervalSeconds: Number(event.target.value) })}><option value="60">约每 1 分钟</option><option value="120">约每 2 分钟</option><option value="300">约每 5 分钟</option></select></label>
                </section>
                <section className="settings-card settings-card--stacked"><div className="settings-card__title"><Sparkle size={19} /><div><strong>自定义术语</strong><small>帮助模型更准确地识别人名、产品名和缩写</small></div></div><label><textarea rows={6} value={preferences.glossary.join("\n")} onChange={(event) => updatePreferences({ ...preferences, glossary: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} placeholder="例如：MinuteFlow、Q3 复盘、SKU（每行一个）" /><small className="field-hint">每行填写一个术语，修改会自动保存。</small></label></section>
                <section className="settings-card license-card"><div className="settings-card__title"><Key size={19} /><div><strong>授权</strong><small>一个激活码最多可在 2 台设备上使用</small></div></div>
                  {licenseStatus?.state === "licensed" ? (
                    <>
                      <div className="settings-card__action license-card__row">
                        <span className="license-card__state"><CheckCircle size={16} weight="fill" />已激活{licenseStatus.licenseKeyMasked ? <> · <code className="license-card__key">{licenseStatus.licenseKeyMasked}</code></> : null}</span>
                        {deactivateConfirm ? (
                          <span className="license-card__confirm">
                            <small>停用将释放本机的设备占用，之后需重新激活。</small>
                            <button className="button button--small" disabled={deactivateBusy} onClick={() => { setDeactivateConfirm(false); setLicenseError(null); }}>取消</button>
                            <button className="button button--small button--danger" disabled={deactivateBusy} onClick={handleDeactivate}>{deactivateBusy ? "正在停用…" : "确认停用"}</button>
                          </span>
                        ) : (
                          <button className="button" onClick={() => { setDeactivateConfirm(true); setLicenseError(null); }}>停用本机授权</button>
                        )}
                      </div>
                      {licenseError && <p className="license-card__error">{licenseError}</p>}
                    </>
                  ) : (
                    <div className="settings-card__action">
                      <span>{licenseStatus?.state === "error" ? (licenseStatus.message || "授权状态读取异常，可稍后重试。") : "尚未激活，录制、转写与 AI 纪要需要解锁后使用"}</span>
                      <button className="button" onClick={handleOpenCheckout}>前往购买页</button>
                    </div>
                  )}
                </section>
              </div>
            )}
            {tab === "storage" && (
              <div className="storage-settings">
                <div className="settings-page-intro"><h2>存储与隐私</h2><p>MinuteFlow 默认在本机处理并保存会议内容。</p></div>
                <div className="local-first-banner"><ShieldCheck size={24} weight="duotone" /><div><strong>本地优先</strong><p>录音、笔记和索引不会自动上传。只有配置服务商后，对应内容才会发送给该服务。</p></div></div>
                <section className="settings-card"><div className="settings-card__title"><HardDrives size={19} /><div><strong>数据保留</strong><small>管理原始音频的本地生命周期</small></div></div><label><span><strong>保留原始录音</strong><small>笔记与转写不会随原始录音删除</small></span><select value={preferences.retentionDays === null ? "forever" : String(preferences.retentionDays)} onChange={(event) => updatePreferences({ ...preferences, retentionDays: event.target.value === "forever" ? null : Number(event.target.value) })}><option value="forever">永久保留</option><option value="30">30 天</option><option value="7">7 天</option><option value="0">转录完成后删除</option></select></label></section>
                <section className="settings-card"><div className="settings-card__title"><Info size={19} /><div><strong>系统权限</strong><small>麦克风与系统音频权限由操作系统管理</small></div></div><div className="settings-card__action"><span>{isElectronRuntime ? "桌面安全环境已启用" : "浏览器预览不会请求桌面权限"}</span><button className="button" onClick={() => api.system.openSettings()}>打开系统设置</button></div></section>
              </div>
            )}
            {tab === "updates" && (
              <div className="update-settings">
                <div className="settings-section-heading">
                  <div><h3>软件更新</h3><p>自动检查新版本并后台下载；macOS 校验签名后原地安装，退出应用即完成升级。</p></div>
                </div>
                <div className={`update-card update-card--${updateState?.status || "idle"}`}>
                  <div className="update-card__icon">
                    {updateState?.status === "available"
                      ? <CloudArrowDown size={28} weight="duotone" />
                      : <CheckCircle size={28} weight="duotone" />}
                  </div>
                  <div className="update-card__body">
                    <span className="update-card__eyebrow">当前版本 {updateState?.currentVersion || "读取中…"}</span>
                    <h4>{updateState?.status === "available"
                      ? `新版本 ${updateState.update?.version} 可用`
                      : updateState?.status === "error"
                        ? "暂时无法检查更新"
                        : updateState?.status === "up-to-date"
                          ? "已经是最新版本"
                          : "保持MinuteFlow为最新版本"}</h4>
                    <p>{updateState?.message || "应用启动后会静默检查一次，你也可以随时手动检查。"}</p>
                    {updateState?.update?.notes && updateState.status === "available" && (
                      <div className="update-notes">
                        <strong>本次更新</strong>
                        <p>{updateState.update.notes}</p>
                      </div>
                    )}
                    {updateState?.checkedAt && (
                      <small>上次检查：{new Date(updateState.checkedAt).toLocaleString("zh-CN")}</small>
                    )}
                  </div>
                </div>
                {downloadState && (
                  <div className={`update-progress update-progress--${downloadState.status}`} role="status" aria-live="polite">
                    <div className="update-progress__track">
                      <span style={{ width: `${downloadState.status === "downloading" ? downloadPercent : downloadState.status === "cancelled" ? 0 : 100}%` }} />
                    </div>
                    <small>{downloadLabel}</small>
                  </div>
                )}
                <div className="update-actions">
                  <button className="button" disabled={checkingUpdate} onClick={checkUpdate}>
                    <ArrowClockwise size={16} className={checkingUpdate ? "spin" : ""} />
                    {checkingUpdate ? "正在检查" : "检查更新"}
                  </button>
                  {updateReadyVersion ? (
                    <>
                      <button
                        className="button button--primary"
                        disabled={recordingActive || installingUpdate}
                        onClick={restartToUpdate}
                      >
                        <ArrowClockwise size={16} className={installingUpdate ? "spin" : ""} />
                        {installingUpdate ? "正在更新…" : `立即重启并更新到 ${updateReadyVersion}`}
                      </button>
                      {recordingActive && <small className="update-actions__note">录音进行中：退出应用后也会自动安装新版本</small>}
                    </>
                  ) : updateState?.status === "available" && (
                    <>
                      <button
                        className="button button--primary"
                        disabled={downloadBusy || downloadState?.status === "downloading"}
                        onClick={downloadUpdate}
                      >
                        <DownloadSimple size={16} />
                        {downloadState?.status === "downloading" ? `正在下载 ${downloadPercent}%` : "下载并安装"}
                      </button>
                      {downloadState?.status === "downloading" && (
                        <button className="text-button" onClick={cancelUpdateDownload}>取消下载</button>
                      )}
                      <button className="text-button" onClick={openUpdateDownload}>从官网下载</button>
                    </>
                  )}
                </div>
                <div className="update-security-note">
                  <CheckCircle size={17} weight="fill" />
                  <p>{updateInstallHint}</p>
                </div>
              </div>
            )}
          </div>
          </main>
        </div>
      </div>
      {/* 删除档案 / 删除密钥的应用内确认：与设置弹窗同源渲染，退场动画一致。 */}
      <ConfirmDialog open={profileConfirm.open} request={profileConfirm.request} onSettle={profileConfirm.settle} />
    </div>
  );
}

/** 在线模型库的分组标题：多语言推荐 / 轻量量化 / 英文专用。 */
// 只列 Whisper 目录分组；diarization 组在声纹设置页单独渲染，不进这份标签。
const MODEL_GROUP_LABELS: Partial<Record<DownloadableModel["group"], string>> = {
  multilingual: "多语言 · 推荐",
  quantized: "轻量量化",
  english: "英文专用"
};

/** 默认只呈现三个可理解的性能档位；完整官方目录仍保留在高级展开区。 */
type RecommendedLocalModel = { id: string; badge: string; guidance: string };
const RECOMMENDED_LOCAL_MODELS: readonly RecommendedLocalModel[] = [
  { id: "ggml-base", badge: "轻量入门", guidance: "体积小，适合旧电脑或先快速体验。" },
  { id: "ggml-small", badge: "日常推荐", guidance: "中文与中英混合会议的均衡选择。" },
  { id: "ggml-large-v3-turbo-q5_0", badge: "准确优先", guidance: "更高准确率，仍保持较合理的体积。" }
];

/**
 * 声纹簿管理（本地说话人识别名单）：列出已记住的发言人，支持簿内改名与忘记。
 * 声纹向量只存在主进程数据库，这里只展示姓名与样本份数；
 * 在会议转写里给「发言人N」改名会自动从本场音频学习并加入这里。
 * 改名/忘记都只影响后续会议的自动命名，历史转写保持原样。
 */
function VoiceprintBookCard() {
  const [people, setPeople] = useState<VoiceprintPerson[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const voiceprintConfirm = useConfirmDialog();

  const refresh = () => api.voiceprints.list()
    .then(setPeople)
    .catch(() => setPeople([]));

  useEffect(() => { void refresh(); }, []);

  const renamePerson = async (from: string, to: string) => {
    const target = to.trim();
    if (!target || target === from) { setRenaming(null); return; }
    try {
      const result = await api.voiceprints.rename(from, target);
      setMessage(`已改名为“${target}”（${result.sampleCount} 份声纹），之后会议将按新名字自动识别。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "改名失败。");
    } finally {
      setRenaming(null);
    }
  };

  const forgetPerson = async (name: string) => {
    if (!(await voiceprintConfirm.confirm({
      title: `忘记“${name}”的声纹？`,
      body: "只删除本机保存的声纹样本，历史会议中的姓名不会改变。",
      confirmLabel: "忘记声纹"
    }))) return;
    try {
      await api.voiceprints.forget(name);
      setMessage(`已忘记“${name}”的声纹。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败。");
    }
  };

  return (
    <section className="settings-card settings-card--stacked">
      <div className="settings-card__title">
        <FingerprintSimple size={19} />
        <div>
          <strong>声纹簿</strong>
          <small>记住的发言人 · 全部保存在本机</small>
        </div>
      </div>
      {message && <p className="settings-hint" role="status">{message}</p>}
      {people.length ? people.map((person) => (
        <div className="settings-card__action" key={person.name}>
          {renaming === person.name ? (
            <FingerprintSimple size={15} weight="fill" />
          ) : (
            <FingerprintSimple size={15} />
          )}
          {renaming === person.name ? (
            <input
              autoFocus
              className="voiceprint-rename-input"
              defaultValue={person.name}
              aria-label={`为 ${person.name} 输入新名字`}
              onKeyDown={(event) => {
                if (event.key === "Enter") void renamePerson(person.name, event.currentTarget.value);
                if (event.key === "Escape") setRenaming(null);
              }}
              onBlur={(event) => void renamePerson(person.name, event.target.value)}
            />
          ) : (
            <span className="voiceprint-person">
              <strong>{person.name}</strong>
              <small>{person.sampleCount} 份声纹样本</small>
            </span>
          )}
          <span className="voiceprint-person-actions">
            <button className="text-button" onClick={() => { setRenaming(person.name); setMessage(""); }}>改名</button>
            <button className="text-button" onClick={() => void forgetPerson(person.name)}>忘记</button>
          </span>
        </div>
      )) : (
        <p className="settings-hint">
          还没有记住任何人。开启说话人分离后，在会议转写里点击「发言人N」改名，MinuteFlow
          会自动从本场音频学习 TA 的声纹；之后多人会议会自动标注 TA 的名字，认不准时仍用「发言人N」占位。
        </p>
      )}
      <ConfirmDialog open={voiceprintConfirm.open} request={voiceprintConfirm.request} onSettle={voiceprintConfirm.settle} />
    </section>
  );
}

/**
 * 声纹识别零路径配置（与本地 Whisper 同一套体验）：
 * 引擎（sherpa-onnx）应用内置、无需安装；两个模型各提供「应用内下载（推荐）/ 检测本机 /
 * 选择文件」三条路径，就绪即自动写入档案并启用——全程没有路径输入框。
 * 手动路径与聚类阈值收进折叠的高级区（故障排除兜底）。
 */
function DiarizationSetup({
  profile,
  onChange,
  onCommit
}: {
  profile: ModelProfile;
  onChange(profile: ModelProfile): void;
  /** 高级字段失焦时直接落库（本机档案没有底栏保存）。 */
  onCommit?(profile: ModelProfile): void;
}) {
  const [catalog, setCatalog] = useState<DownloadableModel[]>([]);
  const [scan, setScan] = useState<DiarizationScanResult | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);

  const slotOf = (modelId: string) => modelId.includes("segmentation") ? "segmentation" : "embedding";

  useEffect(() => {
    let active = true;
    api.models.catalog()
      .then((items) => active && setCatalog(items.filter((item) => item.group === "diarization")))
      .catch(() => {});
    const unsubscribe = api.models.onDownloadProgress((next) => setProgress(next));
    return () => { active = false; unsubscribe(); };
  }, []);

  /** 把一个模型文件就位到对应槽位：写入档案、启用，两个槽位都齐时提示就绪。 */
  const applySlot = async (slot: "segmentation" | "embedding", file: { path: string; name: string }) => {
    const key = slot === "segmentation" ? "segmentationModelPath" : "embeddingModelPath";
    const saved = await api.models.save({
      ...profile,
      kind: "diarization",
      transport: "sherpa-onnx",
      name: "本地声纹识别",
      enabled: true,
      options: { ...profile.options, [key]: file.path }
    });
    onChange(saved);
    await loadProfiles();
    setMessage(saved.options.segmentationModelPath && saved.options.embeddingModelPath
      ? "声纹识别已就绪：之后多人会议会自动区分发言人并记住名字。"
      : `「${file.name}」已就绪，还差另一个模型。`);
  };

  /** 检测本机已有的分离/声纹模型；每个槽位自动套用最优先命中（托管目录优先）。 */
  const detectModels = async (silent = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const found = await api.models.scanDiarization();
      setScan(found);
      const catalogNow = catalog.length ? catalog : await api.models.catalog();
      const apply: Array<Promise<void>> = [];
      for (const slot of ["segmentation", "embedding"] as const) {
        const key = slot === "segmentation" ? "segmentationModelPath" : "embeddingModelPath";
        if (profile.options[key]) continue;
        const managed = catalogNow.find((item) => item.group === "diarization" && item.installed && item.localPath && slotOf(item.id) === slot);
        const hit = managed?.localPath
          ? { path: managed.localPath, name: managed.fileName }
          : found[slot][0];
        if (hit) apply.push(applySlot(slot, hit));
      }
      await Promise.all(apply);
      if (!apply.length && !silent) setMessage("本机没有找到可用的分离/声纹模型，建议直接下载（约 70MB）。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "检测失败。");
    } finally {
      setBusy(false);
    }
  };

  /** 手动选择 .onnx 文件（高级兜底）：按文件名判断槽位。 */
  const chooseModel = async () => {
    setMessage(null);
    try {
      const model = await api.models.chooseLocal("diarization");
      if (!model) return;
      const slot = /seg|pyannote/i.test(model.name ?? "") ? "segmentation" : "embedding";
      await applySlot(slot, { path: model.path, name: model.name });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法打开模型文件。");
    }
  };

  /** 应用内下载模型：校验摘要后自动就位到对应槽位。 */
  const downloadSlot = async (modelId: string) => {
    setBusy(true);
    setMessage(null);
    setProgress({ modelId, downloadedBytes: 0, totalBytes: 0, status: "preparing", message: "正在准备下载…" });
    try {
      const model = await api.models.download(modelId);
      await applySlot(slotOf(modelId), { path: model.path, name: model.name });
      setCatalog(await api.models.catalog());
    } catch (error) {
      setProgress({ modelId, downloadedBytes: 0, totalBytes: 0, status: "error", message: "下载中断，可重试。" });
      setMessage(error instanceof Error ? error.message : "模型下载失败，可重试。");
    } finally {
      setBusy(false);
    }
  };

  const renderSlotCard = (model: DownloadableModel) => {
    const slot = slotOf(model.id);
    const activePath = slot === "segmentation" ? profile.options.segmentationModelPath : profile.options.embeddingModelPath;
    const currentProgress = progress?.modelId === model.id ? progress : null;
    const percent = currentProgress?.totalBytes
      ? Math.min(100, Math.round(currentProgress.downloadedBytes / currentProgress.totalBytes * 100))
      : 0;
    return (
      <div className="download-model-card" key={model.id}>
        <div>
          <strong>{model.name}</strong>
          <small>{model.description}</small>
          <span>{model.format} · {formatBytes(model.sizeBytes)} · {model.license}</span>
        </div>
        {activePath ? (
          <button className="button button--small" disabled><CheckCircle size={15} weight="fill" />已就绪</button>
        ) : model.installed && model.localPath ? (
          <button className="button button--small" disabled={busy} onClick={() => void applySlot(slot, { path: model.localPath!, name: model.fileName })}>已下载 · 使用</button>
        ) : (
          <button className="button button--small" disabled={busy} onClick={() => void downloadSlot(model.id)}>
            <CloudArrowDown size={15} />
            {currentProgress
              ? currentProgress.status === "downloading" ? `${percent}%`
              : currentProgress.status === "verifying" ? "校验中"
              : currentProgress.status === "ready" ? "启用中"
              : currentProgress.status === "error" ? "重试" : "准备中"
              : "下载"}
          </button>
        )}
        {currentProgress && <>
          <progress max="100" value={currentProgress.status === "ready" ? 100 : percent} aria-label={`${model.name} 下载进度`} />
          {currentProgress.message && <small>{currentProgress.message}</small>}
        </>}
      </div>
    );
  };

  return (
    <section className="local-model-manager diarization-setup">
      <div className="local-model-manager__heading">
        <div>
          <strong>声纹引擎已内置</strong>
          <small>sherpa-onnx 随应用安装，无需额外配置；补齐两个模型即可开始。</small>
        </div>
        <div className="local-model-actions">
          <button className="button button--small" disabled={busy} onClick={() => void detectModels()}><MagnifyingGlass size={15} />检测本机</button>
          <button className="button button--small" disabled={busy} onClick={() => void chooseModel()}><FolderOpen size={15} />选择文件</button>
        </div>
      </div>
      {message && <p className="settings-hint" role="status">{message}</p>}
      {scan && (scan.segmentation.length > 0 || scan.embedding.length > 0) && (
        <div className="local-model-list">
          {[...scan.segmentation.map((file) => ({ ...file, slot: "segmentation" as const })),
            ...scan.embedding.map((file) => ({ ...file, slot: "embedding" as const }))].map((file) => (
            <button
              key={file.path}
              disabled={busy}
              onClick={() => void applySlot(file.slot, file)}
            >
              <FingerprintSimple size={18} weight="duotone" />
              <span><strong>{file.name}</strong><small>{file.slot === "segmentation" ? "分离模型" : "声纹模型"} · {formatBytes(file.sizeBytes)}</small></span>
            </button>
          ))}
        </div>
      )}
      <div className="local-model-library-heading">
        <strong>推荐模型（共两个，都需下载）</strong>
        <small>下载后自动校验并启用，官方源连不上会自动换镜像</small>
      </div>
      <div className="recommended-model-list">
        {catalog.map((model) => renderSlotCard(model))}
      </div>
      <details className="advanced-provider-options">
        <summary>高级与故障排除</summary>
        <div className="field"><span>说明</span><div className="readonly-control">模型损坏或需要使用特殊版本时，可在此手动指定文件路径；聚类阈值控制「切成几个说话人」的灵敏度，默认 0.5 适合大多数会议。</div></div>
        <label className="field"><span>分离模型路径</span><input value={profile.options.segmentationModelPath || ""} onChange={(event) => onChange({ ...profile, options: { ...profile.options, segmentationModelPath: event.target.value } })} onBlur={() => onCommit?.(profile)} spellCheck={false} /></label>
        <label className="field"><span>声纹模型路径</span><input value={profile.options.embeddingModelPath || ""} onChange={(event) => onChange({ ...profile, options: { ...profile.options, embeddingModelPath: event.target.value } })} onBlur={() => onCommit?.(profile)} spellCheck={false} /></label>
        <label className="field"><span>聚类阈值</span><input type="number" min="0.1" max="0.9" step="0.01" value={profile.options.clusteringThreshold ?? 0.5} onChange={(event) => onChange({ ...profile, options: { ...profile.options, clusteringThreshold: Number(event.target.value) } })} onBlur={() => onCommit?.(profile)} /></label>
      </details>
    </section>
  );
}

/**
 * 本地 Whisper 模型管理器（零路径配置）：搜索本机 / 选择文件 / 应用内下载三条路径。
 * 全程不暴露可执行文件、模型或 FFmpeg 路径——运行时组件由主进程托管解析；
 * 下载走「校验过的目录 + SHA 摘要」，就绪后自动写入档案并启用。
 * 下载源（官方 / 镜像 / 自定义）存全局偏好，换源不影响摘要校验；
 * 目录之外还支持粘贴直链下载（无官方摘要，明确提示不校验）。
 */
function LocalModelManager({
  profile,
  onChange
}: {
  profile: ModelProfile;
  onChange(profile: ModelProfile): void;
}) {
  /** 可下载模型目录（主进程 catalog 通道）。 */
  const [catalog, setCatalog] = useState<DownloadableModel[]>([]);
  /** 本机扫描结果（发现的模型 + 可用运行时）。 */
  const [scan, setScan] = useState<LocalModelScanResult | null>(null);
  /** 订阅到的下载进度事件。 */
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  /** 自定义直链输入框内容。 */
  const [customUrl, setCustomUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);
  const preferences = useMeetingStore((state) => state.preferences);
  const updatePreferences = useMeetingStore((state) => state.updatePreferences);
  /** 本机芯片/内存：目录里的推荐徽标与「内存不足」提示都按它计算。 */
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);

  // 挂载时拉取目录并订阅主进程的下载进度推送。
  useEffect(() => {
    let active = true;
    api.models.catalog().then((items) => active && setCatalog(items)).catch(() => {});
    api.system.hardware().then((info) => active && setHardware(info)).catch(() => {});
    const unsubscribe = api.models.onDownloadProgress((next) => setProgress(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  /** 把一个本地模型文件启用为 stt 档案：按文件类型自动切换 transport（whisper-cpp/python 等）。 */
  const applyModel = async (model: LocalModelFile, runtimes = scan?.runtimes) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const selectedModelName = model.name.replace(/\.(?:pt|bin|gguf)$/i, "");
      const nextProfile: ModelProfile = {
      ...profile,
      kind: "stt",
      transport: model.engine,
      name: localProfileName({ ...profile, transport: model.engine, model: selectedModelName } as ModelProfile),
      model: selectedModelName,
      enabled: true,
      options: {
        ...profile.options,
        modelPath: model.path,
        // Runtime locations are resolved in the Electron main process. Keep
        // legacy values intact for upgraded profiles, but never create new
        // user-managed path settings from the renderer.
      }
      };
      const saved = await api.models.save(nextProfile);
      onChange(saved);
      await loadProfiles();
      const runtimeReady = model.engine === "whisper-cpp"
        ? Boolean(runtimes?.managedWhisper || runtimes?.whisperCpp)
        : Boolean(runtimes?.python);
      setSuccess(runtimeReady
        ? `已启用 ${model.name}，后续会议将使用此模型转写。`
        : `已启用 ${model.name}；应用会在转写前自动检查所需组件。`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "无法启用本地模型");
    } finally {
      setBusy(false);
    }
  };

  /** 搜索本机常见目录；恰好只发现一个模型时直接启用，省去一次点击。 */
  const scanModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.models.scanLocal();
      setScan(result);
      if (result.models.length === 1) await applyModel(result.models[0], result.runtimes);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "本地模型搜索失败");
    } finally {
      setBusy(false);
    }
  };

  /** 手动选择模型文件（高级兜底，仍是文件选择器而非手填路径）。 */
  const chooseModel = async () => {
    setError(null);
    try {
      const model = await api.models.chooseLocal();
      if (model) {
        const discovery = scan ?? await api.models.scanLocal();
        setScan(discovery);
        await applyModel(model, discovery.runtimes);
      }
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : "无法打开模型文件");
    }
  };

  /** 应用内下载模型：完成后重新扫描并自动启用。 */
  const downloadModel = async (modelId: string) => {
    setBusy(true);
    setError(null);
    setProgress({ modelId, downloadedBytes: 0, totalBytes: 0, status: "preparing", message: "正在准备转写组件…" });
    try {
      const model = await api.models.download(modelId);
      const discovery = await api.models.scanLocal();
      setScan(discovery);
      await applyModel(model, discovery.runtimes);
      setCatalog(await api.models.catalog());
    } catch (downloadError) {
      const message = downloadError instanceof Error ? downloadError.message : "模型下载失败";
      setProgress({ modelId, downloadedBytes: 0, totalBytes: 0, status: "error", message: "准备失败，可重试。" });
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 从自定义直链下载模型（目录之外的兜底入口）：主进程校验扩展名后下载，
   * 无官方摘要故不做完整性校验；完成后与目录下载一致扫描并自动启用。
   */
  const downloadFromLink = async () => {
    const url = customUrl.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const model = await api.models.downloadFromUrl(url);
      const discovery = await api.models.scanLocal();
      setScan(discovery);
      await applyModel(model, discovery.runtimes);
      setCustomUrl("");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "模型下载失败");
    } finally {
      setBusy(false);
    }
  };

  // 运行时就绪徽标文案（托管 whisper / 兼容 whisper.cpp / Python / CT2 / MLX / FFmpeg）。
  const runtimeLabels: string[] = scan
    ? [
        scan.runtimes.managedWhisper && "本地转写组件已就绪",
        !scan.runtimes.managedWhisper && scan.runtimes.whisperCpp && "兼容转写组件已就绪",
        scan.runtimes.python && "兼容模型运行环境已就绪",
        scan.runtimes.fasterWhisper && "faster-whisper 已就绪",
        scan.runtimes.mlxWhisper && "mlx-whisper 已就绪",
        scan.runtimes.ffmpeg && "音频处理组件已就绪"
      ].filter((label): label is string => typeof label === "string")
    : [];

  const renderDownloadModelCard = (model: DownloadableModel, recommendation?: typeof RECOMMENDED_LOCAL_MODELS[number]) => {
    const currentProgress = progress?.modelId === model.id ? progress : null;
    const percent = currentProgress?.totalBytes
      ? Math.min(100, Math.round(currentProgress.downloadedBytes / currentProgress.totalBytes * 100))
      : 0;
    // 设备感知：与这台机器内存匹配的模型标「按你的设备推荐」，超出档位的提示内存不足。
    const memoryGB = hardware ? hardware.memoryBytes / 1024 ** 3 : 0;
    const fit = memoryGB > 0 ? whisperModelFit(model.id, memoryGB) : null;
    const deviceBest = fit === "best";
    const tooHeavy = fit === "heavy";
    const minRamGB = WHISPER_MODEL_MIN_RAM_GB[model.id];
    const badge = deviceBest ? "按你的设备推荐" : recommendation?.badge;
    const guidance = deviceBest && hardware
      ? `${formatHardwareLine(hardware)}运行这款最合适。`
      : recommendation?.guidance || model.description;
    return (
      <div className={`download-model-card ${recommendation || deviceBest ? "download-model-card--recommended" : ""}`} key={model.id}>
        <div>
          {badge && <em className={deviceBest ? "is-device" : undefined}>{badge}</em>}
          {tooHeavy && <em className="is-heavy">内存不足</em>}
          <strong>{model.name}</strong>
          <small>{guidance}</small>
          <span>{model.format} · {formatBytes(model.sizeBytes)} · {model.license}{describeRuntimeMemory(model.sizeBytes) && ` · ${describeRuntimeMemory(model.sizeBytes)}`}{tooHeavy && minRamGB ? ` · 建议 ${minRamGB}GB 内存以上` : ""}</span>
        </div>
        {model.installed && model.localPath ? (
          <button className="button button--small" disabled={busy} onClick={async () => {
            const discovery = scan ?? await api.models.scanLocal();
            setScan(discovery);
            await applyModel({ path: model.localPath!, name: model.fileName, format: model.format, engine: model.engine as LocalModelFile["engine"], sizeBytes: model.sizeBytes }, discovery.runtimes);
          }}>{profile.options.modelPath === model.localPath ? "使用中" : "已下载 · 使用"}</button>
        ) : (
          <button className="button button--small" disabled={busy} onClick={() => downloadModel(model.id)}><CloudArrowDown size={15} />{currentProgress ? (currentProgress.status === "downloading" ? `${percent}%` : currentProgress.status === "verifying" ? "校验中" : currentProgress.status === "ready" ? "已就绪" : currentProgress.status === "error" ? "重试" : "准备中") : "下载"}</button>
        )}
        {currentProgress && <>
          <progress max="100" value={currentProgress.status === "ready" ? 100 : percent} aria-label={`${model.name} 下载进度`} />
          {currentProgress.message && <small>{currentProgress.message}</small>}
        </>}
      </div>
    );
  };

  return (
    <section className="local-model-manager">
      <div className="local-model-manager__heading">
        <div><strong>本地模型</strong><small>自动查找常见目录，也可以选择文件或直接下载。</small></div>
        <div className="local-model-actions">
          <button className="button button--small" disabled={busy} onClick={scanModels}><MagnifyingGlass size={15} />搜索本机</button>
          <button className="button button--small" disabled={busy} onClick={chooseModel}><FolderOpen size={15} />选择文件</button>
        </div>
      </div>
      {hardware && (
        <div className="device-info-line" role="note">
          <Cpu size={14} weight="duotone" />
          <span>检测到 {formatHardwareLine(hardware)}，推荐与提示已按内存计算</span>
        </div>
      )}
      {runtimeLabels.length > 0 && <div className="runtime-chips">{runtimeLabels.map((label) => <span key={label}>{label}</span>)}</div>}
      {scan && (
        <div className="local-model-list">
          {scan.models.length ? scan.models.map((model) => (
            <button key={model.path} disabled={busy} className={profile.options.modelPath === model.path ? "is-selected" : ""} onClick={() => void applyModel(model, scan.runtimes)}>
              <Cpu size={18} weight="duotone" />
              <span><strong>{model.name}</strong><small>{model.format} · {formatBytes(model.sizeBytes)}</small></span>
              {profile.options.modelPath === model.path && <CheckCircle size={17} weight="fill" />}
            </button>
          )) : <p className="local-model-empty">本机暂未找到模型，可从下方选择一个下载。</p>}
        </div>
      )}
      <div className="local-model-library-heading">
        <strong>推荐模型</strong>
        <small>已按本机内存标注最适合的款；下载后自动校验并启用</small>
      </div>
      <div className="recommended-model-list">
        {(() => {
          // 首屏三档随设备微调：本机内存的最优款不在固定三档时顶替「准确优先」位，
          // 保证「按你的设备推荐」在默认视图就可见，而不是藏在全部模型展开区里。
          const memoryGB = hardware ? hardware.memoryBytes / 1024 ** 3 : 0;
          const deviceBestId = memoryGB > 0 ? recommendWhisperModelId(memoryGB) : null;
          const featured = !deviceBestId || RECOMMENDED_LOCAL_MODELS.some((item) => item.id === deviceBestId)
            ? RECOMMENDED_LOCAL_MODELS
            : [
                RECOMMENDED_LOCAL_MODELS[0],
                RECOMMENDED_LOCAL_MODELS[1],
                { id: deviceBestId, badge: "按你的设备推荐", guidance: hardware ? `${formatHardwareLine(hardware)}运行这款最合适。` : "" }
              ];
          return featured.map((recommendation) => {
            const model = catalog.find((item) => item.id === recommendation.id);
            return model ? renderDownloadModelCard(model, recommendation) : null;
          });
        })()}
      </div>
      <details className="local-model-catalog-details">
        <summary>
          <span><strong>浏览全部模型与下载选项</strong><small>{catalog.filter((item) => item.group !== "diarization").length} 款官方模型、量化版、英文专用与自定义直链</small></span>
          <CaretDown size={16} />
        </summary>
        <div className="local-model-catalog-details__body">
          <div className="download-source-row">
            <label>
              <span><strong>下载源</strong><small>官方源连不上时会自动尝试另一个预设源</small></span>
              <select
                value={preferences.modelDownloadSourceKind}
                onChange={(event) => updatePreferences({ ...preferences, modelDownloadSourceKind: event.target.value as "official" | "mirror" | "custom" })}
              >
                <option value="official">Hugging Face 官方</option>
                <option value="mirror">hf-mirror.com（国内镜像）</option>
                <option value="custom">自定义源…</option>
              </select>
            </label>
            {preferences.modelDownloadSourceKind === "custom" && (
              <label>
                <span><strong>自定义源地址</strong><small>需与 HuggingFace 下载地址格式兼容，或提供含 {("{fileName}")} 占位符的链接模板</small></span>
                <input
                  value={preferences.modelDownloadCustomBase}
                  onChange={(event) => updatePreferences({ ...preferences, modelDownloadCustomBase: event.target.value })}
                  placeholder="https://hf.example.com 或 https://example.com/models/{fileName}"
                  spellCheck={false}
                />
              </label>
            )}
          </div>
          <div className="download-model-list">
            {(Object.keys(MODEL_GROUP_LABELS) as Array<DownloadableModel["group"]>).map((group) => (
              <div className="download-model-group" key={group}>
                <small className="download-model-group__label">{MODEL_GROUP_LABELS[group]}</small>
                {catalog.filter((model) => model.group === group).map((model) => renderDownloadModelCard(model))}
              </div>
            ))}
          </div>
          <div className="download-url-row">
            <div className="download-url-row__heading">
              <strong>从链接下载</strong>
              <small>目录之外的模型可粘贴直链（.bin / .gguf / .pt）。自定义直链不经过完整性校验，请仅使用信任来源。</small>
            </div>
            <div className="download-url-row__controls">
              <input
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !busy && customUrl.trim()) void downloadFromLink(); }}
                placeholder="https://example.com/ggml-base.bin"
                spellCheck={false}
                disabled={busy}
              />
              <button className="button button--small" disabled={busy || !customUrl.trim()} onClick={() => void downloadFromLink()}><CloudArrowDown size={15} />下载</button>
            </div>
            {(() => {
              const customProgress = progress?.modelId.startsWith("custom:") ? progress : null;
              if (!customProgress) return null;
              const percent = customProgress.totalBytes
                ? Math.min(100, Math.round(customProgress.downloadedBytes / customProgress.totalBytes * 100))
                : 0;
              return <>
                <progress max="100" value={customProgress.status === "ready" ? 100 : percent} aria-label="自定义链接下载进度" />
                {customProgress.message && <small>{customProgress.message}</small>}
              </>;
            })()}
          </div>
        </div>
      </details>
      {error && <div className="connection-status is-error">{error}</div>}
      {success && <div className="connection-status is-success">{success}</div>}
    </section>
  );
}

/** 模型体积可读化（GB/MB）。 */
function formatBytes(bytes: number) {
  if (!bytes) return "未知大小";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
