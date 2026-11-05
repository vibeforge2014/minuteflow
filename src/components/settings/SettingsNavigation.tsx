import { ArrowClockwise, GearSix, ShieldCheck, Sparkle, Waveform } from "@phosphor-icons/react";
import type { SettingsTab } from "../SettingsDialog";

export const SETTINGS_PAGES = [
  { id: "general", title: "通用设置", description: "会议偏好、常用术语与应用授权。", icon: GearSix },
  { id: "transcription", title: "转录设置", description: "将会议录音转为逐字稿。", icon: Waveform },
  { id: "llm", title: "AI 总结", description: "从逐字稿提炼结论、决策与行动项。", icon: Sparkle },
  { id: "storage", title: "存储与隐私", description: "管理录音保留方式与系统权限。", icon: ShieldCheck },
  { id: "updates", title: "软件更新", description: "获取 MinuteFlow 的最新版本。", icon: ArrowClockwise }
] as const;

export function SettingsNavigation({ value, onChange, disabled, showUpdates }: {
  value: SettingsTab; onChange(value: SettingsTab): void; disabled: boolean; showUpdates: boolean;
}) {
  return <nav className="settings-nav" aria-label="设置分类">
    <div className="settings-nav__title"><span id="settings-dialog-title">设置</span></div>
    <div className="settings-nav__group">
      {SETTINGS_PAGES.filter((page) => page.id !== "updates" || showUpdates).map(({ id, title, icon: Icon }) => (
        <button key={id} disabled={disabled} aria-current={value === id ? "page" : undefined} className={value === id ? "is-active" : ""} onClick={() => onChange(id)}><Icon size={19} /><span>{title}</span></button>
      ))}
    </div>
    <div className="settings-nav__brand"><Waveform size={18} /><span>MinuteFlow</span></div>
  </nav>;
}
