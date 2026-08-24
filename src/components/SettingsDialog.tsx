/**
 * 设置工作台：左侧分类导航 + 中栏二级服务目录 + 右侧配置面板。
 * 五个标签页：AI 总结（llm）、转录设置（stt）、通用设置、存储与隐私、软件更新（仅 macOS）。
 * AI 总结/转录页共用「模型目录 + 档案编辑器」结构：本地（Ollama/本地 Whisper 零路径配置）与
 * 在线服务预设（国内外厂商 + New API 网关）一键预填端点/接口格式/推荐模型，通常只需填密钥。
 * 实际的模型调用与本地运行时解析在 electron/services/providers.mjs 与 local-models.mjs。
 */
import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  CloudArrowDown,
  Cpu,
  Database,
  GearSix,
  DownloadSimple,
  FolderOpen,
  HardDrives,
  Info,
  Key,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Trash,
  Waveform,
  X
} from "@phosphor-icons/react";
import { api, isElectronRuntime } from "../lib/api";
import { useMeetingStore } from "../store/meetingStore";
import type {
  DownloadableModel,
  LocalModelFile,
  LocalModelScanResult,
  ModelDownloadProgress,
  ModelProfile,
  AppUpdateCheckResult
} from "../types";

/** 四种本地 Whisper 运行时（whisper.cpp GGML/GGUF、Python .pt、CT2、MLX）统一呈现为一个「本地 Whisper」。 */
const LOCAL_WHISPER_TRANSPORTS = ["whisper-cpp", "whisper-python", "faster-whisper", "mlx-whisper"] as const;
const isLocalWhisperTransport = (transport: string | undefined) =>
  !!transport && (LOCAL_WHISPER_TRANSPORTS as readonly string[]).includes(transport);
