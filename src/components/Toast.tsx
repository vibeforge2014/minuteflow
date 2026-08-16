/**
 * 全局提示条：操作结果（导出完成、导入完成等）的轻量反馈。
 * 位置：工作区顶部居中悬浮；由 App 持有 message 状态统一调度。
 */
import { CheckCircle, X } from "@phosphor-icons/react";
import { useEffect } from "react";

/** 单条 Toast：message 变化后 5 秒自动关闭，也可手动点 X 关闭。 */
export function Toast({ message, onClose }: { message: string; onClose(): void }) {
  // 依赖 message：新提示弹出时重置计时器。
  useEffect(() => {
    const timer = window.setTimeout(onClose, 5_000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  return (
    <div className="toast" role="status">
      <CheckCircle size={19} weight="fill" />
      <span>{message}</span>
      <button onClick={onClose}><X size={15} /></button>
    </div>
  );
}

