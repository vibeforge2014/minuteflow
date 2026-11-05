import { CaretRight, Cloud, Cpu, FingerprintSimple, Plus, Waveform, X, PencilSimple } from "@phosphor-icons/react";
import type { SettingsProfileDraft } from "../../lib/settings-drafts";
import type { ModelProfile } from "../../types";

export type SettingsServiceItem = { profile: ModelProfile; subtitle: string; issue: boolean; draft?: boolean };
export type SettingsServiceGroup = { title: string; items: SettingsServiceItem[] };
export type SettingsServiceChoice = { key: string; name: string; description: string; local: boolean; enhancement?: boolean };

export function SettingsServiceList({ groups, onEdit, onDefault, switchingId, disabled }: {
  groups: SettingsServiceGroup[]; onEdit(profile: ModelProfile): void; onDefault(profile: ModelProfile): void; switchingId: string | null; disabled: boolean;
}) {
  return <>{groups.filter((group) => group.items.length).map((group) => <section className="settings-service-group" key={group.title}>
    <h3>{group.title}</h3>
    <div className="settings-service-list">
      {group.items.map(({ profile, subtitle, issue, draft }) => <div className="settings-service-row" key={profile.id}>
        <button type="button" className="settings-service-row__main" aria-label={`编辑 ${profile.name}`} disabled={disabled} onClick={() => onEdit(profile)}>
          <span className="settings-service-row__icon">{profile.kind === "diarization" ? <FingerprintSimple size={21} /> : group.title === "在线服务" ? <Cloud size={21} /> : profile.kind === "stt" ? <Waveform size={21} /> : <Cpu size={21} />}</span>
          <span><strong>{profile.name}</strong>{draft ? <small className="settings-unsaved">未保存更改</small> : subtitle && <small className={issue ? "is-issue" : undefined}>{subtitle}</small>}</span>
        </button>
        {profile.isDefault ? <span className="settings-default">默认</span> : <button type="button" className="settings-default-action" disabled={disabled || Boolean(switchingId)} aria-label={`将 ${profile.name} 设为默认`} onClick={() => onDefault(profile)}>{switchingId === profile.id ? "设置中…" : "设为默认"}</button>}
        <span className="settings-service-row__open" aria-hidden="true"><CaretRight size={17} /></span>
      </div>)}
    </div>
  </section>)}</>;
}

export function SettingsServiceChooser({ choices, onChoose, disabled }: {
  choices: SettingsServiceChoice[]; onChoose(key: string): void; disabled: boolean;
}) {
  const groups = [
    { title: "在本机运行", items: choices.filter((choice) => choice.local && !choice.enhancement) },
    { title: "在线服务", items: choices.filter((choice) => !choice.local) },
    { title: "可选增强", items: choices.filter((choice) => choice.enhancement) }
  ];
  return <div className="settings-service-chooser">{groups.filter((group) => group.items.length).map((group) => <section className="settings-service-group" key={group.title}>
    <h3>{group.title}</h3><div className="settings-service-list">
      {group.items.map((choice) => <button key={choice.key} type="button" className="settings-choice" disabled={disabled} onClick={() => onChoose(choice.key)}>
        <span className="settings-service-row__icon">{choice.enhancement ? <FingerprintSimple size={22} /> : choice.local ? <Cpu size={22} /> : <Cloud size={22} />}</span>
        <span><strong>{choice.name}</strong><small>{choice.description}</small></span><CaretRight size={17} />
      </button>)}
    </div>
  </section>)}</div>;
}

export function SettingsEnhancementEntry({ onClick, disabled }: { onClick(): void; disabled: boolean }) {
  return <section className="settings-service-group settings-service-group--enhancement"><h3>说话人分离</h3><div className="settings-service-list"><button type="button" className="settings-choice" disabled={disabled} onClick={onClick}>
    <span className="settings-service-row__icon"><FingerprintSimple size={22} /></span><span><strong>添加说话人分离</strong><small>为逐字稿区分发言人</small></span><Plus size={18} />
  </button></div></section>;
}

/** Draft rows never take part in the saved/default profile list. */
export function SettingsDraftList({ drafts, onResume, onDiscard }: {
  drafts: SettingsProfileDraft[]; onResume(draft: SettingsProfileDraft): void; onDiscard(draft: SettingsProfileDraft): void;
}) {
  return <section className="settings-service-group settings-draft-group"><h3>本次设置草稿</h3><div className="settings-service-list">
    {drafts.map((draft) => <div className="settings-service-row" key={draft.id}>
      <button type="button" className="settings-service-row__main" aria-label={`继续配置 ${draft.profile.name.trim() || "未命名配置"}`} onClick={() => onResume(draft)}>
        <span className="settings-service-row__icon"><PencilSimple size={20} /></span><span><strong>{draft.profile.name.trim() || "未命名配置"}</strong><small>{draft.profile.model || "尚未选择模型"}</small></span>
      </button>
      <span className="settings-default-action settings-draft-resume-label" aria-hidden="true">继续配置</span>
      <button type="button" className="icon-button settings-draft-discard" aria-label={`放弃 ${draft.profile.name.trim() || "未命名配置"} 的未保存配置`} title="放弃未保存配置" onClick={() => onDiscard(draft)}><X size={15} /></button>
    </div>)}
  </div></section>;
}
