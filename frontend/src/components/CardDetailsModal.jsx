import { useEffect, useState } from 'react';

function CardDetailsModal({
  card,
  isPending = false,
  startInEditMode = false,
  onClose,
  onSave,
  onToggle,
}) {
  const canEdit = typeof onSave === 'function';
  const canToggle = typeof onToggle === 'function' && typeof card.is_enabled === 'boolean';
  const toggleLabel = card.is_enabled ? 'Hide card' : 'Show card';
  const [isEditing, setIsEditing] = useState(startInEditMode && canEdit);
  const [saveError, setSaveError] = useState('');
  const [formValues, setFormValues] = useState(() => buildFormValues(card));

  useEffect(() => {
    setIsEditing(startInEditMode && canEdit);
    setSaveError('');
    setFormValues(buildFormValues(card));
  }, [canEdit, card.card_id, startInEditMode]);

  function updateField(name, value) {
    setFormValues((current) => ({ ...current, [name]: value }));
  }

  function updateExamplePair(index, field, value) {
    setFormValues((current) => {
      const updatedExamples = current.examples.map((pair, idx) =>
        idx === index ? { ...pair, [field]: value } : pair
      );
      const first = updatedExamples[0] ?? { es: '', en: '' };
      return {
        ...current,
        examples: updatedExamples,
        example_es: first.es,
        example_en: first.en,
        example_sentence: first.en,
      };
    });
  }

  async function handleSave() {
    if (!canEdit) {
      return;
    }

    setSaveError('');

    const cleanedExamples = formValues.examples
      .map((pair) => ({ es: pair.es.trim(), en: pair.en.trim() }))
      .filter((pair) => pair.es || pair.en);

    const first = cleanedExamples[0] ?? null;

    const savedCard = await onSave({
      prompt_es: formValues.prompt_es.trim(),
      answer_en: formValues.answer_en.trim(),
      section_name: nullableText(formValues.section_name),
      part_of_speech: nullableText(formValues.part_of_speech),
      definition_en: nullableText(formValues.definition_en),
      main_translations_es: splitMultiline(formValues.main_translations_es),
      collocations: splitMultiline(formValues.collocations),
      examples: cleanedExamples,
      example_sentence: first ? first.en : null,
      example_es: first ? first.es : null,
      example_en: first ? first.en : null,
      // No longer shown or editable anywhere, but update_card nulls the column
      // when the param is omitted — pass the stored value through untouched.
      mnemonic_en: card.mnemonic_en ?? null,
      synonyms_en: splitMultiline(formValues.synonyms_en),
    });

    if (savedCard) {
      setFormValues(buildFormValues(savedCard));
      setIsEditing(false);
      return;
    }

    setSaveError('Unable to save changes.');
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setSaveError('');
    setFormValues(buildFormValues(card));
  }

  return (
    <div className="details-modal" role="dialog" aria-modal="true" aria-label="Flashcard metadata">
      <button
        aria-label="Close flashcard metadata"
        className="details-modal__backdrop"
        type="button"
        onClick={onClose}
      />
      <div className="details-modal__panel">
        <button
          aria-label="Close flashcard metadata"
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
          <p className="flashcard__label">Flashcard metadata</p>
          <h3>{isEditing ? formValues.answer_en || 'Flashcard' : card.answer_en}</h3>
        </div>

        <div className="flashcard-details">
          <Field label="Spanish prompt">
            {isEditing ? (
              <input value={formValues.prompt_es} onChange={(event) => updateField('prompt_es', event.target.value)} />
            ) : (
              <p>{card.prompt_es}</p>
            )}
          </Field>

          <Field label="English answer">
            {isEditing ? (
              <input value={formValues.answer_en} onChange={(event) => updateField('answer_en', event.target.value)} />
            ) : (
              <p>{card.answer_en}</p>
            )}
          </Field>

          <Field label="Section">
            {isEditing ? (
              <input value={formValues.section_name} onChange={(event) => updateField('section_name', event.target.value)} />
            ) : (
              <p>{card.section_name || 'Unassigned'}</p>
            )}
          </Field>

          <Field label="Part of speech">
            {isEditing ? (
              <input value={formValues.part_of_speech} onChange={(event) => updateField('part_of_speech', event.target.value)} />
            ) : (
              <p>{card.part_of_speech || 'Not set'}</p>
            )}
          </Field>

          <Field label="Definition in English" wide>
            {isEditing ? (
              <textarea value={formValues.definition_en} onChange={(event) => updateField('definition_en', event.target.value)} rows={2} />
            ) : (
              <p>{card.definition_en || 'Not set'}</p>
            )}
          </Field>

          <Field label="Main translations">
            {isEditing ? (
              <textarea value={formValues.main_translations_es} onChange={(event) => updateField('main_translations_es', event.target.value)} rows={3} />
            ) : card.main_translations_es?.length ? (
              <ul>
                {card.main_translations_es.map((translation) => (
                  <li key={translation}>{translation}</li>
                ))}
              </ul>
            ) : (
              <p>Not set</p>
            )}
          </Field>

          <Field label="Collocations">
            {isEditing ? (
              <textarea value={formValues.collocations} onChange={(event) => updateField('collocations', event.target.value)} rows={3} />
            ) : card.collocations?.length ? (
              <ul>
                {card.collocations.map((collocation) => (
                  <li key={collocation}>{collocation}</li>
                ))}
              </ul>
            ) : (
              <p>Not set</p>
            )}
          </Field>

          <Field label="Synonyms (English)">
            {isEditing ? (
              <textarea value={formValues.synonyms_en} onChange={(event) => updateField('synonyms_en', event.target.value)} rows={3} />
            ) : card.synonyms_en?.length ? (
              <ul>
                {card.synonyms_en.map((synonym) => (
                  <li key={synonym}>{synonym}</li>
                ))}
              </ul>
            ) : (
              <p>Not set</p>
            )}
          </Field>

          {isEditing ? (
            <Field label="Example sentences (3 standard)" wide>
              <div className="flashcard-details__examples-edit">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="flashcard-details__example-edit-group">
                    <span className="flashcard-details__example-edit-label">Example {idx + 1}</span>
                    <input
                      type="text"
                      value={formValues.examples[idx]?.es ?? ''}
                      onChange={(event) => updateExamplePair(idx, 'es', event.target.value)}
                      placeholder={`Spanish sentence ${idx + 1}`}
                      aria-label={`Example ${idx + 1} Spanish`}
                    />
                    <input
                      type="text"
                      value={formValues.examples[idx]?.en ?? ''}
                      onChange={(event) => updateExamplePair(idx, 'en', event.target.value)}
                      placeholder={`English sentence ${idx + 1}`}
                      aria-label={`Example ${idx + 1} English`}
                    />
                  </div>
                ))}
              </div>
            </Field>
          ) : card.examples && card.examples.length > 0 ? (
            <Field label="Example sentences" wide>
              <ul className="flashcard-details__examples-list">
                {card.examples.map((pair, idx) => (
                  <li key={idx} className="flashcard-details__example-item">
                    <span className="flashcard-details__example-num">Example {idx + 1}</span>
                    {pair.es ? <p className="flashcard-details__example-es">{pair.es}</p> : null}
                    {pair.en ? <p className="flashcard-details__example-en">{pair.en}</p> : null}
                  </li>
                ))}
              </ul>
            </Field>
          ) : (
            <>
              <Field label="Example in Spanish">
                <p>{card.example_es || 'Not set'}</p>
              </Field>
              <Field label="Example in English">
                <p>{card.example_en || card.example_sentence || 'Not set'}</p>
              </Field>
            </>
          )}
        </div>

        {saveError ? <p className="details-modal__status details-modal__status--error">{saveError}</p> : null}

        {(canEdit || canToggle) ? (
          <div className="details-modal__actions">
            {isEditing ? (
              <button className="button button--primary" type="button" onClick={handleSave} disabled={isPending}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M5 12.5 9.2 16.7 19 7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Save</span>
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
                  <span>{isEditing ? 'Cancel' : 'Edit'}</span>
                </button>
              ) : null}
            </div>
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
        es: p?.es ?? p?.example_es ?? '',
        en: p?.en ?? p?.example_en ?? '',
      }))
    : [
        {
          es: card.example_es ?? '',
          en: card.example_en ?? card.example_sentence ?? '',
        },
      ];

  const examples = [
    { es: existingPairs[0]?.es ?? '', en: existingPairs[0]?.en ?? '' },
    { es: existingPairs[1]?.es ?? '', en: existingPairs[1]?.en ?? '' },
    { es: existingPairs[2]?.es ?? '', en: existingPairs[2]?.en ?? '' },
  ];

  return {
    prompt_es: card.prompt_es ?? '',
    answer_en: card.answer_en ?? '',
    section_name: card.section_name ?? '',
    part_of_speech: card.part_of_speech ?? '',
    definition_en: card.definition_en ?? '',
    main_translations_es: (card.main_translations_es ?? []).join('\n'),
    collocations: (card.collocations ?? []).join('\n'),
    synonyms_en: (card.synonyms_en ?? []).join('\n'),
    examples,
    example_sentence: examples[0].en || card.example_sentence || '',
    example_es: examples[0].es || card.example_es || '',
    example_en: examples[0].en || card.example_en || '',
  };
}

function splitMultiline(value) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nullableText(value) {
  const normalized = value.trim();
  return normalized || null;
}

export default CardDetailsModal;