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

const emptyProfile: ModelProfile = {
  name: "OpenAI 兼容模型",
  kind: "llm",
  transport: "openai-chat",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  options: { timeoutMs: 60_000 },
  enabled: true
};

const providerPresets: Record<string, Partial<ModelProfile>> = {
  openai: {
    name: "OpenAI",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
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
  ollama: {
    name: "Ollama",
    kind: "llm",
    transport: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3"
  },
  newApiLlm: {
    name: "New API 大模型",
    kind: "llm",
    transport: "openai-chat",
    baseUrl: "https://YOUR-NEW-API.example/v1",
    model: "gpt-4.1-mini",
    options: { timeoutMs: 60_000, apiFlavor: "new-api" }
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
      timeoutMs: 120_000,
      apiFlavor: "new-api",
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

export function SettingsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const profiles = useMeetingStore((state) => state.profiles);
  const preferences = useMeetingStore((state) => state.preferences);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);
  const updatePreferences = useMeetingStore((state) => state.updatePreferences);
  const [tab, setTab] = useState<"llm" | "transcription" | "general" | "storage" | "updates">("transcription");
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    if (open) loadProfiles();
  }, [loadProfiles, open]);

  useEffect(() => {
    if (!open || (tab !== "llm" && tab !== "transcription")) return;
    const targetKind: ModelProfile["kind"] = tab === "llm" ? "llm" : "stt";
    if (editing?.kind === targetKind) return;
    const saved = profiles.find((profile) => profile.kind === targetKind);
    if (saved) {
      setEditing(saved);
      return;
    }
    const preset = tab === "llm" ? providerPresets.openai : providerPresets.whisper;
    setEditing({
      ...emptyProfile,
      ...preset,
      options: { ...emptyProfile.options, ...(preset.options ?? {}) }
    });
  }, [editing, open, profiles, tab]);

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

  const testProfile = async () => {
    if (!editing) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.models.test(editing, apiKey || undefined);
      setStatus(result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "连接失败");
    } finally {
      setBusy(false);
    }
  };

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
                      <button className={editing?.name === "Ollama" ? "is-selected" : ""} onClick={() => startPreset("ollama")}><span className="profile-icon">OL</span><span><strong>Ollama</strong><small>数据留在本机 · 需要已安装服务</small></span>{editing?.name === "Ollama" && <CheckCircle size={16} weight="fill" />}</button>
                    ) : (
                      <button className={editing?.transport === "whisper-cpp" || editing?.transport === "whisper-python" ? "is-selected" : ""} onClick={() => startPreset("whisper")}><span className="profile-icon"><Waveform size={18} /></span><span><strong>本地 Whisper</strong><small>自动适配 GGML、GGUF 与 .pt</small></span>{(editing?.transport === "whisper-cpp" || editing?.transport === "whisper-python") && <CheckCircle size={16} weight="fill" />}</button>
                    )}
                  </div>
                  <div className="model-catalog__section"><span>在线服务</span>
                    {tab === "llm" ? (<>
                      <button className={editing?.name === "OpenAI" ? "is-selected" : ""} onClick={() => startPreset("openai")}><span className="profile-icon">AI</span><span><strong>OpenAI</strong><small>开箱即用的会议总结</small></span>{editing?.name === "OpenAI" && <CheckCircle size={16} weight="fill" />}</button>
                      <button className={editing?.name === "DeepSeek" ? "is-selected" : ""} onClick={() => startPreset("deepseek")}><span className="profile-icon">DS</span><span><strong>DeepSeek</strong><small>兼容 OpenAI 的在线模型</small></span>{editing?.name === "DeepSeek" && <CheckCircle size={16} weight="fill" />}</button>
                      <button className={editing?.name === "New API 大模型" ? "is-selected" : ""} onClick={() => startPreset("newApiLlm")}><span className="profile-icon"><CloudArrowDown size={18} /></span><span><strong>New API</strong><small>连接自建或聚合模型服务</small></span>{editing?.name === "New API 大模型" && <CheckCircle size={16} weight="fill" />}</button>
                    </>) : (<>
                      <button className={editing?.name === "OpenAI Whisper" ? "is-selected" : ""} onClick={() => startPreset("openaiWhisper")}><span className="profile-icon"><Waveform size={18} /></span><span><strong>OpenAI Whisper</strong><small>无需下载本地模型</small></span>{editing?.name === "OpenAI Whisper" && <CheckCircle size={16} weight="fill" />}</button>
                      <button className={editing?.name === "New API 语音转录" ? "is-selected" : ""} onClick={() => startPreset("newApiWhisper")}><span className="profile-icon"><CloudArrowDown size={18} /></span><span><strong>New API</strong><small>OpenAI 音频接口兼容</small></span>{editing?.name === "New API 语音转录" && <CheckCircle size={16} weight="fill" />}</button>
                    </>)}
                  </div>
                  {!!profiles.length && <div className="model-catalog__section"><span>已保存</span>{profiles.filter((profile) => profile.kind === (tab === "llm" ? "llm" : "stt")).map((profile) => (
                    <button key={profile.id} className={editing?.id === profile.id ? "is-selected" : ""} onClick={() => { setEditing(profile); setApiKey(""); setStatus(null); }}><span className="profile-icon">{profile.kind === "stt" ? "STT" : profile.kind === "llm" ? "LLM" : "SPK"}</span><span><strong>{profile.name}</strong><small>{profile.model || "尚未选择模型"}</small></span>{profile.enabled && <CheckCircle size={16} weight="fill" />}</button>
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
                            options: { ...editing.options, ...(preset.options ?? {}) }
                          });
                        }}>
                          <option value="">自定义配置</option>
                          {tab === "llm" ? (<>
                            <option value="openai">OpenAI</option>
                            <option value="azure">Azure OpenAI</option>
                            <option value="deepseek">DeepSeek</option>
                            <option value="dashscope">通义千问 / DashScope</option>
                            <option value="ollama">Ollama（本地）</option>
                            <option value="newApiLlm">New API</option>
                          </>) : (<>
                            <option value="whisper">本地 Whisper（自动适配）</option>
                            <option value="openaiWhisper">OpenAI Whisper</option>
                            <option value="newApiWhisper">New API</option>
                          </>)}
                        </select>
                      </label>
                      <label className="field"><span>名称</span><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
                      <div className="field"><span>用于</span><div className="readonly-control">{tab === "llm" ? "会议总结与行动项" : "会议语音转文字"}</div></div>
                      <div className="field"><span>连接方式</span><div className="readonly-control">{editing.transport === "whisper-cpp" || editing.transport === "whisper-python" ? "自动适配本地模型文件" : editing.transport === "ollama" ? "本机 Ollama 服务" : editing.transport === "openai-audio" ? "在线语音转录接口" : "在线大模型接口"}</div></div>
                      <label className="field"><span>模型</span><input value={editing.model} onChange={(event) => setEditing({ ...editing, model: event.target.value })} placeholder={tab === "llm" ? "例如 gpt-4.1-mini" : "例如 whisper-1"} /></label>
                    </div>
                    {editing.transport === "whisper-cpp" || editing.transport === "whisper-python" ? (
                      <>
                        <LocalModelManager profile={editing} onChange={setEditing} />
                        <details className="advanced-runtime-options">
                          <summary>高级：手动指定运行环境</summary>
                          <p>仅在自动发现失败或需要使用自定义运行环境时填写。</p>
                          {editing.transport === "whisper-cpp" ? (
                            <label className="field"><span>whisper.cpp 可执行文件</span><input value={editing.options.executablePath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, executablePath: event.target.value } })} placeholder="whisper-cli 路径" /></label>
                          ) : (
                            <label className="field"><span>Python 可执行文件</span><input value={editing.options.pythonExecutablePath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, pythonExecutablePath: event.target.value } })} placeholder="已安装 openai-whisper 的 Python 路径" /></label>
                          )}
                          <label className="field"><span>{editing.transport === "whisper-python" ? "PyTorch .pt 模型路径" : "GGML / GGUF 模型路径"}</span><input value={editing.options.modelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, modelPath: event.target.value } })} /></label>
                          <label className="field"><span>FFmpeg 路径</span><input value={editing.options.ffmpegPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, ffmpegPath: event.target.value } })} /></label>
                        </details>
                      </>
                    ) : editing.transport === "sherpa-onnx" ? (
                      <>
                        <label className="field"><span>sherpa-onnx 分离程序</span><input value={editing.options.executablePath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, executablePath: event.target.value } })} /></label>
                        <label className="field"><span>Pyannote segmentation ONNX</span><input value={editing.options.segmentationModelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, segmentationModelPath: event.target.value } })} /></label>
                        <label className="field"><span>3D-Speaker embedding ONNX</span><input value={editing.options.embeddingModelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, embeddingModelPath: event.target.value } })} /></label>
                        <label className="field"><span>FFmpeg 路径</span><input value={editing.options.ffmpegPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, ffmpegPath: event.target.value } })} /></label>
                        <label className="field"><span>聚类阈值</span><input type="number" min="0.1" max="0.9" step="0.01" value={editing.options.clusteringThreshold ?? 0.5} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, clusteringThreshold: Number(event.target.value) } })} /></label>
                      </>
                    ) : (
                      <>
                        {editing.transport === "ollama" ? (
                          <div className="field"><span>连接方式</span><div className="readonly-control">本机 Ollama 服务</div></div>
                        ) : (
                          <label className="field"><span>兼容协议</span>
                            <select value={editing.options.apiFlavor || "openai"} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, apiFlavor: event.target.value as "openai" | "new-api" } })}>
                              <option value="openai">OpenAI 兼容</option>
                              <option value="new-api">New API</option>
                            </select>
                          </label>
                        )}
                        <label className="field"><span>Base URL</span><input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} /></label>
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
                            <label className="field"><span>聊天端点（可选）</span><input value={editing.options.chatEndpoint || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, chatEndpoint: event.target.value } })} placeholder="留空自动使用 /v1/chat/completions" /></label>
                          )}
                        </details>}
                      </>
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
                  <label><span><strong>实时纪要间隔</strong><small>录音过程中自动整理内容的频率</small></span><select value={preferences.summaryIntervalSeconds} onChange={(event) => updatePreferences({ ...preferences, summaryIntervalSeconds: Number(event.target.value) })}><option value="60">每 1 分钟</option><option value="120">每 2 分钟</option><option value="300">每 5 分钟</option></select></label>
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
                  <p>应用只接受 HTTPS 官网清单和官方发布地址。下载完成后，请打开 DMG 并将新版本拖入“应用程序”。</p>
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

