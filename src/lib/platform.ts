/**
 * 平台判定与快捷键标签：macOS 显示 ⌘，Windows / Linux 显示 Ctrl。
 * 渲染层所有可见的快捷键提示都走这里，避免把 ⌘ 硬编码给非 Mac 用户。
 */
const platformHint = typeof navigator === "undefined"
  ? ""
  : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
    || "";

export const isMacPlatform = /Mac|iPod|iPhone|iPad/i.test(platformHint);

/** 主修饰键符号（不带空格，便于拼成 "⌘ K" / "Ctrl K"）。 */
export const modKeyLabel = isMacPlatform ? "⌘" : "Ctrl";

/** 组合成 "⌘ K" / "Ctrl K" 形式的标签。 */
export function shortcutLabel(key: string) {
  return `${modKeyLabel} ${key.toUpperCase()}`;
}
