import { useEffect, useState } from 'react';
import type { ModelProfile } from '../../types';
import { applyTranscriptionPreset, availableTranscriptionPresets, identifyTranscriptionPreset, parameterRanges, transcriptionParamCapabilities, type TranscriptionPreset } from '../../lib/transcription-presets';
import type { TranscriptionNumericParameter } from '../../../shared/transcription-options.mjs';
const fields: {key: TranscriptionNumericParameter; label: string; hint: string}[] = [
  {key:'temperature',label:'采样温度',hint:'越低越稳定，越高越多样。'},
  {key:'temperatureStep',label:'温度增量',hint:'解码失败后逐步升温；0 表示不升温。'},
  {key:'beamSize',label:'束宽',hint:'越大搜索越充分，也需要更多时间。'},
  {key:'bestOf',label:'采样候选数',hint:'温度高于 0 时比较多个候选。候选越多，通常耗时越长。'},
  {key:'noSpeechThreshold',label:'无语音阈值',hint:'配合对数概率识别无语音片段。'},
  {key:'logprobThreshold',label:'对数概率阈值',hint:'低于此值时触发解码回退。'},
  {key:'entropyThreshold',label:'熵阈值',hint:'超过此值时触发解码回退。'},
  {key:'compressionRatioThreshold',label:'重复文本阈值',hint:'文本重复度超过此值时重试解码。'},
  {key:'cpuThreads',label:'CPU 线程数',hint:'降低线程数可为其他应用留出 CPU 资源。'}
];
const switches = [
  {key: 'usePreviousText', label: '沿用前文', hint: '把前一片段的转写尾部作为提示。遇到反复输出相同文字时，可尝试关闭。'},
  {key: 'vadFilter', label: '语音活动检测', hint: 'Faster Whisper 在识别前过滤非语音。如果轻声发言被漏掉，可尝试关闭。'}
] as const;
export function TranscriptionOptionsSection({profile, disabled, onChange, onValidityChange}: {profile: ModelProfile; disabled?: boolean; onChange(options: ModelProfile['options']): void; onValidityChange(invalid: boolean): void}) {
  const caps = transcriptionParamCapabilities(profile.transport, profile.options);
  const [draft, setDraft] = useState(profile.options);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(profile.options); setError(''); onValidityChange(false);
    // 卸载（切到别的服务页/关闭设置）时复位校验状态，避免把本页的
    // 非法输入状态泄漏给下一个服务页的「保存配置」按钮。
    return () => onValidityChange(false);
  }, [profile.options, onValidityChange]);
  const commit = (options: ModelProfile['options']) => { setError(''); setDraft(options); onChange(options); };
  const presets = availableTranscriptionPresets(profile.transport, draft);
  const preset = identifyTranscriptionPreset(draft, profile.transport);
  if (profile.transport === 'parakeet-tdt') return <section className="transcription-options"><h3>转写语言</h3><p>识别语言由所选 Parakeet 模型固定。</p></section>;
  if (!caps.length) return null;
  const languages = profile.transport === 'sense-voice' ? ['auto','zh','en','ja','ko','yue'] : ['auto','zh','en'];
  const names: Record<string,string> = {auto:'自动识别',zh:'中文（简体）',en:'English',ja:'日本語',ko:'한국어',yue:'粤语'};
  return <section className="transcription-options" aria-label="模型转写设置">
    <h3>转写设置</h3>
    {presets.length > 0 && (
      <label className="transcription-option">
        <span>解码预设</span>
        <select aria-label="解码预设" value={preset} disabled={disabled} onChange={event => {
          commit(applyTranscriptionPreset(draft, event.target.value as TranscriptionPreset, profile.transport));
        }}>
          {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          {preset === 'custom' && <option value="custom" disabled>自定义</option>}
        </select>
      </label>
    )}
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
            if (!e.currentTarget.validity.valid) {setError(`${label}须在 ${min}–${max} 范围内${step === 1 ? '，并填写整数' : ''}。`); return;}
            if (draft[key] !== profile.options[key]) commit(draft);
          }} />
        </label>;
      })}
      {switches.filter(field => caps.includes(field.key)).map(({ key, label, hint }) => (
        <label className="transcription-option" key={key}>
          <span>{label}<small>{hint}</small></span>
          <select aria-label={label} value={draft[key] === false ? 'off' : 'on'} disabled={disabled}
            onChange={event => commit({ ...draft, [key]: event.target.value === 'off' ? false : undefined })}>
            <option value="on">开启</option>
            <option value="off">关闭</option>
          </select>
        </label>
      ))}
    </details>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </section>;
}
