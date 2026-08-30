import { useEffect, useState, type DragEvent } from "react";
import { ArrowUp, CheckCircle, DotsSixVertical, FolderOpen, Power, WarningCircle, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";

type HelperState = "idle" | "dragging" | "dropped" | "restarting" | "success";

/** macOS 系统设置上方的置顶浮层：把当前 .app 真实拖入权限列表。 */
export function PermissionDragHelper() {
  const previewParameters = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
  const previewState = parseHelperPreviewState(previewParameters?.get("helperState") ?? null);
  const previewWidth = previewParameters?.get("helperWidth") === "560" ? 560 : undefined;
  const [state, setState] = useState<HelperState>(previewState ?? "idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (previewState) return;
    if (state === "restarting" || state === "success") return;
    const timer = window.setInterval(async () => {
      const status = await api.system.getPermissions().catch(() => null);
      if (status?.screen === "granted") setState("success");
    }, 1500);
    return () => window.clearInterval(timer);
  }, [previewState, state]);

  useEffect(() => {
    if (previewState) return;
    if (state !== "success") return;
    const timer = window.setTimeout(() => api.system.closePermissionHelper(), 900);
    return () => window.clearTimeout(timer);
  }, [previewState, state]);

  const startDrag = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setError(null);
    setState("dragging");
    api.system.startAppDrag();
  };

  const revealApplication = async () => {
    setError(null);
    try {
      await api.system.revealApplication();
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : "无法在访达中显示 MinuteFlow，请重试。");
    }
  };

  const relaunch = async () => {
    setError(null);
    setState("restarting");
    try {
      await api.system.relaunchForPermissionSetup();
      if (api.system.platform === "web") setState("success");
    } catch (relaunchError) {
      setState("dropped");
      setError(relaunchError instanceof Error ? relaunchError.message : "无法重新启动，请手动退出后再打开 MinuteFlow。");
    }
  };

  const copy = helperCopy(state);

  return (
    <main className={`permission-helper permission-helper--${state}${previewWidth ? " permission-helper--compact" : ""}`} style={previewWidth ? { width: previewWidth } : undefined} aria-label="MinuteFlow 权限拖拽助手">
      <button
        className={`permission-helper__app ${state === "dragging" ? "is-dragging" : ""}`}
        draggable={state !== "restarting" && state !== "success"}
        onDragStart={startDrag}
        onDragEnd={() => setState("dropped")}
        aria-label="拖动 MinuteFlow 到系统设置应用列表"
        aria-describedby="permission-helper-instruction"
        disabled={state === "restarting" || state === "success"}
      >
        <DotsSixVertical size={18} weight="bold" />
        <BrandMark size={42} />
        <span><strong>MinuteFlow</strong><small>{copy.tile}</small></span>
      </button>
      {state === "success" ? <CheckCircle className="permission-helper__arrow" size={32} weight="fill" /> : <ArrowUp className="permission-helper__arrow" size={32} weight="bold" />}
      <div className="permission-helper__copy">
        <strong id="permission-helper-instruction" role="status" aria-live="polite">{copy.title}</strong>
        <span>{copy.description}</span>
        <div className="permission-helper__fallback">
          {state === "dropped" && <button className="is-primary" type="button" onClick={relaunch}><Power size={14} />开关已打开，重启</button>}
          {state !== "success" && <button type="button" onClick={revealApplication} disabled={state === "restarting"}><FolderOpen size={14} />在访达中显示</button>}
          <small><CheckCircle size={14} weight="fill" />不需要辅助功能权限</small>
        </div>
        {error && <p role="alert"><WarningCircle size={13} />{error}</p>}
      </div>
      <button className="permission-helper__close" onClick={() => api.system.closePermissionHelper()} aria-label="关闭引导">
        <X size={17} />
      </button>
    </main>
  );
}

function parseHelperPreviewState(value: string | null): HelperState | null {
  return value && ["idle", "dragging", "dropped", "restarting", "success"].includes(value)
    ? value as HelperState
    : null;
}

function helperCopy(state: HelperState) {
  if (state === "dragging") return {
    tile: "继续向上拖动",
    title: "移到应用列表后松手",
    description: "放入列表后打开右侧开关。"
  };
  if (state === "dropped") return {
    tile: "已完成拖动",
    title: "现在打开 MinuteFlow 右侧开关",
    description: "开关打开后需要重启一次；点下方按钮会保存当前进度。"
  };
  if (state === "restarting") return {
    tile: "正在保存进度",
    title: "正在重新启动 MinuteFlow…",
    description: "重新打开后会直接进入系统音频验证。"
  };
  if (state === "success") return {
    tile: "权限已允许",
    title: "系统音频权限已准备好",
    description: "引导即将自动关闭。"
  };
  return {
    tile: "按住并向上拖动",
    title: "拖到“屏幕与系统音频录制”的应用列表",
    description: "出现 MinuteFlow 后打开右侧开关；拖不动时，可在访达中定位后用列表下方的“+”添加。"
  };
}
