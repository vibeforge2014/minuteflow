/**
 * 全局提示条：操作结果（导出完成、导入完成等）与错误/警告的轻量反馈。
 * 位置：工作区顶部居中悬浮；由 App 持有状态统一调度（成功提示与错误分通道叠放）。
 * 可选 action：提示附带一个直达入口（如“发现新版本”→ 打开软件更新），点击后执行并关闭。
 */
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect } from "react";

/** 单条 Toast：message 变化后自动关闭（普通 5 秒/警告 8 秒），也可手动点 X 关闭；warning 语气用于错误通道。 */
export function Toast({
  message,
  onClose,
  tone = "info",
  action
}: {
  message: string;
  onClose(): void;
  tone?: "info" | "warning";
  action?: { label: string; run(): void };
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
      {action && (
        <button className="toast__action" onClick={() => { action.run(); onClose(); }}>{action.label}</button>
      )}
      <button aria-label="关闭提示" onClick={onClose}><X size={15} /></button>
    </div>
  );
}
