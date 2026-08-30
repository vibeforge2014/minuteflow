import { useEffect, useState, type DragEvent } from "react";
import { ArrowUp, CheckCircle, DotsSixVertical, FolderOpen, WarningCircle, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";

/** macOS 系统设置上方的置顶浮层：把当前 .app 真实拖入权限列表。 */
export function PermissionDragHelper() {
  const [dragging, setDragging] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const status = await api.system.getPermissions().catch(() => null);
      if (status?.screen === "granted") api.system.closePermissionHelper();
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  const startDrag = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(true);
    api.system.startAppDrag();
    window.setTimeout(() => setDragging(false), 900);
  };

  const revealApplication = async () => {
    setRevealError(null);
    try {
      await api.system.revealApplication();
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : "无法在访达中显示 MinuteFlow，请重试。");
    }
  };

  return (
    <main className="permission-helper" aria-label="MinuteFlow 权限拖拽助手">
      <button
        className={`permission-helper__app ${dragging ? "is-dragging" : ""}`}
        draggable
        onDragStart={startDrag}
        onDragEnd={() => setDragging(false)}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        aria-label="拖动 MinuteFlow 到系统设置应用列表"
        aria-describedby="permission-helper-instruction"
      >
        <DotsSixVertical size={18} weight="bold" />
        <BrandMark size={42} />
        <span><strong>MinuteFlow</strong><small>{dragging ? "继续拖到上方列表" : "按住并向上拖动"}</small></span>
      </button>
      <ArrowUp className="permission-helper__arrow" size={32} weight="bold" />
      <div className="permission-helper__copy">
        <strong id="permission-helper-instruction" role="status" aria-live="polite">
          {dragging ? "继续向上拖，移到应用列表后松手" : "拖到“屏幕与系统音频录制”的应用列表"}
        </strong>
        <span>出现 MinuteFlow 后打开右侧开关。拖不动时，在访达中定位应用，再用列表下方的“+”添加。</span>
        <div className="permission-helper__fallback">
          <button type="button" onClick={revealApplication}><FolderOpen size={14} />在访达中显示</button>
          <small><CheckCircle size={14} weight="fill" />不需要辅助功能权限</small>
        </div>
        {revealError && <p role="alert"><WarningCircle size={13} />{revealError}</p>}
      </div>
      <button className="permission-helper__close" onClick={() => api.system.closePermissionHelper()} aria-label="关闭引导">
        <X size={17} />
      </button>
    </main>
  );
}
