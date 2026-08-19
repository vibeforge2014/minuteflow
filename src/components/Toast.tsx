/**
 * 全局提示条：操作结果（导出完成、导入完成等）与错误/警告的轻量反馈。
 * 位置：工作区顶部居中悬浮；由 App 持有状态统一调度（成功提示与错误分通道叠放）。
 */
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect } from "react";

/** 单条 Toast：message 变化后 5 秒自动关闭，也可手动点 X 关闭；warning 语气用于错误通道。 */
export function Toast({
  message,
  onClose,
  tone = "info"
}: {
  message: string;
  onClose(): void;
  tone?: "info" | "warning";
}) {
  // 依赖 message：新提示弹出时重置计时器。
  useEffect(() => {
    const timer = window.setTimeout(onClose, tone === "warning" ? 8_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [message, onClose, tone]);
  return (
    <div className={`toast ${tone === "warning" ? "toast--warning" : ""}`} role={tone === "warning" ? "alert" : "status"}>
      {tone === "warning" ? <WarningCircle size={19} weight="fill" /> : <CheckCircle size={19} weight="fill" />}
      <span>{message}</span>
      <button aria-label="关闭提示" onClick={onClose}><X size={15} /></button>
    </div>
  );
}
