import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, CloudArrowDown, FolderOpen, Info, MagnifyingGlass } from "@phosphor-icons/react";
import { api, isElectronRuntime } from "../../lib/api";
import { formatModelBytes } from "../../lib/model-recommendation";
import { configureDiarizationModels, DIARIZATION_SETUP_MODELS, diarizationPathKey, diarizationSlotOf, findDiarizationFiles, type DiarizationModelFiles, type DiarizationSlot } from "../../lib/diarization-setup";
import { useMeetingStore } from "../../store/meetingStore";
import type { DiarizationScanResult, DownloadableModel, ModelDownloadProgress, ModelProfile } from "../../types";

export function DiarizationSetup({ profile, onChange, onCommit }: {
  profile: ModelProfile;
  onChange(profile: ModelProfile): void;
  onCommit?(profile: ModelProfile): void;
}) {
  const [catalog, setCatalog] = useState<DownloadableModel[]>(DIARIZATION_SETUP_MODELS);
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [scan, setScan] = useState<DiarizationScanResult | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const profileRef = useRef(profile);
  const operation = useRef(false);
  const mounted = useRef(true);
  const loadProfiles = useMeetingStore((state) => state.loadProfiles);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  const refreshCatalog = useCallback(async () => {
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      const items = (await api.models.catalog()).filter((item) => item.group === "diarization");
      if (!items.length) throw new Error("模型目录暂时不可用，可重试或选择本地 ONNX 文件。");
      const merged = DIARIZATION_SETUP_MODELS.map((model) => ({ ...model, ...items.find((item) => item.id === model.id) }));
      if (mounted.current) setCatalog(merged);
    } catch (error) {
      if (mounted.current) setCatalogError(error instanceof Error ? error.message : "无法读取模型目录，请重试。");
    } finally {
      if (mounted.current) setCatalogBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshCatalog();
    const unsubscribe = api.models.onDownloadProgress((next) => {
      if (DIARIZATION_SETUP_MODELS.some((model) => model.id === next.modelId)) setProgress(next);
    });
    return () => { mounted.current = false; unsubscribe(); };
  }, [refreshCatalog]);

  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setMessage(null);
    try { await action(); }
    catch (error) {
      if (mounted.current) setMessage({ text: error instanceof Error ? error.message : "配置失败，请重试。", error: true });
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const applyFiles = async (files: DiarizationModelFiles) => {
    const saved = await configureDiarizationModels(profileRef.current, files, (next) => api.models.save(next));
    // Update synchronously: the next sequential download must reuse this id and both slots.
    profileRef.current = saved;
    onChange(saved);
    await loadProfiles();
    if (mounted.current) setMessage({
      text: saved.options.segmentationModelPath && saved.options.embeddingModelPath
        ? "两个模型已就绪，之后的会议会自动区分发言人。"
        : "模型已保存，再配置另一个模型即可启用。",
      error: false
    });
  };

  const detectModels = () => run(async () => {
    const found = await api.models.scanDiarization();
    if (mounted.current) setScan(found);
    const files = findDiarizationFiles(profileRef.current, catalog, found);
    if (Object.keys(files).length) await applyFiles(files);
    else if (mounted.current) setMessage({ text: profileRef.current.options.segmentationModelPath && profileRef.current.options.embeddingModelPath
      ? "两个模型已就绪。" : "没有找到可用模型，请下载下方推荐模型或选择已有 ONNX 文件。", error: false });
  });

  const chooseModel = (slot: DiarizationSlot) => run(async () => {
    const model = await api.models.chooseLocal("diarization");
    if (model) await applyFiles({ [slot]: { path: model.path, name: model.name } });
  });

  const installModel = async (model: DownloadableModel) => {
    const slot = diarizationSlotOf(model.id);
    if (model.installed && model.localPath) {
      await applyFiles({ [slot]: { path: model.localPath, name: model.fileName } });
      return;
    }
    if (mounted.current) setProgress({ modelId: model.id, downloadedBytes: 0, totalBytes: model.sizeBytes, status: "preparing", message: "正在准备下载…" });
    try {
      const file = await api.models.download(model.id);
      await applyFiles({ [slot]: { path: file.path, name: file.name } });
      await refreshCatalog();
    } catch (error) {
      if (mounted.current) setProgress({ modelId: model.id, downloadedBytes: 0, totalBytes: model.sizeBytes, status: "error" });
      throw error;
    }
  };

  const installMissing = () => run(async () => {
    for (const model of catalog) {
      if (!profileRef.current.options[diarizationPathKey(diarizationSlotOf(model.id))]) await installModel(model);
    }
  });
  const changeOptions = (patch: Partial<ModelProfile["options"]>) => {
    const next = { ...profileRef.current, options: { ...profileRef.current.options, ...patch } };
    profileRef.current = next;
    onChange(next);
  };
  const missing = catalog.filter((model) => !profile.options[diarizationPathKey(diarizationSlotOf(model.id))]);

  return <section className="local-model-manager diarization-setup" aria-busy={busy}>
    {!isElectronRuntime && <div className="settings-info-note"><Info size={18} /><p>当前是浏览器预览。本机检测、文件选择和模型安装需在 MinuteFlow 桌面版中完成。</p></div>}
    <div className="local-model-manager__heading">
      <div><strong>说话人分离模型</strong><small>{missing.length ? `还需配置 ${missing.length} 个模型，完成后自动启用。` : "两个模型已就绪"}</small></div>
      <div className="local-model-actions">
        <button type="button" className="button button--small" disabled={busy} onClick={() => void detectModels()}><MagnifyingGlass size={15} />检测本机</button>
        {!!missing.length && <button type="button" className="button button--small button--primary" disabled={busy || catalogBusy} onClick={() => void installMissing()}><CloudArrowDown size={15} />{busy ? "正在配置…" : missing.length === 2 ? "下载并配置两个模型" : "配置剩余模型"}</button>}
      </div>
    </div>
    {catalogBusy && <p className="settings-hint" role="status">正在检查模型目录…</p>}
    {catalogError && <div className="connection-status is-error" role="alert"><span>{catalogError}</span><button type="button" className="text-button" disabled={catalogBusy || busy} onClick={() => void refreshCatalog()}><ArrowClockwise size={14} />重新加载</button></div>}
    {message && <div className={`connection-status ${message.error ? "is-error" : "is-info"}`} role={message.error ? "alert" : "status"}>{message.text}</div>}
    <div className="recommended-model-list diarization-slot-list">
      {catalog.map((model) => {
        const slot = diarizationSlotOf(model.id);
        const ready = Boolean(profile.options[diarizationPathKey(slot)]);
        const current = progress?.modelId === model.id ? progress : null;
        const percent = current?.totalBytes ? Math.min(100, Math.round(current.downloadedBytes / current.totalBytes * 100)) : 0;
        const label = current?.status === "downloading" ? `${percent}%` : current?.status === "verifying" ? "校验中" : current?.status === "preparing" ? "准备中" : current?.status === "error" ? "重试下载" : model.installed ? "使用已下载模型" : "下载";
        return <div key={model.id} className="download-model-card diarization-slot">
          <div><strong>{model.name}</strong><small>{model.description}</small><span>{model.format} · {formatModelBytes(model.sizeBytes)} · {model.license}</span></div>
          <div className="diarization-slot__actions">
            <button type="button" className="button button--small" disabled={busy} aria-label={slot === "segmentation" ? "选择分离模型文件" : "选择声纹模型文件"} onClick={() => void chooseModel(slot)}><FolderOpen size={15} />选择文件</button>
            {ready ? <span className="diarization-slot__ready"><CheckCircle size={15} />已就绪</span> : <button type="button" className="button button--small" disabled={busy} aria-label={`${label} ${model.name}`} onClick={() => void run(() => installModel(model))}><CloudArrowDown size={15} />{label}</button>}
          </div>
          {current && !ready && <progress max="100" value={percent} aria-label={`${model.name} 下载进度`} />}
        </div>;
      })}
    </div>
    {scan && <div className="local-model-list">{(["segmentation", "embedding"] as const).flatMap((slot) => scan[slot].map((file) => <button type="button" key={`${slot}:${file.path}`} disabled={busy} onClick={() => void run(() => applyFiles({ [slot]: file }))}><FolderOpen size={18} /><span><strong>{file.name}</strong><small>{slot === "segmentation" ? "分离模型" : "声纹模型"}</small></span></button>))}</div>}
    <details className="advanced-provider-options"><summary>高级与故障排除</summary>
      <div className="field"><span>说明</span><div className="readonly-control">聚类阈值越低越容易分成更多说话人，默认 0.5 适合大多数会议。</div></div>
      <label className="field"><span>分离模型路径</span><input disabled={busy} value={profile.options.segmentationModelPath || ""} onChange={(event) => changeOptions({ segmentationModelPath: event.target.value })} onBlur={() => onCommit?.(profileRef.current)} spellCheck={false} /></label>
      <label className="field"><span>声纹模型路径</span><input disabled={busy} value={profile.options.embeddingModelPath || ""} onChange={(event) => changeOptions({ embeddingModelPath: event.target.value })} onBlur={() => onCommit?.(profileRef.current)} spellCheck={false} /></label>
      <label className="field"><span>聚类阈值</span><input disabled={busy} type="number" min="0.1" max="0.9" step="0.01" value={profile.options.clusteringThreshold ?? 0.5} onChange={(event) => changeOptions({ clusteringThreshold: Number(event.target.value) })} onBlur={() => onCommit?.(profileRef.current)} /></label>
    </details>
  </section>;
}
