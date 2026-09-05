// Field-level diffing between two card content shapes. Handles both JSON
// shapes the backend produces: _preview_card_json (prompt_l1 / answer_l2) and
// _card_sync_content (l1_text / l2_text).

const CARD_DIFF_FIELDS = [
  { key: 'prompt', label: 'Prompt' },
  { key: 'answer', label: 'Answer' },
  { key: 'section_name', label: 'Section' },
  { key: 'part_of_speech', label: 'Part of speech' },
  { key: 'l2_definition', label: 'Definition' },
  { key: 'l1_translations', label: 'Translations', isArray: true },
  { key: 'collocations', label: 'Collocations', isArray: true },
  { key: 'l2_synonyms', label: 'Synonyms', isArray: true },
  { key: 'examples', label: 'Examples', isArray: true },
  { key: 'example_sentence', label: 'Example' },
  { key: 'example_l1', label: 'Example (L1)' },
  { key: 'example_l2', label: 'Example (L2)' },
  { key: 'l2_cloze_distractors', label: 'Word-bank options', isArray: true },
];

// Normalize either backend shape into the diffable key set above.
export function normalizeCardContent(raw) {
  if (!raw) {
    return null;
  }
  const examplesList = Array.isArray(raw.examples) && raw.examples.length > 0
    ? raw.examples.map((p) => {
        const l1 = p?.l1 ?? p?.example_l1 ?? '';
        const l2 = p?.l2 ?? p?.example_l2 ?? '';
        return l1 && l2 ? `${l1} / ${l2}` : (l1 || l2 || '');
      }).filter(Boolean)
    : [];

  return {
    prompt: raw.prompt_l1 ?? raw.l1_text ?? null,
    answer: raw.answer_l2 ?? raw.l2_text ?? null,
    section_name: raw.section_name ?? null,
    part_of_speech: raw.part_of_speech ?? null,
    l2_definition: raw.l2_definition ?? null,
    l1_translations: raw.l1_translations ?? [],
    collocations: raw.collocations ?? [],
    l2_synonyms: raw.l2_synonyms ?? [],
    examples: examplesList,
    example_sentence: raw.example_sentence ?? null,
    example_l1: raw.example_l1 ?? null,
    example_l2: raw.example_l2 ?? null,
    l2_cloze_distractors: raw.l2_cloze_distractors ?? [],
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
