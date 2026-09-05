import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getEffectiveAiCredential,
  reviewSingleCard,
  generateCardFixes,
  diffSingleCard,
} from '../ai/singleCardReview';
import { getLanguage } from '../languages';

function CardDetailsModal({
  card,
  isPending = false,
  startInEditMode = false,
  onClose,
  onSave,
  onToggle,
  onDelete = undefined,
  deck = undefined,
}) {
  const { t } = useTranslation();
  const sourceLang = getLanguage(deck?.language_from ?? card?.language_from ?? 'es');
  const targetLang = getLanguage(deck?.language_to ?? card?.language_to ?? 'en');
  const sourceLabel = sourceLang?.name ?? 'Prompt';
  const targetLabel = targetLang?.name ?? 'Answer';
  const canEdit = typeof onSave === 'function';
  const canToggle = typeof onToggle === 'function' && typeof card.is_enabled === 'boolean';
  const canDelete = typeof onDelete === 'function';
  const toggleLabel = card.is_enabled ? t('card_details.hide_card') : t('card_details.show_card');
  const [isEditing, setIsEditing] = useState(startInEditMode && canEdit);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [formValues, setFormValues] = useState(() => buildFormValues(card));

  // AI Review states: 'idle' | 'reviewing' | 'reviewed' | 'fixing' | 'fixes_ready' | 'no_key' | 'error'
  const [aiStage, setAiStage] = useState('idle');
  const [aiResult, setAiResult] = useState(null);
  const [aiProposedFix, setAiProposedFix] = useState(null);
  const [aiError, setAiError] = useState('');
  const [aiNotification, setAiNotification] = useState('');
  const [isSavingAiFixes, setIsSavingAiFixes] = useState(false);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    setIsEditing(startInEditMode && canEdit);
    setIsConfirmingDelete(false);
    setSaveError('');
    setFormValues(buildFormValues(card));
    setAiStage('idle');
    setAiResult(null);
    setAiProposedFix(null);
    setAiError('');
    setAiNotification('');
  }, [canEdit, card.card_id, startInEditMode]);

  function updateField(name, value) {
    setFormValues((current) => ({ ...current, [name]: value }));
  }

  function updateExamplePair(index, field, value) {
    setFormValues((current) => {
      const updatedExamples = current.examples.map((pair, idx) => {
        if (idx !== index) return pair;
        const next = { ...pair, [field]: value };
        if (field === 'l1' || field === 'es') {
          next.l1 = value;
          next.es = value;
        } else if (field === 'l2' || field === 'en') {
          next.l2 = value;
          next.en = value;
        }
        return next;
      });
      const first = updatedExamples[0] ?? { l1: '', l2: '', es: '', en: '' };
      return {
        ...current,
        examples: updatedExamples,
        example_l1: first.l1,
        example_es: first.l1,
        example_l2: first.l2,
        example_en: first.l2,
        example_sentence: first.l2,
      };
    });
  }

  function getCurrentCardData() {
    const cleanedExamples = formValues.examples
      .map((pair) => {
        const l1 = (pair.l1 || pair.es || '').trim();
        const l2 = (pair.l2 || pair.en || '').trim();
        return { l1, l2 };
      })
      .filter((pair) => pair.l1 || pair.l2);
    const first = cleanedExamples[0] ?? null;
    const prompt = (formValues.prompt_l1 || '').trim();
    const answer = (formValues.answer_l2 || '').trim();
    const definition = nullableText(formValues.l2_definition);
    const translations = splitMultiline(formValues.l1_translations ?? '');
    const synonyms = splitMultiline(formValues.l2_synonyms ?? '');

    return {
      ...card,
      prompt_l1: prompt,
      answer_l2: answer,
      section_name: nullableText(formValues.section_name),
      part_of_speech: nullableText(formValues.part_of_speech),
      l2_definition: definition,
      l1_translations: translations,
      collocations: splitMultiline(formValues.collocations),
      l2_synonyms: synonyms,
      examples: cleanedExamples,
      example_sentence: first ? first.l2 : null,
      example_l1: first ? first.l1 : null,
      example_l2: first ? first.l2 : null,
    };
  }

  async function handleStartAiReview() {
    setAiNotification('');
    setAiError('');
    setSaveError('');

    const credential = getEffectiveAiCredential();
    if (!credential) {
      setAiStage('no_key');
      return;
    }

    setAiStage('reviewing');
    setAiResult(null);
    setAiProposedFix(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const currentData = getCurrentCardData();
      const result = await reviewSingleCard(currentData, {
        deck,
        signal: controller.signal,
      });

      setAiResult(result);
      setAiStage('reviewed');
    } catch (err) {
      if (err?.name === 'AbortError') {
        setAiStage('idle');
        return;
      }
      setAiError(err?.message || t('card_details.ai_error_review'));
      setAiStage('error');
    }
  }

  async function handleGenerateFixes() {
    if (!aiResult) return;

    setAiNotification('');
    setAiError('');
    setAiStage('fixing');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const currentData = getCurrentCardData();
      const fixes = await generateCardFixes(currentData, aiResult, {
        deck,
        signal: controller.signal,
      });

      setAiProposedFix(fixes);
      setAiStage('fixes_ready');
    } catch (err) {
      if (err?.name === 'AbortError') {
        setAiStage('reviewed');
        return;
      }
      setAiError(err?.message || t('card_details.ai_error_fix'));
      setAiStage('error');
    }
  }

  async function handleApproveFixes() {
    if (!aiProposedFix) return;

    setIsSavingAiFixes(true);
    setSaveError('');

    const cleanedExamples = (aiProposedFix.examples || [])
      .map((pair) => {
        const l1 = (pair.l1 || pair.es || '').trim();
        const l2 = (pair.l2 || pair.en || '').trim();
        return { l1, l2 };
      })
      .filter((pair) => pair.l1 || pair.l2);
    const first = cleanedExamples[0] ?? null;

    const prompt = (aiProposedFix.prompt_l1 || '').trim();
    const answer = (aiProposedFix.answer_l2 || '').trim();
    const definition = nullableText(aiProposedFix.l2_definition);
    const translations = aiProposedFix.l1_translations || [];
    const synonyms = aiProposedFix.l2_synonyms || [];

    const updatedPayload = {
      prompt_l1: prompt,
      answer_l2: answer,
      section_name: nullableText(aiProposedFix.section_name ?? formValues.section_name),
      part_of_speech: nullableText(aiProposedFix.part_of_speech),
      l2_definition: definition,
      l1_translations: translations,
      collocations: aiProposedFix.collocations || [],
      l2_synonyms: synonyms,
      examples: cleanedExamples,
      example_sentence: first ? first.l2 : null,
      example_l1: first ? first.l1 : null,
      example_l2: first ? first.l2 : null,
      l2_mnemonic: card.l2_mnemonic ?? null,
    };

    try {
      if (canEdit) {
        const saved = await onSave(updatedPayload);
        if (saved) {
          setFormValues(buildFormValues(saved));
          setAiNotification(t('card_details.ai_saved_toast'));
        } else {
          setFormValues(buildFormValues({ ...card, ...updatedPayload }));
          setAiNotification(t('card_details.ai_applied_toast'));
        }
      } else {
        setFormValues(buildFormValues({ ...card, ...updatedPayload }));
        setAiNotification(t('card_details.ai_applied_view_toast'));
      }
      setAiStage('idle');
      setAiProposedFix(null);
      setAiResult(null);
    } catch (err) {
      setSaveError(err?.message || t('card_details.ai_error_save_fixes'));
    } finally {
      setIsSavingAiFixes(false);
    }
  }

  function handleDisapproveFixes() {
    setAiStage('idle');
    setAiProposedFix(null);
    setAiResult(null);
    setAiNotification(t('card_details.ai_discarded_toast'));
  }

  function handleCancelAi() {
    abortControllerRef.current?.abort();
    setAiStage('idle');
    setAiResult(null);
    setAiProposedFix(null);
  }

  function handleDismissAi() {
    setAiStage('idle');
    setAiResult(null);
    setAiProposedFix(null);
    setAiError('');
  }

  async function handleSave() {
    if (!canEdit) {
      return;
    }

    setSaveError('');

    const cleanedExamples = formValues.examples
      .map((pair) => {
        const l1 = (pair.l1 || pair.es || '').trim();
        const l2 = (pair.l2 || pair.en || '').trim();
        return { l1, l2 };
      })
      .filter((pair) => pair.l1 || pair.l2);

    const first = cleanedExamples[0] ?? null;
    const prompt = (formValues.prompt_l1 || '').trim();
    const answer = (formValues.answer_l2 || '').trim();
    const definition = nullableText(formValues.l2_definition);
    const translations = splitMultiline(formValues.l1_translations ?? '');
    const synonyms = splitMultiline(formValues.l2_synonyms ?? '');

    const savedCard = await onSave({
      prompt_l1: prompt,
      answer_l2: answer,
      section_name: nullableText(formValues.section_name),
      part_of_speech: nullableText(formValues.part_of_speech),
      l2_definition: definition,
      l1_translations: translations,
      collocations: splitMultiline(formValues.collocations),
      examples: cleanedExamples,
      example_sentence: first ? first.l2 : null,
      example_l1: first ? first.l1 : null,
      example_l2: first ? first.l2 : null,
      // No longer shown or editable anywhere, but update_card nulls the column
      // when the param is omitted — pass the stored value through untouched.
      l2_mnemonic: card.l2_mnemonic ?? null,
      l2_synonyms: synonyms,
    });

    if (savedCard) {
      setFormValues(buildFormValues(savedCard));
      setIsEditing(false);
      return;
    }

    setSaveError(t('card_details.save_error'));
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setIsConfirmingDelete(false);
    setSaveError('');
    setFormValues(buildFormValues(card));
  }

  const aiDiffs = aiProposedFix
    ? diffSingleCard(getCurrentCardData(), aiProposedFix)
    : [];

  return (
    <div className="details-modal" role="dialog" aria-modal="true" aria-label={t('card_details.modal_aria')}>
      <button
        aria-label={t('card_details.close_dialog')}
        className="details-modal__backdrop"
        type="button"
        onClick={onClose}
      />
      <div className="details-modal__panel">
        <button
          aria-label={t('card_details.close_dialog')}
          className="details-modal__close"
          type="button"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>

        <div className="details-modal__header">
          <div className="details-modal__header-row">
            <div className="details-modal__header-content">
              <p className="flashcard__label">{t('card_details.metadata_label')}</p>
              <h3>{isEditing ? (formValues.answer_l2 || t('card_details.flashcard_fallback')) : (card.answer_l2 || t('card_details.flashcard_fallback'))}</h3>
            </div>
            <div className="details-modal__header-actions">
              <button
                type="button"
                className="button button--secondary button--ai-review"
                onClick={handleStartAiReview}
                disabled={isPending || aiStage === 'reviewing' || aiStage === 'fixing' || isSavingAiFixes}
                title={t('card_details.ai_review_tooltip')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="button--ai-icon">
                  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{aiStage === 'reviewing' ? t('card_details.ai_reviewing') : aiStage === 'fixing' ? t('card_details.ai_fixing') : t('card_details.ai_review_btn_short')}</span>
              </button>
            </div>
          </div>
        </div>

        {aiNotification ? (
          <div className="card-ai-toast" role="status">
            <span>{aiNotification}</span>
            <button
              type="button"
              aria-label={t('card_details.dismiss_notification')}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontSize: '1rem', padding: '0 0.25rem' }}
              onClick={() => setAiNotification('')}
            >
              ×
            </button>
          </div>
        ) : null}

        {/* AI REVIEW SECTION */}
        {aiStage === 'reviewing' && (
          <div className="card-ai-panel card-ai-panel--loading">
            <div className="card-ai-spinner" />
            <div className="card-ai-panel__content" style={{ flex: 1 }}>
              <h4>{t('card_details.ai_reviewing_title')}</h4>
              <p>{t('card_details.ai_reviewing_desc')}</p>
            </div>
            <button type="button" className="button button--secondary st-button--compact" onClick={handleCancelAi}>
              {t('common.cancel')}
            </button>
          </div>
        )}

        {aiStage === 'no_key' && (
          <div className="card-ai-panel card-ai-panel--warning">
            <div className="card-ai-panel__head">
              <div className="card-ai-panel__head-title">
                <span className="card-ai-badge card-ai-badge--warning">{t('card_details.ai_no_key_badge')}</span>
                <p className="card-ai-panel__summary">
                  {t('card_details.ai_no_key_desc')}
                </p>
              </div>
            </div>
            <div className="card-ai-panel__actions">
              <button type="button" className="button button--secondary st-button--compact" onClick={handleDismissAi}>
                {t('card_details.dismiss')}
              </button>
            </div>
          </div>
        )}

        {aiStage === 'error' && (
          <div className="card-ai-panel card-ai-panel--error">
            <div className="card-ai-panel__head">
              <div className="card-ai-panel__head-title">
                <span className="card-ai-badge card-ai-badge--warning">{t('common.error')}</span>
                <p className="card-ai-panel__summary">{aiError || t('card_details.ai_error_default')}</p>
              </div>
            </div>
            <div className="card-ai-panel__actions">
              <button type="button" className="button button--secondary st-button--compact" onClick={handleStartAiReview}>
                {t('card_details.retry')}
              </button>
              <button type="button" className="button button--secondary st-button--compact" onClick={handleDismissAi}>
                {t('card_details.dismiss')}
              </button>
            </div>
          </div>
        )}

        {aiStage === 'reviewed' && aiResult && !aiResult.has_issues && (
          <div className="card-ai-panel card-ai-panel--passed">
            <div className="card-ai-panel__icon--passed">✓</div>
            <div className="card-ai-panel__content" style={{ flex: 1 }}>
              <h4>{t('card_details.ai_passed_title')}</h4>
              <p>{aiResult.summary || t('card_details.ai_passed_desc')}</p>
            </div>
            <button type="button" className="button button--secondary st-button--compact" onClick={handleDismissAi}>
              {t('common.done')}
            </button>
          </div>
        )}

        {aiStage === 'reviewed' && aiResult && aiResult.has_issues && (
          <div className="card-ai-panel card-ai-panel--issues">
            <div className="card-ai-panel__head">
              <div className="card-ai-panel__head-title">
                <span className="card-ai-badge card-ai-badge--warning">
                  {t('card_details.ai_issues_badge', { count: aiResult.issues.length })}
                </span>
                <p className="card-ai-panel__summary">{aiResult.summary}</p>
              </div>
            </div>

            <ul className="card-ai-issues-list">
              {aiResult.issues.map((issue, idx) => (
                <li key={idx} className={`card-ai-issue-item card-ai-issue-item--${issue.severity}`}>
                  <div className="card-ai-issue-item__header">
                    <span className="card-ai-field-tag">{fieldLabel(issue.field, t)}</span>
                    <span className="card-ai-severity-tag">{issue.severity}</span>
                  </div>
                  <p className="card-ai-issue-item__msg">{issue.message}</p>
                  {issue.suggestion ? (
                    <p className="card-ai-issue-item__hint">💡 {issue.suggestion}</p>
                  ) : null}
                </li>
              ))}
            </ul>

            <div className="card-ai-panel__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={handleGenerateFixes}
                disabled={isPending}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="button--ai-icon">
                  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" fill="none" stroke="currentColor" strokeWidth="1.8" />
                </svg>
                <span>{t('card_details.ai_generate_fixes_btn')}</span>
              </button>
              <button type="button" className="button button--secondary" onClick={handleDismissAi}>
                {t('card_details.dismiss')}
              </button>
            </div>
          </div>
        )}

        {aiStage === 'fixing' && (
          <div className="card-ai-panel card-ai-panel--loading">
            <div className="card-ai-spinner" />
            <div className="card-ai-panel__content" style={{ flex: 1 }}>
              <h4>{t('card_details.ai_generating_fixes_title')}</h4>
              <p>{t('card_details.ai_generating_fixes_desc')}</p>
            </div>
            <button type="button" className="button button--secondary st-button--compact" onClick={handleCancelAi}>
              {t('common.cancel')}
            </button>
          </div>
        )}

        {aiStage === 'fixes_ready' && aiProposedFix && (
          <div className="card-ai-panel card-ai-panel--fixes">
            <div className="card-ai-panel__head">
              <div className="card-ai-panel__head-title">
                <span className="card-ai-badge card-ai-badge--success">{t('card_details.ai_proposed_fixes_badge')}</span>
                {aiProposedFix.explanation ? (
                  <p className="card-ai-panel__summary">{aiProposedFix.explanation}</p>
                ) : null}
              </div>
            </div>

            <div className="card-ai-diff-container">
              <table className="card-ai-diff-table">
                <thead>
                  <tr>
                    <th>{t('common.field')}</th>
                    <th>{t('common.current')}</th>
                    <th>{t('card_details.proposed_fix_header')}</th>
                  </tr>
                </thead>
                <tbody>
                  {aiDiffs.map((diff) => (
                    <tr key={diff.key} className={diff.isChanged ? 'card-ai-diff-row--changed' : ''}>
                      <td className="card-ai-diff-col-field">
                        <strong>{getDiffFieldLabel(diff.key, diff.label, t, sourceLabel, targetLabel)}</strong>
                        {diff.isChanged ? <span className="card-ai-change-pill">{t('card_details.diff_changed')}</span> : null}
                      </td>
                      <td className="card-ai-diff-col-from">
                        {diff.from ? (
                          <span className="card-ai-diff-text card-ai-diff-text--from">{diff.from}</span>
                        ) : (
                          <em className="card-ai-diff-empty">{t('card_details.diff_empty')}</em>
                        )}
                      </td>
                      <td className="card-ai-diff-col-to">
                        {diff.to ? (
                          <span className="card-ai-diff-text card-ai-diff-text--to">{diff.to}</span>
                        ) : (
                          <em className="card-ai-diff-empty">{t('card_details.diff_empty')}</em>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-ai-panel__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={handleApproveFixes}
                disabled={isPending || isSavingAiFixes}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M5 12.5 9.2 16.7 19 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{isSavingAiFixes ? t('common.saving') : t('card_details.approve_fixes_btn')}</span>
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={handleDisapproveFixes}
                disabled={isPending || isSavingAiFixes}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M7 7 17 17M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span>{t('card_details.disapprove_fixes_btn')}</span>
              </button>
            </div>
          </div>
        )}

        <div className="flashcard-details">
          <Field label={t('card_details.prompt_label', { language: sourceLabel })}>
            {isEditing ? (
              <input value={formValues.prompt_l1 ?? ''} onChange={(event) => updateField('prompt_l1', event.target.value)} />
            ) : (
              <p>{card.prompt_l1}</p>
            )}
          </Field>

          <Field label={t('card_details.answer_label', { language: targetLabel })}>
            {isEditing ? (
              <input value={formValues.answer_l2 ?? ''} onChange={(event) => updateField('answer_l2', event.target.value)} />
            ) : (
              <p>{card.answer_l2}</p>
            )}
          </Field>

          <Field label={t('card_details.section_label')}>
            {isEditing ? (
              <input value={formValues.section_name} onChange={(event) => updateField('section_name', event.target.value)} />
            ) : (
              <p>{card.section_name || t('card_details.unassigned')}</p>
            )}
          </Field>

          <Field label={t('card_details.part_of_speech_label')}>
            {isEditing ? (
              <input value={formValues.part_of_speech} onChange={(event) => updateField('part_of_speech', event.target.value)} />
            ) : (
              <p>{card.part_of_speech || t('card_details.not_set')}</p>
            )}
          </Field>

          <Field label={t('card_details.definition_in_lang', { language: targetLabel })} wide>
            {isEditing ? (
              <textarea value={formValues.l2_definition ?? formValues.definition_en} onChange={(event) => updateField('l2_definition', event.target.value)} rows={2} />
            ) : (
              <p>{(card.l2_definition ?? card.definition_en) || t('card_details.not_set')}</p>
            )}
          </Field>

          <Field label={t('card_details.main_translations_label')}>
            {isEditing ? (
              <textarea value={formValues.l1_translations ?? formValues.main_translations_es} onChange={(event) => updateField('l1_translations', event.target.value)} rows={3} />
            ) : (card.l1_translations ?? card.main_translations_es)?.length ? (
              <ul>
                {(card.l1_translations ?? card.main_translations_es).map((translation) => (
                  <li key={translation}>{translation}</li>
                ))}
              </ul>
            ) : (
              <p>{t('card_details.not_set')}</p>
            )}
          </Field>

          <Field label={t('card_details.collocations_label')}>
            {isEditing ? (
              <textarea value={formValues.collocations} onChange={(event) => updateField('collocations', event.target.value)} rows={3} />
            ) : card.collocations?.length ? (
              <ul>
                {card.collocations.map((collocation) => (
                  <li key={collocation}>{collocation}</li>
                ))}
              </ul>
            ) : (
              <p>{t('card_details.not_set')}</p>
            )}
          </Field>

          <Field label={t('card_details.synonyms_in_lang', { language: targetLabel })}>
            {isEditing ? (
              <textarea value={formValues.l2_synonyms ?? formValues.synonyms_en} onChange={(event) => updateField('l2_synonyms', event.target.value)} rows={3} />
            ) : (card.l2_synonyms ?? card.synonyms_en)?.length ? (
              <ul>
                {(card.l2_synonyms ?? card.synonyms_en).map((synonym) => (
                  <li key={synonym}>{synonym}</li>
                ))}
              </ul>
            ) : (
              <p>{t('card_details.not_set')}</p>
            )}
          </Field>

          {isEditing ? (
            <Field label={t('card_details.examples_editing_label')} wide>
              <div className="flashcard-details__examples-edit">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="flashcard-details__example-edit-group">
                    <span className="flashcard-details__example-edit-label">{t('card_details.example_num', { num: idx + 1 })}</span>
                    <input
                      type="text"
                      value={formValues.examples[idx]?.l1 ?? formValues.examples[idx]?.es ?? ''}
                      onChange={(event) => updateExamplePair(idx, 'l1', event.target.value)}
                      placeholder={t('card_details.example_placeholder', { language: sourceLabel, num: idx + 1 })}
                      aria-label={t('card_details.example_aria', { num: idx + 1, language: sourceLabel })}
                    />
                    <input
                      type="text"
                      value={formValues.examples[idx]?.l2 ?? formValues.examples[idx]?.en ?? ''}
                      onChange={(event) => updateExamplePair(idx, 'l2', event.target.value)}
                      placeholder={t('card_details.example_placeholder', { language: targetLabel, num: idx + 1 })}
                      aria-label={t('card_details.example_aria', { num: idx + 1, language: targetLabel })}
                    />
                  </div>
                ))}
              </div>
            </Field>
          ) : card.examples && card.examples.length > 0 ? (
            <Field label={t('card_details.examples_label')} wide>
              <ul className="flashcard-details__examples-list">
                {card.examples.map((pair, idx) => {
                  const l1 = pair.l1 ?? pair.example_l1 ?? pair.es ?? pair.example_es;
                  const l2 = pair.l2 ?? pair.example_l2 ?? pair.en ?? pair.example_en;
                  return (
                    <li key={idx} className="flashcard-details__example-item">
                      <span className="flashcard-details__example-num">{t('card_details.example_num', { num: idx + 1 })}</span>
                      {l1 ? <p className="flashcard-details__example-es">{l1}</p> : null}
                      {l2 ? <p className="flashcard-details__example-en">{l2}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </Field>
          ) : (
            <>
              <Field label={t('card_details.example_in_lang', { language: sourceLabel })}>
                <p>{card.example_l1 || card.example_es || t('card_details.not_set')}</p>
              </Field>
              <Field label={t('card_details.example_in_lang', { language: targetLabel })}>
                <p>{card.example_l2 || card.example_en || card.example_sentence || t('card_details.not_set')}</p>
              </Field>
            </>
          )}
        </div>

        {saveError ? <p className="details-modal__status details-modal__status--error">{saveError}</p> : null}

        {(canEdit || canToggle || canDelete) ? (
          <div className="details-modal__actions">
            {isConfirmingDelete ? (
              <div className="details-modal__confirm-delete">
                <div className="details-modal__confirm-message">
                  <p className="details-modal__confirm-title">{t('card_details.confirm_delete_title')}</p>
                  {card.base_card_id != null ? (
                    <p className="details-modal__confirm-note">
                      {t('card_details.confirm_delete_market_note')}
                    </p>
                  ) : null}
                </div>
                <div className="details-modal__confirm-buttons">
                  <button
                    className="button button--danger"
                    type="button"
                    onClick={onDelete}
                    disabled={isPending}
                  >
                    {t('deck_words.confirm_delete_btn')}
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => setIsConfirmingDelete(false)}
                    disabled={isPending}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {isEditing ? (
                  <button className="button button--primary" type="button" onClick={handleSave} disabled={isPending}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M5 12.5 9.2 16.7 19 7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>{t('common.save')}</span>
                  </button>
                ) : canDelete ? (
                  <button
                    className="button button--danger-outline"
                    type="button"
                    onClick={() => setIsConfirmingDelete(true)}
                    disabled={isPending}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="10" y1="11" x2="10" y2="17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      <line x1="14" y1="11" x2="14" y2="17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                    <span>{t('card_details.delete_card_btn')}</span>
                  </button>
                ) : (
                  <span />
                )}

                <div className="details-modal__actions-group">
                  {canToggle ? (
                    <button className="button button--secondary" type="button" onClick={onToggle} disabled={isPending}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        {card.is_enabled ? (
                          <>
                            <path d="M1.5 12s3.9-6.5 10.5-6.5S22.5 12 22.5 12s-3.9 6.5-10.5 6.5S1.5 12 1.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            <circle cx="12" cy="12" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
                          </>
                        ) : (
                          <>
                            <path d="M2.5 12s3.3-5.8 9.5-5.8c2.3 0 4.2.8 5.8 1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M21.5 12s-3.3 5.8-9.5 5.8c-2.3 0-4.2-.8-5.8-1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M9.9 9.9A3.2 3.2 0 0 1 15 14.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M3 3l18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </>
                        )}
                      </svg>
                      <span>{toggleLabel}</span>
                    </button>
                  ) : null}

                  {canEdit ? (
                    <button className="button button--secondary" type="button" onClick={isEditing ? handleCancelEdit : () => setIsEditing(true)} disabled={isPending}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        {isEditing ? (
                          <>
                            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                          </>
                        ) : (
                          <>
                            <path d="M4 20h4.2L19 9.2a1.5 1.5 0 0 0 0-2.1l-2.1-2.1a1.5 1.5 0 0 0-2.1 0L4 15.8V20Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </>
                        )}
                      </svg>
                      <span>{isEditing ? t('common.cancel') : t('card_details.edit')}</span>
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, wide = false, children }) {
  return (
    <div className={wide ? 'flashcard-details__field flashcard-details__field--wide' : 'flashcard-details__field'}>
      <span>{label}</span>
      {children}
    </div>
  );
}

function buildFormValues(card) {
  const existingPairs = (Array.isArray(card.examples) && card.examples.length > 0)
    ? card.examples.map((p) => ({
        l1: p?.l1 ?? p?.example_l1 ?? '',
        l2: p?.l2 ?? p?.example_l2 ?? '',
      }))
    : [
        {
          l1: card.example_l1 ?? '',
          l2: card.example_l2 ?? card.example_sentence ?? '',
        },
      ];

  const examples = [
    { l1: existingPairs[0]?.l1 ?? '', l2: existingPairs[0]?.l2 ?? '' },
    { l1: existingPairs[1]?.l1 ?? '', l2: existingPairs[1]?.l2 ?? '' },
    { l1: existingPairs[2]?.l1 ?? '', l2: existingPairs[2]?.l2 ?? '' },
  ];

  const prompt = card.prompt_l1 ?? '';
  const answer = card.answer_l2 ?? '';
  const definition = card.l2_definition ?? '';
  const translations = (card.l1_translations ?? []).join('\n');
  const synonyms = (card.l2_synonyms ?? []).join('\n');
  const ex1 = examples[0].l1 || card.example_l1 || '';
  const ex2 = examples[0].l2 || card.example_l2 || '';

  return {
    prompt_l1: prompt,
    answer_l2: answer,
    section_name: card.section_name ?? '',
    part_of_speech: card.part_of_speech ?? '',
    l2_definition: definition,
    l1_translations: translations,
    collocations: (card.collocations ?? []).join('\n'),
    l2_synonyms: synonyms,
    examples,
    example_sentence: ex2 || card.example_sentence || '',
    example_l1: ex1,
    example_l2: ex2,
  };
}

function splitMultiline(value) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nullableText(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function getDiffFieldLabel(key, fallback, t, sourceLabel, targetLabel) {
  if (!t) return fallback;
  switch (key) {
    case 'prompt_es':
    case 'prompt_l1':
      return t('card_details.prompt_label', { language: sourceLabel });
    case 'answer_en':
    case 'answer_l2':
      return t('card_details.answer_label', { language: targetLabel });
    case 'section_name':
      return t('diff.section_name');
    case 'part_of_speech':
      return t('diff.part_of_speech');
    case 'definition_en':
    case 'l2_definition':
      return t('card_details.definition_in_lang', { language: targetLabel });
    case 'main_translations_es':
    case 'l1_translations':
      return t('diff.l1_translations');
    case 'collocations':
      return t('diff.collocations');
    case 'synonyms_en':
    case 'l2_synonyms':
      return t('card_details.synonyms_in_lang', { language: targetLabel });
    case 'examples':
      return t('diff.examples');
    default:
      return fallback;
  }
}

function fieldLabel(field, t) {
  const map = {
    prompt_l1: 'prompt',
    prompt_es: 'prompt',
    prompt: 'prompt',
    answer_l2: 'answer',
    answer_en: 'answer',
    answer: 'answer',
    section_name: 'section_name',
    part_of_speech: 'part_of_speech',
    l2_definition: 'l2_definition',
    definition_en: 'l2_definition',
    definition: 'l2_definition',
    l1_translations: 'l1_translations',
    main_translations_es: 'l1_translations',
    collocations: 'collocations',
    l2_synonyms: 'l2_synonyms',
    synonyms_en: 'l2_synonyms',
    examples: 'examples',
  };
  const fallbackMap = {
    prompt_l1: 'Prompt',
    prompt_es: 'Prompt',
    prompt: 'Prompt',
    answer_l2: 'Answer',
    answer_en: 'Answer',
    answer: 'Answer',
    section_name: 'Section',
    part_of_speech: 'Part of speech',
    l2_definition: 'Definition',
    definition_en: 'Definition',
    definition: 'Definition',
    l1_translations: 'Translations',
    main_translations_es: 'Translations',
    collocations: 'Collocations',
    l2_synonyms: 'Synonyms',
    synonyms_en: 'Synonyms',
    examples: 'Examples',
    general: 'General',
  };
  if (t) {
    const key = map[field];
    if (key) {
      return t(`diff.${key}`);
    }
  }
  return fallbackMap[field] || field;
}

export default CardDetailsModal;