function LocalModelManager({
  profile,
  onChange
}: {
  profile: ModelProfile;
  onChange(profile: ModelProfile): void;
}) {
  const [catalog, setCatalog] = useState<DownloadableModel[]>([]);
  const [scan, setScan] = useState<LocalModelScanResult | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);

  useEffect(() => {
    let active = true;
    api.models.catalog().then((items) => active && setCatalog(items)).catch(() => {});
    const unsubscribe = api.models.onDownloadProgress((next) => setProgress(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

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
        executablePath: model.engine === "whisper-cpp"
          ? (profile.options.executablePath || runtimes?.whisperCpp)
          : profile.options.executablePath,
        pythonExecutablePath: model.engine === "whisper-python"
          ? (profile.options.pythonExecutablePath || runtimes?.python)
          : profile.options.pythonExecutablePath,
        ffmpegPath: profile.options.ffmpegPath || runtimes?.ffmpeg
      }
      };
      const saved = await api.models.save(nextProfile);
      onChange(saved);
      await loadProfiles();
      const runtimeMissing = model.engine === "whisper-cpp"
        ? !saved.options.executablePath
        : !saved.options.pythonExecutablePath;
      setSuccess(runtimeMissing
        ? `已启用 ${model.name}；模型路径已保存。还需要在下方补充${model.engine === "whisper-cpp" ? " whisper-cli" : "已安装 openai-whisper 的 Python"}路径。`
        : `已启用 ${model.name}，后续会议将使用此模型转写。`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "无法启用本地模型");
    } finally {
      setBusy(false);
    }
  };

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

  const downloadModel = async (modelId: string) => {
    setBusy(true);
    setError(null);
    setProgress({ modelId, downloadedBytes: 0, totalBytes: 0, status: "downloading" });
    try {
      const model = await api.models.download(modelId);
      const discovery = await api.models.scanLocal();
      setScan(discovery);
      await applyModel(model, discovery.runtimes);
      setCatalog(await api.models.catalog());
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "模型下载失败");
    } finally {
      setBusy(false);
    }
  };

  const runtimeLabels = scan ? [
    scan.runtimes.whisperCpp && "whisper.cpp 已就绪",
    scan.runtimes.python && "Python 已找到",
    scan.runtimes.ffmpeg && "FFmpeg 已找到"
  ].filter(Boolean) : [];

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
      <div className="download-model-list">
        {catalog.map((model) => {
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
                }}>{profile.options.modelPath === model.localPath ? "使用中" : "使用"}</button>
              ) : (
                <button className="button button--small" disabled={busy} onClick={() => downloadModel(model.id)}><CloudArrowDown size={15} />{currentProgress ? `${percent}%` : "下载"}</button>
              )}
              {currentProgress && <progress max="100" value={percent} aria-label={`${model.name} 下载进度`} />}
            </div>
          );
        })}
      </div>
      {error && <div className="connection-status is-error">{error}</div>}
      {success && <div className="connection-status is-success">{success}</div>}
    </section>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "未知大小";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
