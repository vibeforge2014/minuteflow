import { useEffect, useState } from "react";
import {
  CheckCircle,
  Database,
  HardDrives,
  Key,
  Plus,
  SlidersHorizontal,
  Trash,
  X
} from "@phosphor-icons/react";
import { api, isElectronRuntime } from "../lib/api";
import { useMeetingStore } from "../store/meetingStore";
import type { ModelProfile } from "../types";

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
                  <div><h3>模型配置</h3><p>支持 OpenAI 兼容接口、Ollama 与本地 whisper.cpp。</p></div>
                  <button className="button button--small" onClick={() => setEditing({ ...emptyProfile })}><Plus size={15} />添加</button>
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
                            options: { ...editing.options }
                          });
                        }}>
                          <option value="">自定义配置</option>
                          <option value="openai">OpenAI</option>
                          <option value="azure">Azure OpenAI</option>
                          <option value="deepseek">DeepSeek</option>
                          <option value="dashscope">通义千问 / DashScope</option>
                          <option value="ollama">Ollama</option>
                          <option value="openaiWhisper">OpenAI Whisper</option>
                          <option value="whisper">本地 whisper.cpp</option>
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
                          <option value="sherpa-onnx">本地 sherpa-onnx</option>
                        </select>
                      </label>
                      <label className="field"><span>模型名</span><input value={editing.model} onChange={(event) => setEditing({ ...editing, model: event.target.value })} placeholder="例如 gpt-4.1-mini / whisper-1" /></label>
                    </div>
                    {editing.transport === "whisper-cpp" ? (
                      <>
                        <label className="field"><span>whisper.cpp 可执行文件</span><input value={editing.options.executablePath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, executablePath: event.target.value } })} /></label>
                        <label className="field"><span>GGML 模型路径</span><input value={editing.options.modelPath || ""} onChange={(event) => setEditing({ ...editing, options: { ...editing.options, modelPath: event.target.value } })} /></label>
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
                        <label className="field"><span>Base URL</span><input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} /></label>
                        <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing.secretId ? "已安全保存；留空保持不变" : "sk-…"} /></label>
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
