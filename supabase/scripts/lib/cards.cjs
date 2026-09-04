// Shared card normalization + dedup helpers.
// Used by both generate_seed.cjs (compiles seed.sql) and generate_cards.cjs
// (the AI generator) so the generator always emits exactly what the seed
// compiler accepts. Keep this dependency-free (pure Node).

function optText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normList(v) {
  if (!Array.isArray(v)) return [];
  const out = [], seen = new Set();
  for (const item of v) {
    const s = optText(item);
    if (s === null) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Pipeline bookkeeping written by lib/enrich.cjs: per-card LLM-audit results
// ({ example_quality: { version, fingerprint, status, checked_at }, ... }).
// Lives ONLY in the seed_data JSON so re-runs can skip already-passed audits;
// the seed SQL compilers ignore it (it never reaches the database).
function normAudits(v, genMeta) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (genMeta && typeof genMeta === 'object' && !Array.isArray(genMeta) &&
      genMeta._audits && typeof genMeta._audits === 'object' && !Array.isArray(genMeta._audits)) {
    return genMeta._audits;
  }
  return null;
}

// Example sentence pairs (migration 0019 & 0034): [{ l1, l2 }], deduped by L2
// sentence. Accepts the storage keys ({l1, l2}, {es, en}) and the LLM output keys
// ({example_l1, example_l2}, {example_es, example_en}). When a card predates the
// multi-example feature, its single legacy pair seeds the list so the pipeline only
// has to ADD pairs.
function normExamplePairs(v, legacyEs, legacyEn) {
  const out = [], seen = new Set();
  const push = (l1Raw, l2Raw) => {
    const l1 = optText(l1Raw), l2 = optText(l2Raw);
    if (!l1 || !l2) return;
    const k = l2.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ l1, l2 });
  };
  if (Array.isArray(v)) {
    for (const p of v) {
      if (!p || typeof p !== 'object') continue;
      push(p.l1 ?? p.example_l1 ?? p.es ?? p.example_es, p.l2 ?? p.example_l2 ?? p.en ?? p.example_en);
    }
  }
  if (!out.length) push(legacyEs, legacyEn);
  return out;
}

// Normalize one authored/generated card into the enriched seed shape.
// Accepts either {l1_text, l2_text} / {spanish, english} (draft) or the fully enriched object.
// When the card has example pairs, the legacy example_l1/example_l2/
// example_sentence columns are mirrored from pair 0 mechanically.
function normCard(card, deckTitle) {
  const prompt = optText(card.l1_text ?? card.prompt_l1 ?? card.spanish ?? card.spanish_text ?? card.prompt_es);
  const answer = optText(card.l2_text ?? card.answer_l2 ?? card.english ?? card.english_text ?? card.answer_en);
  if (!prompt || !answer) throw new Error('card missing l1_text/l2_text: ' + JSON.stringify(card));
  const examples = normExamplePairs(
    card.examples,
    card.example_l1 ?? card.example_es,
    card.example_l2 ?? card.example_en
  );
  const first = examples[0] || null;
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

// Case-insensitive dedup key for an (l1, l2) pair.
function pairKey(l1, l2) {
  return String(l1).toLowerCase() + ' ' + String(l2).toLowerCase();
}

module.exports = { optText, normList, normCard, pairKey };
