import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CARD_COUNT_RANGE,
  DIFFICULTIES,
  SPEC_TEMPLATE_YAML,
  specFromYaml,
  specToYaml,
} from '../ai/deckSpec';
import CustomSelect from './CustomSelect';

// Two views of one spec: a form for people who want fields, and a YAML document
// for people who want a file they can keep, diff and re-run. Switching tabs
// never loses work — the YAML is regenerated from the spec on entry, and valid
// YAML is pushed back into the spec on every keystroke.

function SectionEditor({ sections, onChange }) {
  const { t } = useTranslation();

  function updateSection(index, patch) {
    onChange(sections.map((section, i) => (i === index ? { ...section, ...patch } : section)));
  }

  return (
    <div className="ai-sections">
      {sections.map((section, index) => (
        <div className="ai-section-row" key={index}>
          <div className="ai-section-row__head">
            <input
              className="st-input ai-section-row__name"
              value={section.name}
              onChange={(event) => updateSection(index, { name: event.target.value })}
              placeholder={t('builder.section_name_placeholder')}
              aria-label={t('builder.section_name_aria', { index: index + 1 })}
            />
            <label className="ai-section-row__count">
              <span className="sr-only">{t('builder.cards_in_section_label', { index: index + 1 })}</span>
              <input
                className="st-input"
                type="number"
                min="1"
                max={CARD_COUNT_RANGE.max}
                value={section.target_card_count}
                onChange={(event) => updateSection(index, { target_card_count: Number(event.target.value) })}
              />
              <span aria-hidden="true">{t('builder.cards_unit')}</span>
            </label>
            <button
              type="button"
              className="ai-icon-button"
              onClick={() => onChange(sections.filter((_, i) => i !== index))}
              aria-label={t('builder.remove_section_aria', { name: section.name || index + 1 })}
            >
              ×
            </button>
          </div>
          <input
            className="st-input"
            value={section.communicative_goal}
            onChange={(event) => updateSection(index, { communicative_goal: event.target.value })}
            placeholder={t('builder.section_goal_placeholder')}
            aria-label={t('builder.section_goal_aria', { index: index + 1 })}
          />
          <input
            className="st-input"
            value={section.lexical_focus.join(', ')}
            onChange={(event) => updateSection(index, {
              lexical_focus: event.target.value.split(',').map((word) => word.trim()).filter(Boolean),
            })}
            placeholder={t('builder.section_keywords_placeholder')}
            aria-label={t('builder.section_keywords_aria', { index: index + 1 })}
          />
        </div>
      ))}
      <button
        type="button"
        className="button button--secondary st-button--compact"
        onClick={() => onChange([...sections, { name: '', communicative_goal: '', lexical_focus: [], target_card_count: 5 }])}
      >
        {t('builder.add_section_btn')}
      </button>
    </div>
  );
}