/** 新建档案的空白模板（自定义服务从这里开始）。 */
const emptyProfile: ModelProfile = {
  name: "OpenAI 兼容模型",
  kind: "llm",
  transport: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
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
    model: "glm-5.2"
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
    model: "MiniMax-M2.7",
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
    name: "本地 sherpa-onnx",
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

export function SettingsDialog({ open, initialTab, onClose }: { open: boolean; initialTab?: SettingsTab; onClose(): void }) {
  const profiles = useMeetingStore((state) => state.profiles);
  const preferences = useMeetingStore((state) => state.preferences);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);
  const updatePreferences = useMeetingStore((state) => state.updatePreferences);
  /** 当前设置页。 */
  const [tab, setTab] = useState<SettingsTab>("transcription");
  /** 正在编辑的模型档案（目录选中项或新建草稿）。 */
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  /** 密钥输入框的明文值（保存后只留 secretId 引用，不回显）。 */
  const [apiKey, setApiKey] = useState("");
  /** 测试/保存的结果反馈。 */
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // 打开设置时刷新档案列表。
  useEffect(() => {
    if (open) loadProfiles();
  }, [loadProfiles, open]);

  // 指定初始页时（如更新提示 Toast 直达「软件更新」），打开瞬间切到该页。
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // 切到 AI 总结/转录页时，为编辑器选一个初始档案：
  // 优先取该用途已保存的第一个档案，否则落回默认预设（OpenAI / 本地 Whisper）。
  useEffect(() => {
    if (!open || (tab !== "llm" && tab !== "transcription")) return;
    const targetKind: ModelProfile["kind"] = tab === "llm" ? "llm" : "stt";
    if (editing?.kind === targetKind) return;
    const saved = profiles.find((profile) => profile.kind === targetKind);
    if (saved) {
      setEditing(normalizeLegacyProviderProfile(saved));
      return;
    }
    const preset = tab === "llm" ? providerPresets.openai : providerPresets.whisper;
    setEditing({
      ...emptyProfile,
      ...preset,
      options: { ...emptyProfile.options, ...(preset.options ?? {}) }
    });
  }, [editing, open, profiles, tab]);

  // 进入「软件更新」页时读取主进程缓存的更新状态（启动时已静默检查过一次）。
  useEffect(() => {
    if (!open || tab !== "updates") return;
    api.updates.getState().then(setUpdateState).catch((error) => {
      setUpdateState({
        status: "error",
        currentVersion: "",
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "无法读取更新状态。"
      });
    });
  }, [open, tab]);
  if (!open) return null;

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
  };

  /** 保存档案：密钥随请求送到主进程安全存储，渲染层不再持有明文。 */
  const saveProfile = async () => {
    if (!editing) return;
    setBusy(true);
    setStatus(null);
    try {
      const saved = await api.models.save(editing, apiKey || undefined);
      await loadProfiles();
      setEditing(saved);
      setApiKey("");
      setStatus("配置已安全保存。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  /** 测试连接：主进程对所选端点发一次最小请求（见 providers.mjs 的 testModelProfile）。 */
  const testProfile = async () => {
    if (!editing) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.models.test(editing, apiKey || undefined);
      if (result.visualSummaryVerifiedAt && result.visualSummaryVerifiedFingerprint) {
        const verified: ModelProfile = {
          ...editing,
          options: {
            ...editing.options,
            visualSummaryVerifiedAt: result.visualSummaryVerifiedAt,
            visualSummaryVerifiedFingerprint: result.visualSummaryVerifiedFingerprint
          }
        };
        const saved = await api.models.save(verified, apiKey || undefined);
        setEditing(saved);
        setApiKey("");
        await loadProfiles();
      }
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "连接失败");
    } finally {
      setBusy(false);
    }
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

  /** 打开官网下载页（未签名阶段不自动安装，只引导到稳定下载地址）。 */
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

  /** 安装提示按平台区分：macOS 拖入应用程序，Windows 直接运行安装程序。 */
  const updateInstallHint = api.system.platform === "win32"
    ? "应用只接受 HTTPS 官网清单和官方发布地址。下载 MinuteFlow-Setup.exe 后直接运行，安装程序会自动完成升级。"
    : api.system.platform === "darwin"
      ? "应用只接受 HTTPS 官网清单和官方发布地址。下载完成后，请打开 DMG 并将新版本拖入“应用程序”。"
      : "应用只接受 HTTPS 官网清单和官方发布地址。";

  // 用名称+transport 反查当前档案命中的预设（驱动下拉框回显）；pythonWhisper 归并为统一的 whisper 预设。
  const matchedPresetKey = editing
    ? Object.entries(providerPresets).find(([, preset]) => preset.name === editing.name && preset.transport === editing.transport)?.[0] ?? ""
    : "";
  const activePresetKey = matchedPresetKey === "pythonWhisper" ? "whisper" : matchedPresetKey;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog settings-dialog">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <div className="settings-nav__title">
              <span>设置</span>
              <small>MinuteFlow</small>
            </div>
            <div className="settings-nav__group">
              <span className="settings-nav__label">应用</span>
              <button className={tab === "general" ? "is-active" : ""} onClick={() => setTab("general")}><GearSix size={18} />通用设置</button>
              <button className={tab === "llm" ? "is-active" : ""} onClick={() => setTab("llm")}><Sparkle size={18} />AI 总结</button>
              <button className={tab === "transcription" ? "is-active" : ""} onClick={() => setTab("transcription")}><Waveform size={18} />转录设置</button>
              <button className={tab === "storage" ? "is-active" : ""} onClick={() => setTab("storage")}><ShieldCheck size={18} />存储与隐私</button>
            </div>
            <div className="settings-nav__group settings-nav__group--bottom">
              <span className="settings-nav__label">关于</span>
            {api.system.platform === "darwin" && (
              <button className={tab === "updates" ? "is-active" : ""} onClick={() => setTab("updates")}><ArrowClockwise size={18} />软件更新</button>
            )}
              <div className="settings-nav__privacy"><ShieldCheck size={15} weight="fill" /><span>本地优先<br /><small>你的会议数据默认留在本机</small></span></div>
            </div>
          </nav>
          <main className="settings-main">
            <header className="settings-header">
              <div className="settings-breadcrumb"><span>设置</span><CaretRight size={14} /><strong>{tab === "llm" ? "AI 总结" : tab === "transcription" ? "转录设置" : tab === "general" ? "通用设置" : tab === "storage" ? "存储与隐私" : "软件更新"}</strong></div>
              <button className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
            </header>
          <div className={`settings-content ${(tab === "llm" || tab === "transcription") ? "settings-content--models" : `settings-content--${tab}`}`}>
            {(tab === "llm" || tab === "transcription") && (
              <div className="model-settings">
                <aside className="model-catalog">
                  <div className="model-catalog__heading"><div><h3>{tab === "llm" ? "总结服务" : "转录服务"}</h3><p>{tab === "llm" ? "选择会议内容的整理方式" : "选择声音转文字的方式"}</p></div><button className="icon-button" onClick={startCustomProfile} aria-label={tab === "llm" ? "添加自定义总结服务" : "添加自定义转录服务"}><Plus size={16} /></button></div>
                  <div className="model-catalog__section"><span>在本机运行</span>
                    {tab === "llm" ? (
                      <>
                        <button className={editing?.transport === "local-summary" ? "is-selected" : ""} onClick={() => startPreset("localSummary")}><span className="profile-icon"><Sparkle size={18} /></span><span><strong>本机基础纪要</strong><small>完全离线 · 无需配置模型</small></span>{editing?.transport === "local-summary" && <CheckCircle size={16} weight="fill" />}</button>
                        <button className={editing?.name === "Ollama" ? "is-selected" : ""} onClick={() => startPreset("ollama")}><span className="profile-icon">OL</span><span><strong>Ollama</strong><small>数据留在本机 · 需要已安装服务</small></span>{editing?.name === "Ollama" && <CheckCircle size={16} weight="fill" />}</button>
                      </>
                    ) : (
                      <button className={isLocalWhisperTransport(editing?.transport) ? "is-selected" : ""} onClick={() => startPreset("whisper")}><span className="profile-icon"><Waveform size={18} /></span><span><strong>本地 Whisper</strong><small>自动适配 GGML/GGUF、.pt、CT2 与 MLX</small></span>{isLocalWhisperTransport(editing?.transport) && <CheckCircle size={16} weight="fill" />}</button>
                    )}
                  </div>
                  {tab === "llm" ? llmProviderGroups.map((group) => (
                    <div className="model-catalog__section" key={group.label}><span>{group.label}</span>
                      {group.providers.map((provider) => {
                        const preset = providerPresets[provider.key];
                        const selected = editing?.name === preset.name && editing?.transport === preset.transport;
                        return <button key={provider.key} className={selected ? "is-selected" : ""} onClick={() => startPreset(provider.key)}><span className="profile-icon">{provider.icon}</span><span><strong>{provider.name}</strong><small>{provider.description}</small></span>{selected && <CheckCircle size={16} weight="fill" />}</button>;
                      })}
                    </div>
                  )) : <div className="model-catalog__section"><span>在线服务</span><>
                      <button className={editing?.name === "OpenAI Whisper" ? "is-selected" : ""} onClick={() => startPreset("openaiWhisper")}><span className="profile-icon"><Waveform size={18} /></span><span><strong>OpenAI Whisper</strong><small>无需下载本地模型</small></span>{editing?.name === "OpenAI Whisper" && <CheckCircle size={16} weight="fill" />}</button>
                      <button className={editing?.name === "New API 语音转录" ? "is-selected" : ""} onClick={() => startPreset("newApiWhisper")}><span className="profile-icon"><CloudArrowDown size={18} /></span><span><strong>New API</strong><small>OpenAI 音频接口兼容</small></span>{editing?.name === "New API 语音转录" && <CheckCircle size={16} weight="fill" />}</button>
                    </></div>}
                  {!!profiles.length && <div className="model-catalog__section"><span>已保存</span>{profiles.filter((profile) => profile.kind === (tab === "llm" ? "llm" : "stt")).map((profile) => (
                    <button key={profile.id} className={editing?.id === profile.id ? "is-selected" : ""} onClick={() => { setEditing(normalizeLegacyProviderProfile(profile)); setApiKey(""); setStatus(null); }}><span className="profile-icon">{profile.kind === "stt" ? "STT" : profile.kind === "llm" ? "LLM" : "SPK"}</span><span><strong>{profile.name}</strong><small>{profile.model || "尚未选择模型"}</small></span>{profile.enabled && <CheckCircle size={16} weight="fill" />}</button>
                  ))}</div>}
                  <button className="model-catalog__custom" onClick={startCustomProfile}><Plus size={15} />自定义服务</button>
                </aside>
                {editing && (
                  <div className="profile-editor-wrap">
                    <div className="profile-editor-heading">
                      <span className="profile-editor-heading__icon">{editing.kind === "stt" ? <Waveform size={24} /> : <Sparkle size={24} />}</span>
                      <div><h2>{editing.name}</h2><p>{editing.kind === "stt" ? "将会议音频转换为可编辑的中文与多语言文本。" : "用于会议总结、行动项提取与内容整理。"}</p></div>
                    </div>
                    <div className="profile-editor-divider" />
                  <div className="profile-editor">
                    <div className="form-grid">
                      <label className="field"><span>服务商预设</span>
                        <select value={activePresetKey} onChange={(event) => {
                          const preset = providerPresets[event.target.value];
                          if (preset) setEditing({
                            ...editing,
                            ...preset,
                            options: { ...emptyProfile.options, ...(preset.options ?? {}) }
                          });
                        }}>
                          <option value="">自定义配置</option>
                          {tab === "llm" ? (<>
                            {llmProviderGroups.map((group) => <optgroup label={group.label} key={group.label}>{group.providers.map((provider) => <option value={provider.key} key={provider.key}>{provider.name}</option>)}</optgroup>)}
                            <option value="localSummary">本机基础纪要（离线）</option>
                            <option value="ollama">Ollama（本地）</option>
                          </>) : (<>
                            <option value="whisper">本地 Whisper（自动适配）</option>
                            <option value="openaiWhisper">OpenAI Whisper</option>
                            <option value="newApiWhisper">New API</option>
                          </>)}
                        </select>
                      </label>
                      <label className="field"><span>名称</span><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
                      <div className="field"><span>用于</span><div className="readonly-control">{tab === "llm" ? "会议总结与行动项" : "会议语音转文字"}</div></div>
                      <div className="field"><span>连接方式</span><div className="readonly-control">{editing.transport === "local-summary" ? "本机离线规则引擎" : isLocalWhisperTransport(editing.transport) ? "自动适配本地模型文件" : editing.transport === "ollama" ? "本机 Ollama 服务" : editing.transport === "openai-audio" ? "在线语音转录接口" : "在线大模型接口"}</div></div>
                      {!isLocalWhisperTransport(editing.transport) && editing.transport !== "local-summary" && <label className="field"><span>模型</span><input value={editing.model} onChange={(event) => setEditing({ ...editing, model: event.target.value, options: invalidateVisualVerification(editing.options) })} placeholder={tab === "llm" ? "例如 gpt-4.1-mini" : "例如 whisper-1"} /></label>}
                    </div>
                    {editing.transport === "local-summary" ? (
                      <div className="field"><span>说明</span><div className="readonly-control">完全离线的规则纪要：从转录中提取要点、决策、行动项与风险，不发起任何网络请求，适合无网环境或隐私优先场景；追求更高质量可另配在线总结服务。</div></div>
                    ) : isLocalWhisperTransport(editing.transport) ? (
                      <LocalModelManager profile={editing} onChange={setEditing} />
                    ) : editing.transport === "sherpa-onnx" ? (
                      <>
                        <div className="field"><span>说明</span><div className="readonly-control">分离引擎为应用内置的 sherpa-onnx 组件，无需配置可执行文件。两个模型文件可从 <a href="https://github.com/k2-fsa/sherpa-onnx/releases" target="_blank" rel="noreferrer">sherpa-onnx 官方发布页</a> 下载（pyannote segmentation 与 3D-Speaker embedding）。</div></div>
                        <label className="field"><span>Pyannote segmentation ONNX</span><input value={editing.options.segmentationModelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, segmentationModelPath: event.target.value } })} /></label>
                        <label className="field"><span>3D-Speaker embedding ONNX</span><input value={editing.options.embeddingModelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, embeddingModelPath: event.target.value } })} /></label>
                        <label className="field"><span>聚类阈值</span><input type="number" min="0.1" max="0.9" step="0.01" value={editing.options.clusteringThreshold ?? 0.5} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, clusteringThreshold: Number(event.target.value) } })} /></label>
                      </>
                    ) : (
                      <>
                        {editing.transport === "ollama" ? (
                          <div className="field"><span>连接方式</span><div className="readonly-control">本机 Ollama 服务</div></div>
                        ) : editing.transport === "openai-audio" ? (
                          <div className="field"><span>接口格式</span><div className="readonly-control">OpenAI 兼容</div></div>
                        ) : (
                          <label className="field"><span>兼容协议</span>
                            <select value={editing.options.apiFlavor || "openai"} onChange={(event) => setEditing({ ...editing, options: { ...invalidateVisualVerification(editing.options), apiFlavor: event.target.value as "openai" | "anthropic" | "gemini" } })}>
                              <option value="openai">OpenAI 兼容</option>
                              <option value="anthropic">Anthropic 原生</option>
                              <option value="gemini">Google Gemini 原生</option>
                            </select>
                          </label>
                        )}
                        <label className="field"><span>Base URL</span><input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value, options: invalidateVisualVerification(editing.options) })} placeholder={editing.transport === "openai-audio" ? "https://example.com/v1，也可粘贴完整转录端点" : undefined} /></label>
                        {editing.transport !== "ollama" && <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing.secretId ? "已安全保存；留空保持不变" : "sk-…"} /></label>}
                        {editing.transport === "openai-audio" && (
                          <label className="field"><span>返回格式</span>
                            <select value={editing.options.responseFormat || (editing.options.apiFlavor === "new-api" ? "json" : "verbose_json")} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, responseFormat: event.target.value as "json" | "verbose_json" | "text" } })}>
                              <option value="json">JSON（兼容性最好）</option>
                              <option value="verbose_json">Verbose JSON（含时间戳）</option>
                              <option value="text">纯文本</option>
                            </select>
                          </label>
                        )}
                        {editing.transport !== "ollama" && <details className="advanced-provider-options">
                          <summary>高级端点设置</summary>
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
                          {editing.options.visualSummaryVerifiedAt ? "已通过结构验证" : "开启后请测试连接"}
                        </span>
                      </section>
                    )}
                    {status && <div className="connection-status">{status}</div>}
                    <div className="profile-actions">
                      {editing.secretId && <button className="text-button text-button--danger" onClick={async () => {
                        await api.models.deleteSecret(editing.secretId!);
                        // Clear the orphaned secretId on the profile and reflect it
                        // in the editor, otherwise the row keeps showing a key is
                        // stored while the vault no longer has one.
                        const cleared = { ...editing, secretId: undefined };
                        setEditing(cleared);
                        await api.models.save(cleared);
                      }}><Trash size={15} />删除密钥</button>}
                      <span />
                      <button className="button" disabled={busy} onClick={testProfile}>测试连接</button>
                      <button className="button button--primary" disabled={busy} onClick={saveProfile}>保存配置</button>
                    </div>
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
                  <div><h3>软件更新</h3><p>从MinuteFlow官网检查新版本，并在浏览器中直接下载安装包。</p></div>
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
                <div className="update-actions">
                  <button className="button" disabled={checkingUpdate} onClick={checkUpdate}>
                    <ArrowClockwise size={16} className={checkingUpdate ? "spin" : ""} />
                    {checkingUpdate ? "正在检查" : "检查更新"}
                  </button>
                  {updateState?.status === "available" && (
                    <button className="button button--primary" onClick={openUpdateDownload}>
                      <DownloadSimple size={16} />从官网下载
                    </button>
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
    </div>
  );
}

