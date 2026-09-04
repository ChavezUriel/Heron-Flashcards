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

// Example sentence pairs (migration 0019 & 0034): [{ l1, l2 }], deduped by L2
// sentence. Accepts the storage keys ({l1, l2}, {es, en}) and the LLM output keys
// ({example_l1, example_l2}, {example_es, example_en}).
export function normExamplePairs(value, legacyEs, legacyEn) {
  const out = [];
  const seen = new Set();
  const push = (l1Raw, l2Raw) => {
    const l1 = optText(l1Raw);
    const l2 = optText(l2Raw);
    if (!l1 || !l2) return;
    const key = l2.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // Role-named keys only: each pair carries only l1 and l2 (P3).
    // Non-enumerable getters preserve backward-compatibility for any legacy readers.
    const pair = { l1, l2 };
    Object.defineProperty(pair, 'es', { get() { return this.l1; }, configurable: true, enumerable: false });
    Object.defineProperty(pair, 'en', { get() { return this.l2; }, configurable: true, enumerable: false });
    out.push(pair);
  };
  if (Array.isArray(value)) {
    for (const pair of value) {
      if (!pair || typeof pair !== 'object') continue;
      push(
        pair.l1 ?? pair.example_l1 ?? pair.es ?? pair.example_es,
        pair.l2 ?? pair.example_l2 ?? pair.en ?? pair.example_en
      );
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
// The legacy `*_es` / `*_en` names are still accepted on the way IN because the
// model still answers in them: the prompt schema in ai/prompts.js is renamed by
// P3, not P2. Dropping the input aliases silently discards every enriched field
// the LLM returns. Output is role-named only — one name per field.
export function normCard(card, deckTitle) {
  const prompt = optText(card.l1_text ?? card.prompt_l1 ?? card.spanish ?? card.spanish_text ?? card.prompt_es);
  const answer = optText(card.l2_text ?? card.answer_l2 ?? card.english ?? card.english_text ?? card.answer_en);
  if (!prompt || !answer) return null;
  const examples = normExamplePairs(
    card.examples,
    card.example_l1 ?? card.example_es,
    card.example_l2 ?? card.example_en
  );
  const first = examples[0] ?? null;
  const l2Definition = optText(card.l2_definition ?? card.definition_en);
  const l1Translations = normList(card.l1_translations ?? card.main_translations_es);
  const l2Synonyms = normList(card.l2_synonyms ?? card.synonyms_en);
  const collocations = normList(card.collocations);
  const exampleSentence = first ? first.l2 : optText(card.example_sentence);
  const exampleL1 = first ? first.l1 : optText(card.example_l1 ?? card.example_es);
  const exampleL2 = first ? first.l2 : optText(card.example_l2 ?? card.example_en);
  const l2Mnemonic = optText(card.l2_mnemonic ?? card.mnemonic_en);
  const l2ClozeDistractors = normList(card.l2_cloze_distractors ?? card.cloze_distractors_en);

  return {
    l1_text: prompt,
    l2_text: answer,
    prompt_l1: prompt,
    answer_l2: answer,
    section_name: optText(card.section_name) ?? deckTitle ?? null,
    part_of_speech: optText(card.part_of_speech),
    l2_definition: l2Definition,
    l1_translations: l1Translations,
    collocations,
    l2_synonyms: l2Synonyms,
    examples,
    example_sentence: exampleSentence,
    example_l1: exampleL1,
    example_l2: exampleL2,
    l2_mnemonic: l2Mnemonic,
    l2_cloze_distractors: l2ClozeDistractors,
    _audits: normAudits(card._audits, card.generation_metadata),
  };
}

// Case-insensitive dedup key for a (spanish, english) pair.
export function pairKey(spanish, english) {
  return `${String(spanish).toLowerCase()} ${String(english).toLowerCase()}`;
}
