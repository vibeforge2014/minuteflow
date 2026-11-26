/**
 * 热词库与自定义术语交互组件（设置 → 通用设置）。
 *
 * 替代纯文本多行输入框，提供更直观的配置体验：
 * 1. 内置领域词库：5 个高频领域一键常驻勾选，支持展开预览内置术语与同音纠错映射；
 * 2. 自定义术语：标准术语 + 可选「常见误听」快捷输入，回车即添加为可删除标签，
 *    支持粘贴多条批量添加，同时保留「批量编辑」切换以兼顾重度用户。
 */
import { useMemo, useState } from "react";
import { CaretDown, CaretUp, Plus, X } from "@phosphor-icons/react";
import {
  HOTWORD_DOMAINS,
  formatGlossaryEntry,
  parseGlossaryEntry
} from "../../../shared/hotword-domains.mjs";

interface GlossarySettingsSectionProps {
  glossary: string[];
  hotwordDomains: string[];
  onChangeGlossary(next: string[]): void;
  onChangeDomains(next: string[]): void;
}

const RECOMMENDED_TERM_BUDGET = 20;
const QUICK_EXAMPLES = ["MinuteFlow", "Q3 复盘", "SKU"];

export function GlossarySettingsSection({
  glossary,
  hotwordDomains,
  onChangeGlossary,
  onChangeDomains
}: GlossarySettingsSectionProps) {
  const [termInput, setTermInput] = useState("");
  const [aliasInput, setAliasInput] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [batchDraft, setBatchDraft] = useState("");
  const [previewDomainId, setPreviewDomainId] = useState<string | null>(null);

  const entries = useMemo(() => {
    return glossary.map((raw, index) => {
      const parsed = parseGlossaryEntry(raw);
      return {
        index,
        raw,
        term: parsed?.term ?? raw,
        aliases: parsed?.aliases ?? []
      };
    });
  }, [glossary]);

  const addEntries = (rawTerm: string, rawAlias: string) => {
    const trimmedTerm = rawTerm.trim();
    const trimmedAlias = rawAlias.trim();
    if (!trimmedTerm) return;

    // 支持直接粘贴换行/逗号/顿号分隔的多条术语（未填误听词时自动拆分批量添加）。
    const hasBatchSeparator = !trimmedAlias && /[\n\r,，、;；]/.test(trimmedTerm);
    const incoming = hasBatchSeparator
      ? trimmedTerm.split(/[\n\r,，、;；]+/).map((item) => item.trim()).filter(Boolean)
      : [
          trimmedAlias
            ? formatGlossaryEntry({
                term: trimmedTerm,
                aliases: trimmedAlias.split(/[、,，;；/]+/).map((item) => item.trim()).filter(Boolean)
              })
            : trimmedTerm
        ];

    const byTerm = new Map<string, { term: string; aliases: string[] }>();
    for (const item of glossary) {
      const parsed = parseGlossaryEntry(item);
      if (!parsed) continue;
      byTerm.set(parsed.term.toLowerCase(), { term: parsed.term, aliases: [...parsed.aliases] });
    }
    for (const raw of incoming) {
      const parsed = parseGlossaryEntry(raw);
      if (!parsed) continue;
      const key = parsed.term.toLowerCase();
      const existing = byTerm.get(key);
      if (existing) {
        existing.term = parsed.term;
        existing.aliases = [...new Set([...existing.aliases, ...parsed.aliases])];
      } else {
        byTerm.set(key, { term: parsed.term, aliases: [...parsed.aliases] });
      }
    }
    const next = [...byTerm.values()].map(formatGlossaryEntry).filter(Boolean);
    onChangeGlossary(next);
    setTermInput("");
    setAliasInput("");
  };

  const removeEntry = (targetIndex: number) => {
    onChangeGlossary(glossary.filter((_, idx) => idx !== targetIndex));
  };

  const enterBatchMode = () => {
    setBatchDraft(glossary.join("\n"));
    setBatchMode(true);
  };

  const commitBatchMode = () => {
    const lines = batchDraft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const line of lines) {
      const parsed = parseGlossaryEntry(line);
      if (!parsed) continue;
      const key = parsed.term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(formatGlossaryEntry(parsed));
    }
    onChangeGlossary(normalized);
    setBatchMode(false);
  };

  const previewDomain = HOTWORD_DOMAINS.find((d) => d.id === previewDomainId) ?? null;

  return (
    <section className="settings-preference-section">
      <h2>热词库与自定义术语</h2>
      <div className="settings-card settings-card--stacked glossary-studio">
        <div className="hotword-domains" role="group" aria-label="内置领域热词库">
          <div className="hotword-domains__head">
            <strong>内置领域词库</strong>
            <div className="hotword-domains__meta">
              <span>{hotwordDomains.length > 0 ? `已常驻 ${hotwordDomains.length} 个领域` : "自动按会议内容匹配"}</span>
              <button
                type="button"
                className="text-button hotword-domains__peek"
                aria-expanded={Boolean(previewDomain)}
                onClick={() => setPreviewDomainId(previewDomain ? null : (hotwordDomains[0] ?? HOTWORD_DOMAINS[0].id))}
              >
                {previewDomain ? <>收起词表<CaretUp size={12} /></> : <>查看词表<CaretDown size={12} /></>}
              </button>
            </div>
          </div>
          <div className="hotword-domains__chips">
            {HOTWORD_DOMAINS.map((domain) => {
              const active = hotwordDomains.includes(domain.id);
              return (
                <button
                  key={domain.id}
                  type="button"
                  className={`hotword-domain-chip ${active ? "is-active" : ""}`}
                  aria-pressed={active}
                  title={`点击${active ? "取消常驻" : "常驻启用"}；含 ${domain.terms.length} 个术语及同音纠错别名`}
                  onClick={() => {
                    const next = active
                      ? hotwordDomains.filter((id) => id !== domain.id)
                      : [...hotwordDomains, domain.id];
                    onChangeDomains(next);
                    if (previewDomain) setPreviewDomainId(domain.id);
                  }}
                >
                  <span>{domain.label}</span>
                  <small>{domain.terms.length}</small>
                </button>
              );
            })}
          </div>
          {previewDomain && (
            <div className="hotword-domain-preview" aria-label={`${previewDomain.label}内置词表预览`}>
              <div className="hotword-domain-preview__tabs" role="tablist">
                {HOTWORD_DOMAINS.map((domain) => (
                  <button
                    key={domain.id}
                    type="button"
                    role="tab"
                    aria-selected={previewDomain.id === domain.id}
                    className={previewDomain.id === domain.id ? "is-active" : ""}
                    onClick={() => setPreviewDomainId(domain.id)}
                  >
                    {domain.label}
                  </button>
                ))}
              </div>
              <div className="hotword-domain-preview__list">
                {previewDomain.terms.map((entry) => (
                  <span className="hotword-preview-tag" key={entry.term}>
                    <strong>{entry.term}</strong>
                    {entry.aliases?.length ? <small>← {entry.aliases.slice(0, 2).join(" / ")}</small> : null}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="glossary-custom">
          <div className="glossary-custom__head">
            <div className="glossary-custom__title">
              <strong>自定义术语</strong>
              <span
                className={`glossary-custom__count ${entries.length > RECOMMENDED_TERM_BUDGET ? "is-over" : ""}`}
                title="前 20 条优先进入语音识别提示词，全部条目都会用于 AI 语义校对"
              >
                {entries.length} / {RECOMMENDED_TERM_BUDGET}
              </span>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => (batchMode ? commitBatchMode() : enterBatchMode())}
            >
              {batchMode ? "完成批量编辑" : "批量编辑"}
            </button>
          </div>

          {batchMode ? (
            <div className="glossary-batch">
              <textarea
                rows={6}
                aria-label="批量编辑自定义术语"
                value={batchDraft}
                onChange={(event) => setBatchDraft(event.target.value)}
                onBlur={commitBatchMode}
                placeholder={"每行一个，支持写同音误听：\nMinuteFlow = 密尼特弗洛\nQ3 复盘\nSKU"}
              />
            </div>
          ) : (
            <>
              <div className="glossary-composer">
                <input
                  type="text"
                  className="glossary-composer__term"
                  aria-label="标准术语"
                  value={termInput}
                  placeholder="标准术语（如 MinuteFlow、张伟，支持粘贴多条）"
                  onChange={(event) => setTermInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addEntries(termInput, aliasInput);
                    }
                  }}
                />
                <input
                  type="text"
                  className="glossary-composer__alias"
                  aria-label="常见误听（选填）"
                  value={aliasInput}
                  placeholder="常见误听（选填）"
                  onChange={(event) => setAliasInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addEntries(termInput, aliasInput);
                    }
                  }}
                />
                <button
                  type="button"
                  className="button button--small glossary-composer__add"
                  disabled={!termInput.trim()}
                  onClick={() => addEntries(termInput, aliasInput)}
                >
                  <Plus size={14} weight="bold" />添加
                </button>
              </div>

              {entries.length > 0 ? (
                <div className="glossary-chips" role="list" aria-label="已添加的自定义术语">
                  {entries.map((entry) => (
                    <span className="glossary-chip" role="listitem" key={`${entry.index}:${entry.raw}`}>
                      <strong>{entry.term}</strong>
                      {entry.aliases.length > 0 && (
                        <small title={`遇到「${entry.aliases.join(" / ")}」自动纠错为「${entry.term}」`}>
                          ← {entry.aliases.join(" / ")}
                        </small>
                      )}
                      <button
                        type="button"
                        className="glossary-chip__remove"
                        aria-label={`移除术语 ${entry.term}`}
                        onClick={() => removeEntry(entry.index)}
                      >
                        <X size={11} weight="bold" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="glossary-empty">
                  <span>试试添加：</span>
                  {QUICK_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="glossary-example-pill"
                      onClick={() => addEntries(example, "")}
                    >
                      <Plus size={11} />{example}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
