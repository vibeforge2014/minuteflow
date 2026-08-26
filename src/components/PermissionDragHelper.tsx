import { useEffect, useState, type DragEvent } from "react";
import { ArrowUp, CheckCircle, DotsSixVertical, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";

/** macOS 系统设置上方的置顶浮层：把当前 .app 真实拖入权限列表。 */
export function PermissionDragHelper() {
  const [dragging, setDragging] = useState(false);

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

  return (
    <main className="permission-helper" aria-label="MinuteFlow 权限拖拽助手">
      <button
        className={`permission-helper__app ${dragging ? "is-dragging" : ""}`}
        draggable
        onDragStart={startDrag}
        onDragEnd={() => setDragging(false)}
        aria-label="拖动 MinuteFlow 到系统设置应用列表"
      >
        <DotsSixVertical size={18} weight="bold" />
        <BrandMark size={42} />
        <span><strong>MinuteFlow</strong><small>按住并拖到上方列表</small></span>
      </button>
      <ArrowUp className="permission-helper__arrow" size={32} weight="bold" />
      <div className="permission-helper__copy">
        <strong>拖到“屏幕与系统音频录制”的应用列表</strong>
        <span>出现 MinuteFlow 后打开右侧开关；无法拖动时，可点列表下方的“+”选择应用。</span>
        <small><CheckCircle size={14} weight="fill" />只授予会议系统音频所需权限，不需要辅助功能权限</small>
      </div>
      <button className="permission-helper__close" onClick={() => api.system.closePermissionHelper()} aria-label="关闭引导">
        <X size={17} />
      </button>
    </main>
  );
}
