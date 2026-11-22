import { useEffect, useState } from "react";
import { HardDrive, Trash } from "@phosphor-icons/react";
import type { ConfirmRequest } from "../ConfirmDialog";
import { api } from "../../lib/api";
import { formatModelBytes } from "../../lib/model-recommendation";
import type { DownloadedTranscriptionModel } from "../../types";

const trashName = api.system.platform === "win32" ? "回收站" : "废纸篓";

export function DownloadedModels({ confirm }: { confirm(request: ConfirmRequest): Promise<boolean> }) {
  const [models, setModels] = useState<DownloadedTranscriptionModel[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    api.models.downloaded().then((items) => {
      if (active) setModels(items);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "无法读取已下载模型。");
    });
    return () => { active = false; };
  }, []);

  const remove = async (model: DownloadedTranscriptionModel) => {
    if (removing || !(await confirm({
      title: `移除「${model.name}」的文件？`,
      body: `模型文件将移到系统${trashName}。需要再次使用时，可以重新下载。`,
      confirmLabel: `移到${trashName}`,
      destructive: true
    }))) return;
    setError("");
    setNotice("");
    setRemoving(model.path);
    try {
      await api.models.trashDownloaded(model.path);
      setModels((items) => items?.filter((item) => item.path !== model.path) ?? []);
      setNotice(`已移除「${model.name}」的文件。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移除模型文件失败。");
    } finally {
      setRemoving(null);
    }
  };

  return <div className="settings-services-page downloaded-models">
    {error && <div className="connection-status is-error" role="alert">{error}</div>}
    {notice && <div className="connection-status is-success" role="status">{notice}</div>}
    {!models && !error && <p className="settings-empty" role="status">正在读取模型文件…</p>}
    {models?.length === 0 && <p className="settings-empty">暂无已下载的转录模型</p>}
    {!!models?.length && <ul className="settings-service-list downloaded-models__list">
      {models.map((model) => <li className="downloaded-models__row" key={model.path}>
        <HardDrive size={20} />
        <div>
          <strong>{model.name}</strong>
          <small>{formatModelBytes(model.sizeBytes)}{model.usedBy.length > 0 && ` · 用于 ${model.usedBy.join("、")}`}</small>
        </div>
        {model.usedBy.length ? <span className="settings-default">使用中</span> : (
          <button type="button" className="button button--small settings-remove-action" disabled={removing !== null} onClick={() => void remove(model)} aria-label={`移除 ${model.name} 的文件`}>
            <Trash size={15} />{removing === model.path ? "正在移除…" : "移除文件"}
          </button>
        )}
      </li>)}
    </ul>}
  </div>;
}