function SpecForm({ spec, onChange }) {
  const { t } = useTranslation();
  // A shallow merge on purpose: normalizeSpec trims strings, and running it on
  // every keystroke would eat the space the moment the user types it, making
  // multi-word titles impossible. The spec is normalized where it matters —
  // when it is serialized to YAML and when a run starts.
  const patch = (fields) => onChange({ ...spec, ...fields });

  return (
    <div className="st-form">
      <div className="st-form__grid">
        <label className="st-field">
          <span className="st-field__label">{t('builder.deck_title_label')}</span>
          <input
            className="st-input"
            value={spec.title}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder={t('builder.deck_title_placeholder')}
          />
        </label>
        <div className="st-field">
          <span className="st-field__label">{t('builder.difficulty_label')}</span>
          <CustomSelect
            value={spec.difficulty}
            onChange={(difficulty) => patch({ difficulty })}
            options={DIFFICULTIES.map((level) => ({
              value: level,
              label: t(`builder.difficulty_${level}`, { defaultValue: level }),
            }))}
            ariaLabel={t('builder.difficulty_label')}
          />
        </div>
      </div>

      <label className="st-field">
        <span className="st-field__label">{t('builder.deck_desc_label')}</span>
        <input
          className="st-input"
          value={spec.description}
          onChange={(event) => patch({ description: event.target.value })}
          placeholder={t('builder.deck_desc_spec_placeholder')}
        />
        <span className="ai-provider__hint">{t('builder.deck_desc_hint')}</span>
      </label>

      <label className="st-field">
        <span className="st-field__label">{t('builder.topic_label')}</span>
        <input
          className="st-input"
          value={spec.topic}
          onChange={(event) => patch({ topic: event.target.value })}
          placeholder={t('builder.topic_spec_placeholder')}
        />
      </label>

      <label className="st-field">
        <span className="st-field__label">{t('builder.who_is_for_label')}</span>
        <input
          className="st-input"
          value={spec.learner_profile}
          onChange={(event) => patch({ learner_profile: event.target.value })}
          placeholder={t('builder.learner_profile_spec_placeholder')}
        />
      </label>

      <label className="st-field">
        <span className="st-field__label">{t('builder.notes_label')}</span>
        <textarea
          className="st-input ai-textarea"
          rows={2}
          value={spec.generation_notes}
          onChange={(event) => patch({ generation_notes: event.target.value })}
          placeholder={t('builder.notes_spec_placeholder')}
        />
      </label>

      <label className="st-field">
        <span className="st-field__label">
          {t('builder.cards_to_generate_label', { count: spec.target_card_count })}
        </span>
        <input
          className="ai-range"
          type="range"
          min={CARD_COUNT_RANGE.min}
          max={CARD_COUNT_RANGE.max}
          step="1"
          value={spec.target_card_count}
          onChange={(event) => patch({ target_card_count: Number(event.target.value) })}
        />
        <span className="ai-provider__hint">
          {t('builder.cards_cost_hint')}
        </span>
      </label>

      <div className="st-field">
        <span className="st-field__label">{t('builder.sections_title')}</span>
        {spec.sections.length === 0 ? (
          <div className="ai-empty-inline">
            <p className="st-section__hint">
              {t('builder.ai_plan_sections_hint')}
            </p>
            <button
              type="button"
              className="button button--secondary st-button--compact"
              onClick={() => patch({
                sections: [{ name: '', communicative_goal: '', lexical_focus: [], target_card_count: 5 }],
              })}
            >
              {t('builder.plan_sections_myself_btn')}
            </button>
          </div>
        ) : (
          <>
            <SectionEditor sections={spec.sections} onChange={(sections) => patch({ sections })} />
            <button
              type="button"
              className="ai-link"
              onClick={() => patch({ sections: [] })}
            >
              {t('builder.let_ai_plan_sections_btn')}
            </button>
          </>
        )}
      </div>

      <details className="ai-details">
        <summary>{t('builder.quality_gates_summary')}</summary>
        <div className="ai-details__body">
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">{t('builder.audit_examples_label')}</span>
              <span className="st-row__meta">
                {t('builder.audit_examples_meta')}
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={spec.quality.example_audit}
                onChange={(event) => patch({ quality: { ...spec.quality, example_audit: event.target.checked } })}
                aria-label={t('builder.audit_examples_label')}
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">{t('builder.curated_options_label')}</span>
              <span className="st-row__meta">
                {t('builder.curated_options_meta')}
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={spec.quality.cloze_options}
                onChange={(event) => patch({
                  quality: {
                    ...spec.quality,
                    cloze_options: event.target.checked,
                    cloze_audit: event.target.checked && spec.quality.cloze_audit,
                  },
                })}
                aria-label={t('builder.curated_options_label')}
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>
          <div className="st-row">
            <div className="st-row__info">
              <span className="st-row__label">{t('builder.blind_solve_label')}</span>
              <span className="st-row__meta">
                {t('builder.blind_solve_meta')}
              </span>
            </div>
            <label className="st-switch">
              <input
                type="checkbox"
                checked={spec.quality.cloze_audit}
                disabled={!spec.quality.cloze_options}
                onChange={(event) => patch({ quality: { ...spec.quality, cloze_audit: event.target.checked } })}
                aria-label={t('builder.blind_solve_label')}
              />
              <span className="st-switch__track" aria-hidden="true" />
            </label>
          </div>
          <div className="st-form__grid">
            <label className="st-field">
              <span className="st-field__label">{t('builder.repair_attempts_label')}</span>
              <input
                className="st-input"
                type="number"
                min="0"
                max="4"
                value={spec.quality.max_repairs}
                onChange={(event) => patch({ quality: { ...spec.quality, max_repairs: Number(event.target.value) } })}
              />
            </label>
            <label className="st-field">
              <span className="st-field__label">{t('builder.source_language_label')}</span>
              <input
                className="st-input"
                value={spec.language_from}
                onChange={(event) => patch({ language_from: event.target.value })}
                maxLength={5}
              />
            </label>
            <label className="st-field">
              <span className="st-field__label">{t('builder.target_language_label')}</span>
              <input
                className="st-input"
                value={spec.language_to}
                onChange={(event) => patch({ language_to: event.target.value })}
                maxLength={5}
              />
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}

function SpecYaml({ spec, onChange }) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => specToYaml(spec));
  const [error, setError] = useState(null);
  const fileInput = useRef(null);
  // Only re-seed the editor from the spec when the change came from elsewhere
  // (the form, the assistant), never while the user is typing YAML.
  const lastEmitted = useRef(text);

  useEffect(() => {
    const next = specToYaml(spec);
    if (next !== lastEmitted.current) {
      lastEmitted.current = next;
      setText(next);
      setError(null);
    }
  }, [spec]);

  function handleText(nextText) {
    setText(nextText);
    const { spec: parsed, error: parseError } = specFromYaml(nextText);
    setError(parseError);
    if (parsed) {
      lastEmitted.current = specToYaml(parsed);
      onChange(parsed);
    }
  }

  function handleDownload() {
    const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(spec.title || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.deck.yaml`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    handleText(await file.text());
    event.target.value = '';
  }

  return (
    <div className="ai-yaml">
      <textarea
        className="st-input ai-yaml__editor"
        value={text}
        spellCheck="false"
        onChange={(event) => handleText(event.target.value)}
        aria-label={t('builder.yaml_editor_aria')}
        aria-invalid={Boolean(error)}
      />
      {error ? <p className="st-error">{t('builder.yaml_error', { error })}</p> : <p className="st-success">{t('builder.yaml_valid')}</p>}
      <div className="st-actions">
        <button type="button" className="button button--secondary st-button--compact" onClick={handleDownload}>
          {t('builder.download_yaml_btn')}
        </button>
        <button
          type="button"
          className="button button--secondary st-button--compact"
          onClick={() => fileInput.current?.click()}
        >
          {t('builder.load_yaml_btn')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json,text/yaml,application/json"
          className="sr-only"
          onChange={handleUpload}
        />
        <button type="button" className="ai-link" onClick={() => handleText(SPEC_TEMPLATE_YAML)}>
          {t('builder.template_yaml_btn')}
        </button>
      </div>
    </div>
  );
}

function DeckSpecEditor({ spec, onChange }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('form');

  return (
    <div className="ai-spec-editor">
      <div className="ai-tabs" role="tablist" aria-label={t('builder.spec_view_aria')}>
        {[['form', t('builder.spec_form_tab')], ['yaml', t('builder.spec_yaml_tab')]].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`ai-tab${tab === id ? ' ai-tab--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'form'
        ? <SpecForm spec={spec} onChange={onChange} />
        : <SpecYaml spec={spec} onChange={onChange} />}
    </div>
  );
}

export default DeckSpecEditor;
