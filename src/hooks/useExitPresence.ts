import { useEffect, useState } from "react";

/**
 * 对话框/面板的退场保持：open 变为 false 后延迟 exitMs 才真正卸载，期间 closing 为 true，
 * 供根元素附加 is-closing 类播放与入场对称的收回动画（空间连续性：从哪里浮出，就收回哪里）。
 * @param open 组件的业务开关
 * @param exitMs 退场动画时长（毫秒），需与 CSS 中 is-closing 的动画时长一致
 * @returns mounted 为 false 时组件应返回 null；closing 用于拼接 is-closing 类名
 */
export function useExitPresence(open: boolean, exitMs = 180) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return undefined;
    }
    if (!mounted) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted, closing };
}
