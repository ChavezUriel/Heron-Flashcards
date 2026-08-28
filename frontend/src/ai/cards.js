// Card normalization helpers — the browser port of
// supabase/scripts/lib/cards.cjs. Kept field-for-field identical so a deck built
// in the app has exactly the shape the seed compiler and the database expect.

export function optText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function normList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const text = optText(item);
    if (text === null) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// Example sentence pairs (migration 0019): [{ es, en }], deduped by English
// sentence. Accepts the storage keys ({es, en}) and the LLM output keys
// ({example_es, example_en}).
export function normExamplePairs(value, legacyEs, legacyEn) {
  const out = [];
  const seen = new Set();
  const push = (esRaw, enRaw) => {
    const es = optText(esRaw);
    const en = optText(enRaw);
    if (!es || !en) return;
    const key = en.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ es, en });
  };
  if (Array.isArray(value)) {
    for (const pair of value) {
      if (!pair || typeof pair !== 'object') continue;
      push(pair.es ?? pair.example_es, pair.en ?? pair.example_en);
    }
  }
  if (!out.length) push(legacyEs, legacyEn);
  return out;
}

function normAudits(v, genMeta) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (genMeta && typeof genMeta === 'object' && !Array.isArray(genMeta) &&
      genMeta._audits && typeof genMeta._audits === 'object' && !Array.isArray(genMeta._audits)) {
    return genMeta._audits;
  }
  return null;
}

// Normalize one drafted/generated card into the enriched shape. Accepts either
// {spanish, english} (draft) or the fully enriched object. The legacy
// example_es/example_en/example_sentence columns mirror pair 0 mechanically —
// the pairs are the source of truth and the mirror is what pre-0019 consumers
// (and the 0017 sync hash) read.
export function normCard(card, deckTitle) {
  const spanish = optText(card.spanish ?? card.spanish_text ?? card.prompt_es);
  const english = optText(card.english ?? card.english_text ?? card.answer_en);
  if (!spanish || !english) return null;
  const examples = normExamplePairs(card.examples, card.example_es, card.example_en);
  const first = examples[0] ?? null;
  return {
    spanish_text: spanish,
    english_text: english,
    section_name: optText(card.section_name) ?? deckTitle ?? null,
    part_of_speech: optText(card.part_of_speech),
    definition_en: optText(card.definition_en),
    main_translations_es: normList(card.main_translations_es),
    collocations: normList(card.collocations),
    synonyms_en: normList(card.synonyms_en),
    examples,
    example_sentence: first ? first.en : optText(card.example_sentence),
    example_es: first ? first.es : optText(card.example_es),
    example_en: first ? first.en : optText(card.example_en),
    mnemonic_en: optText(card.mnemonic_en),
    cloze_distractors_en: normList(card.cloze_distractors_en),
    _audits: normAudits(card._audits, card.generation_metadata),
  };
}

// Case-insensitive dedup key for a (spanish, english) pair.
export function pairKey(spanish, english) {
  return `${String(spanish).toLowerCase()} ${String(english).toLowerCase()}`;
}