/** 在线模型库的分组标题：多语言推荐 / 轻量量化 / 英文专用。 */
const MODEL_GROUP_LABELS: Record<DownloadableModel["group"], string> = {
  multilingual: "多语言 · 推荐",
  quantized: "轻量量化",
  english: "英文专用"
};

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

  // 挂载时拉取目录并订阅主进程的下载进度推送。
  useEffect(() => {
    let active = true;
    api.models.catalog().then((items) => active && setCatalog(items)).catch(() => {});
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
      const nextProfile: ModelProfile = {
      ...profile,
      kind: "stt",
      transport: model.engine,
      model: model.name.replace(/\.(?:pt|bin|gguf)$/i, ""),
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

  return (
    <section className="local-model-manager">
      <div className="local-model-manager__heading">
        <div><strong>本地模型</strong><small>自动查找常见目录，也可以选择文件或直接下载。</small></div>
        <div className="local-model-actions">
          <button className="button button--small" disabled={busy} onClick={scanModels}><MagnifyingGlass size={15} />搜索本机</button>
          <button className="button button--small" disabled={busy} onClick={chooseModel}><FolderOpen size={15} />选择文件</button>
        </div>
      </div>
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
        <strong>在线模型库</strong>
        <small>{catalog.length} 款 Whisper 官方模型 · 下载后自动校验并启用</small>
      </div>
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
            {catalog.filter((model) => model.group === group).map((model) => {
              const currentProgress = progress?.modelId === model.id ? progress : null;
              const percent = currentProgress?.totalBytes
                ? Math.min(100, Math.round(currentProgress.downloadedBytes / currentProgress.totalBytes * 100))
                : 0;
              return (
                <div className="download-model-card" key={model.id}>
                  <div><strong>{model.name}</strong><small>{model.description}</small><span>{model.format} · {formatBytes(model.sizeBytes)} · {model.license}</span></div>
                  {model.installed && model.localPath ? (
                    <button className="button button--small" disabled={busy} onClick={async () => {
                      const discovery = scan ?? await api.models.scanLocal();
                      setScan(discovery);
                      await applyModel({ path: model.localPath!, name: model.fileName, format: model.format, engine: model.engine, sizeBytes: model.sizeBytes }, discovery.runtimes);
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
            })}
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
