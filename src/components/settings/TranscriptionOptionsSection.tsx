import { useEffect, useState } from 'react';
import type { ModelProfile } from '../../types';
import { applyTranscriptionPreset, identifyTranscriptionPreset, parameterRanges, transcriptionParamCapabilities, transcriptionPresets, type TranscriptionPreset } from '../../lib/transcription-presets';
import type { TranscriptionParameter } from '../../../shared/transcription-options.mjs';
const fields: {key: TranscriptionParameter; label: string; hint: string}[] = [
  {key:'temperature',label:'采样温度',hint:'越低越稳定，越高越多样。'},
  {key:'temperatureStep',label:'温度增量',hint:'解码失败后逐步升温；0 表示不升温。'},
  {key:'beamSize',label:'束宽',hint:'越大搜索越充分，也需要更多时间。'},
  {key:'noSpeechThreshold',label:'无语音阈值',hint:'配合对数概率识别无语音片段。'},
  {key:'logprobThreshold',label:'对数概率阈值',hint:'低于此值时触发解码回退。'},
  {key:'entropyThreshold',label:'熵阈值',hint:'超过此值时触发解码回退。'}
];
export function TranscriptionOptionsSection({profile, disabled, onChange, onValidityChange}: {profile: ModelProfile; disabled?: boolean; onChange(options: ModelProfile['options']): void; onValidityChange(invalid: boolean): void}) {
  const caps = transcriptionParamCapabilities(profile.transport, profile.options);
  const [draft, setDraft] = useState(profile.options);
  const [error, setError] = useState('');
  // 套用预设的即时反馈（本地已由「已生效」页级提示覆盖，这里补齐在线表单）。
  const [applied, setApplied] = useState('');
  useEffect(() => { setDraft(profile.options); setError(''); onValidityChange(false); }, [profile.options, onValidityChange]);
  // note 只由预设下拉传入：其他字段编辑会清掉上一条预设反馈，避免陈旧。
  const commit = (options: ModelProfile['options'], note = '') => { setError(''); setApplied(note); setDraft(options); onChange(options); };
  const preset = identifyTranscriptionPreset(draft, profile.transport);
  const speedUnavailable = !caps.includes('beamSize');
  const presetHint = preset === 'custom'
    ? '当前为自定义参数；选择任一预设会覆盖手动调整。'
    : `${transcriptionPresets.find(p => p.id === preset)?.description}${speedUnavailable ? '。当前引擎不开放束宽，速度优先不可用' : ''}`;
  if (profile.transport === 'parakeet-tdt') return <section className="transcription-options"><h3>转写预设</h3><p>识别语言由所选 Parakeet 模型固定。</p></section>;
  if (!caps.length) return null;
  const languages = profile.transport === 'sense-voice' ? ['auto','zh','en','ja','ko','yue'] : ['auto','zh','en'];
  const names: Record<string,string> = {auto:'自动识别',zh:'中文（简体）',en:'English',ja:'日本語',ko:'한국어',yue:'粤语'};
  return <section className="transcription-options" aria-label="转写预设">
    <h3>转写预设</h3>
    <label className="transcription-option"><span>预设方案</span><select aria-label="转写预设方案" value={preset} disabled={disabled} onChange={e => {
      const id = e.target.value as TranscriptionPreset;
      const next = applyTranscriptionPreset(draft, id, profile.transport);
      const parts = [id !== 'default' && caps.includes('beamSize') && next.beamSize !== undefined ? `束宽 ${next.beamSize}` : '', id !== 'default' && caps.includes('temperature') && next.temperature !== undefined ? `温度 ${next.temperature}` : ''].filter(Boolean);
      commit(next, `已套用「${transcriptionPresets.find(p => p.id === id)?.name}」${parts.length ? `（${parts.join('，')}）` : '，已清除手动解码参数'}`);
    }}>
      {transcriptionPresets.map(p => <option key={p.id} value={p.id} disabled={(p.id === 'speed' && speedUnavailable) || (p.id === 'accuracy' && !caps.includes('temperature') && !caps.includes('beamSize'))} title={p.id === 'speed' && speedUnavailable ? '当前引擎不开放束宽参数，速度优先仅限支持的本地引擎' : undefined}>{p.name}</option>)}
      <option value="custom" disabled title="手动修改任意参数后自动进入自定义">自定义</option>
    </select></label>
    <small>{presetHint}</small>
    {applied && <small role="status">{applied}</small>}
    <label className="transcription-option"><span>转写语言</span><select aria-label="模型转写语言" value={draft.transcriptionLanguage ?? ''} disabled={disabled} onChange={e => commit({...draft,transcriptionLanguage: (e.target.value || undefined) as ModelProfile['options']['transcriptionLanguage']})}>
      <option value="">跟随全局设置</option>{languages.map(language => <option key={language} value={language}>{names[language]}</option>)}
    </select></label>
    {caps.includes('initialPrompt') && <label className="transcription-option"><span>初始提示词</span><textarea aria-label="初始提示词" rows={2} maxLength={80} placeholder="会议主题、领域或专有名词（最多 80 字）" disabled={disabled} value={draft.initialPrompt ?? ''} onChange={e => setDraft({...draft,initialPrompt:e.target.value || undefined})} onBlur={() => {if (draft.initialPrompt !== profile.options.initialPrompt) commit(draft);}} /></label>}
    {caps.includes('temperature') && <details className="advanced-provider-options"><summary>高级设置</summary>
      {fields.filter(field => caps.includes(field.key)).map(({key,label,hint}) => {
        const [min,max,step] = parameterRanges[key];
        return <label className="transcription-option" key={key}><span>{label}<small>{hint} 范围 {min}–{max}；留空使用引擎默认。</small></span>
          <input key={`${profile.id}:${String(profile.options[key])}`} aria-label={label} type="number" min={min} max={max} step={step} placeholder="引擎默认" disabled={disabled} value={draft[key] as number | undefined ?? ''} onChange={e => {
            onValidityChange(!e.currentTarget.validity.valid);
            setDraft({...draft,[key]: e.target.value === '' ? undefined : Number(e.target.value)});
          }} onBlur={e => {
            if (!e.currentTarget.validity.valid) {setError(`${label}须在 ${min}–${max} 范围内${key === 'beamSize' ? '，并填写整数' : ''}。`); return;}
            if (draft[key] !== profile.options[key]) commit(draft);
          }} />
        </label>;
      })}
    </details>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </section>;
}
