import { useEffect, useState } from "react";
import {
  CheckCircle,
  CloudArrowDown,
  Cpu,
  Database,
  FolderOpen,
  HardDrives,
  Key,
  MagnifyingGlass,
  Plus,
  SlidersHorizontal,
  Trash,
  X
} from "@phosphor-icons/react";
import { api, isElectronRuntime } from "../lib/api";
import { useMeetingStore } from "../store/meetingStore";
import type {
  DownloadableModel,
  LocalModelFile,
  LocalModelScanResult,
  ModelDownloadProgress,
  ModelProfile
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
    name: "本地 whisper.cpp",
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
    name: "本地 Whisper（PyTorch）",
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
  const [tab, setTab] = useState<"models" | "general" | "storage">("models");
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) loadProfiles();
  }, [loadProfiles, open]);
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

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog settings-dialog">
        <header>
          <div><h2>设置</h2><p>模型、录音与本地数据都由你掌控。</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
        </header>
        <div className="settings-layout">
          <nav>
            <button className={tab === "models" ? "is-active" : ""} onClick={() => setTab("models")}><Key size={18} />模型服务</button>
            <button className={tab === "general" ? "is-active" : ""} onClick={() => setTab("general")}><SlidersHorizontal size={18} />会议偏好</button>
            <button className={tab === "storage" ? "is-active" : ""} onClick={() => setTab("storage")}><Database size={18} />存储与隐私</button>
          </nav>
          <div className="settings-content">
            {tab === "models" && (
              <div className="model-settings">
                <div className="settings-section-heading">
                  <div><h3>模型配置</h3><p>先选择常用方案，应用会自动填写协议与推荐参数。</p></div>
                  <button className="button button--small" onClick={() => setEditing({ ...emptyProfile })}><Plus size={15} />添加</button>
                </div>
                <div className="model-quick-start" aria-label="快速添加模型">
                  <button onClick={() => startPreset("whisper")}><Cpu size={19} weight="duotone" /><span><strong>本地 Whisper</strong><small>扫描、选择或下载 GGML / PT 模型</small></span></button>
                  <button onClick={() => startPreset("newApiWhisper")}><CloudArrowDown size={19} weight="duotone" /><span><strong>New API 转录</strong><small>兼容标准与 New API 音频端点</small></span></button>
                  <button onClick={() => startPreset("newApiLlm")}><Key size={19} weight="duotone" /><span><strong>New API 总结</strong><small>OpenAI Chat 兼容与 JSON 回退</small></span></button>
                </div>
                <div className="profile-list">
                  {profiles.map((profile) => (
                    <button key={profile.id} className={editing?.id === profile.id ? "is-selected" : ""} onClick={() => { setEditing(profile); setApiKey(""); }}>
                      <span className="profile-icon">{profile.kind === "stt" ? "STT" : profile.kind === "llm" ? "LLM" : "SPK"}</span>
                      <span><strong>{profile.name}</strong><small>{profile.model || "尚未选择模型"}</small></span>
                      {profile.enabled && <CheckCircle size={17} weight="fill" />}
                    </button>
                  ))}
                  {!profiles.length && <div className="settings-empty">尚未配置模型。没有模型时，会议仍可录音和记笔记。</div>}
                </div>
                {editing && (
                  <div className="profile-editor">
                    <div className="form-grid">
                      <label className="field"><span>服务商预设</span>
                        <select value="" onChange={(event) => {
                          const preset = providerPresets[event.target.value];
                          if (preset) setEditing({
                            ...editing,
                            ...preset,
                            options: { ...editing.options, ...(preset.options ?? {}) }
                          });
                        }}>
                          <option value="">自定义配置</option>
                          <option value="openai">OpenAI</option>
                          <option value="azure">Azure OpenAI</option>
                          <option value="deepseek">DeepSeek</option>
                          <option value="dashscope">通义千问 / DashScope</option>
                          <option value="ollama">Ollama</option>
                          <option value="newApiLlm">New API 大模型</option>
                          <option value="openaiWhisper">OpenAI Whisper</option>
                          <option value="newApiWhisper">New API 远程 Whisper</option>
                          <option value="whisper">本地 whisper.cpp</option>
                          <option value="pythonWhisper">本地 Whisper .pt</option>
                          <option value="sherpa">本地 sherpa-onnx</option>
                        </select>
                      </label>
                      <label className="field"><span>名称</span><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
                      <label className="field"><span>用途</span>
                        <select value={editing.kind} onChange={(event) => {
                          const kind = event.target.value as ModelProfile["kind"];
                          setEditing({
                            ...editing,
                            kind,
                            transport: kind === "stt"
                              ? "openai-audio"
                              : kind === "diarization"
                                ? "sherpa-onnx"
                                : "openai-chat"
                          });
                        }}>
                          <option value="llm">会议总结</option><option value="stt">语音转录</option><option value="diarization">说话人分离</option>
                        </select>
                      </label>
                      <label className="field"><span>协议</span>
                        <select value={editing.transport} onChange={(event) => setEditing({ ...editing, transport: event.target.value as ModelProfile["transport"] })}>
                          <option value="openai-chat">OpenAI Chat 兼容</option>
                          <option value="openai-audio">OpenAI Audio 兼容</option>
                          <option value="ollama">Ollama</option>
                          <option value="whisper-cpp">本地 whisper.cpp</option>
                          <option value="whisper-python">本地 Whisper（Python / .pt）</option>
                          <option value="sherpa-onnx">本地 sherpa-onnx</option>
                        </select>
                      </label>
                      <label className="field"><span>模型名</span><input value={editing.model} onChange={(event) => setEditing({ ...editing, model: event.target.value })} placeholder="例如 gpt-4.1-mini / whisper-1" /></label>
                    </div>
                    {editing.transport === "whisper-cpp" || editing.transport === "whisper-python" ? (
                      <>
                        <LocalModelManager profile={editing} onChange={setEditing} />
                        {editing.transport === "whisper-cpp" ? (
                          <label className="field"><span>whisper.cpp 可执行文件</span><input value={editing.options.executablePath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, executablePath: event.target.value } })} placeholder="自动搜索，或手动填写 whisper-cli 路径" /></label>
                        ) : (
                          <label className="field"><span>Python 可执行文件</span><input value={editing.options.pythonExecutablePath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, pythonExecutablePath: event.target.value } })} placeholder="自动搜索，或手动填写已安装 openai-whisper 的 Python" /></label>
                        )}
                        <label className="field"><span>{editing.transport === "whisper-python" ? "PyTorch .pt 模型路径" : "GGML / GGUF 模型路径"}</span><input value={editing.options.modelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, modelPath: event.target.value } })} /></label>
                        <label className="field"><span>FFmpeg 路径</span><input value={editing.options.ffmpegPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, ffmpegPath: event.target.value } })} /></label>
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
                        <label className="field"><span>兼容协议</span>
                          <select value={editing.options.apiFlavor || "openai"} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, apiFlavor: event.target.value as "openai" | "new-api" } })}>
                            <option value="openai">OpenAI 兼容</option>
                            <option value="new-api">New API</option>
                          </select>
                        </label>
                        <label className="field"><span>Base URL</span><input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} /></label>
                        <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing.secretId ? "已安全保存；留空保持不变" : "sk-…"} /></label>
                        {editing.transport === "openai-audio" && (
                          <label className="field"><span>返回格式</span>
                            <select value={editing.options.responseFormat || (editing.options.apiFlavor === "new-api" ? "json" : "verbose_json")} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, responseFormat: event.target.value as "json" | "verbose_json" | "text" } })}>
                              <option value="json">JSON（兼容性最好）</option>
                              <option value="verbose_json">Verbose JSON（含时间戳）</option>
                              <option value="text">纯文本</option>
                            </select>
                          </label>
                        )}
                        <details className="advanced-provider-options">
                          <summary>高级端点设置</summary>
                          {editing.transport === "openai-audio" ? (
                            <label className="field"><span>转录端点（可选）</span><input value={editing.options.transcriptionEndpoint || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, transcriptionEndpoint: event.target.value } })} placeholder="留空自动尝试 /v1/audio/transcriptions" /></label>
                          ) : (
                            <label className="field"><span>聊天端点（可选）</span><input value={editing.options.chatEndpoint || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, chatEndpoint: event.target.value } })} placeholder="留空自动使用 /v1/chat/completions" /></label>
                          )}
                        </details>
                      </>
                    )}
                    {status && <div className="connection-status">{status}</div>}
                    <div className="profile-actions">
                      {editing.secretId && <button className="text-button text-button--danger" onClick={() => api.models.deleteSecret(editing.secretId!)}><Trash size={15} />删除密钥</button>}
                      <span />
                      <button className="button" disabled={busy} onClick={testProfile}>测试连接</button>
                      <button className="button button--primary" disabled={busy} onClick={saveProfile}>保存配置</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {tab === "general" && (
              <div className="preference-settings">
                <h3>会议偏好</h3>
                <label><span>实时纪要间隔</span><select value={preferences.summaryIntervalSeconds} onChange={(event) => updatePreferences({ ...preferences, summaryIntervalSeconds: Number(event.target.value) })}><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option></select></label>
                <label><span>默认会议模式</span><select value={preferences.defaultMode} onChange={(event) => updatePreferences({ ...preferences, defaultMode: event.target.value as "online" | "offline" })}><option value="online">线上会议</option><option value="offline">线下会议</option></select></label>
                <label><span>自定义术语</span><textarea rows={5} value={preferences.glossary.join("\n")} onChange={(event) => updatePreferences({ ...preferences, glossary: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} placeholder="产品名、人名、缩写；每行一个" /></label>
              </div>
            )}
            {tab === "storage" && (
              <div className="storage-settings">
                <div className="storage-card"><HardDrives size={24} weight="duotone" /><div><h3>本地优先</h3><p>会议录音、笔记和索引默认保存在本机应用数据目录。</p></div></div>
                <label><span>自动保留原始录音</span><select value={preferences.retentionDays === null ? "forever" : String(preferences.retentionDays)} onChange={(event) => updatePreferences({ ...preferences, retentionDays: event.target.value === "forever" ? null : Number(event.target.value) })}><option value="forever">永久保留</option><option value="30">30 天</option><option value="7">7 天</option><option value="0">转录完成后删除</option></select></label>
                <button className="button" onClick={() => api.system.openSettings()}>打开系统录音权限</button>
                <p className="runtime-note">{isElectronRuntime ? "当前运行在 Electron 安全环境中。" : "当前是浏览器预览；桌面权限与加密存储会在 Electron 中启用。"}</p>
              </div>
            )}
          </div>
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

  useEffect(() => {
    let active = true;
    api.models.catalog().then((items) => active && setCatalog(items)).catch(() => {});
    const unsubscribe = api.models.onDownloadProgress((next) => setProgress(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const applyModel = (model: LocalModelFile, runtimes = scan?.runtimes) => {
    onChange({
      ...profile,
      kind: "stt",
      transport: model.engine,
      model: model.name.replace(/\.(?:pt|bin|gguf)$/i, ""),
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
    });
  };

  const scanModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.models.scanLocal();
      setScan(result);
      if (result.models.length === 1) applyModel(result.models[0], result.runtimes);
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
      if (model) applyModel(model);
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
      applyModel(model);
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
            <button key={model.path} className={profile.options.modelPath === model.path ? "is-selected" : ""} onClick={() => applyModel(model, scan.runtimes)}>
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
                <button className="button button--small" onClick={() => applyModel({ path: model.localPath!, name: model.fileName, format: model.format, engine: model.engine, sizeBytes: model.sizeBytes })}>使用</button>
              ) : (
                <button className="button button--small" disabled={busy} onClick={() => downloadModel(model.id)}><CloudArrowDown size={15} />{currentProgress ? `${percent}%` : "下载"}</button>
              )}
              {currentProgress && <progress max="100" value={percent} aria-label={`${model.name} 下载进度`} />}
            </div>
          );
        })}
      </div>
      {error && <div className="connection-status is-error">{error}</div>}
    </section>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "未知大小";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
