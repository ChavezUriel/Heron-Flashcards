// Field-level diffing between two card content shapes. Handles both JSON
// shapes the backend produces: _preview_card_json (prompt_es / answer_en) and
// _card_sync_content (spanish_text / english_text).

const CARD_DIFF_FIELDS = [
  { key: 'prompt', label: 'Spanish' },
  { key: 'answer', label: 'English' },
  { key: 'section_name', label: 'Section' },
  { key: 'part_of_speech', label: 'Part of speech' },
  { key: 'definition_en', label: 'Definition' },
  { key: 'main_translations_es', label: 'Translations', isArray: true },
  { key: 'collocations', label: 'Collocations', isArray: true },
  { key: 'synonyms_en', label: 'Synonyms', isArray: true },
  { key: 'examples', label: 'Examples', isArray: true },
  { key: 'example_sentence', label: 'Example' },
  { key: 'example_es', label: 'Example (ES)' },
  { key: 'example_en', label: 'Example (EN)' },
];

// Normalize either backend shape into the diffable key set above.
export function normalizeCardContent(raw) {
  if (!raw) {
    return null;
  }
  const examplesList = Array.isArray(raw.examples) && raw.examples.length > 0
    ? raw.examples.map((p) => {
        const es = p?.es ?? p?.example_es ?? '';
        const en = p?.en ?? p?.example_en ?? '';
        return es && en ? `${es} / ${en}` : (es || en || '');
      }).filter(Boolean)
    : [];

  return {
    prompt: raw.prompt_es ?? raw.spanish_text ?? null,
    answer: raw.answer_en ?? raw.english_text ?? null,
    section_name: raw.section_name ?? null,
    part_of_speech: raw.part_of_speech ?? null,
    definition_en: raw.definition_en ?? null,
    main_translations_es: raw.main_translations_es ?? [],
    collocations: raw.collocations ?? [],
    synonyms_en: raw.synonyms_en ?? [],
    examples: examplesList,
    example_sentence: raw.example_sentence ?? null,
    example_es: raw.example_es ?? null,
    example_en: raw.example_en ?? null,
  };
}

function displayValue(value, isArray) {
  if (isArray) {
    const items = Array.isArray(value) ? value.filter(Boolean) : [];
    return items.length > 0 ? items.join(', ') : '';
  }
  return value ?? '';
}

// Rows where `from` and `to` differ: [{ key, label, from, to }].
// `from`/`to` are display strings ('' for empty).
export function diffCardContent(fromRaw, toRaw) {
  const from = normalizeCardContent(fromRaw);
  const to = normalizeCardContent(toRaw);
  if (!from || !to) {
    return [];
  }

  const rows = [];
  for (const field of CARD_DIFF_FIELDS) {
    const fromValue = displayValue(from[field.key], field.isArray);
    const toValue = displayValue(to[field.key], field.isArray);
    if (fromValue !== toValue) {
      rows.push({ key: field.key, label: field.label, from: fromValue, to: toValue });
    }
  }
  return rows;
}

// Compact card title for list rows, tolerant of both shapes.
export function cardTitle(raw) {
  const content = normalizeCardContent(raw);
  if (!content) {
    return '';
  }
  return [content.prompt, content.answer].filter(Boolean).join(' — ');
}
