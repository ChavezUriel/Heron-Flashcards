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

// Example sentence pairs (migration 0019): [{ es, en }], deduped by normalized
// English sentence. Accepts the storage keys ({es, en}) and the LLM output keys
// ({example_es, example_en}). When a card predates the multi-example feature,
// its single legacy pair seeds the list so the pipeline only has to ADD pairs.
function normExamplePairs(v, legacyEs, legacyEn) {
  const out = [], seen = new Set();
  const push = (esRaw, enRaw) => {
    const es = optText(esRaw), en = optText(enRaw);
    if (!es || !en) return;
    const k = en.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ es, en });
  };
  if (Array.isArray(v)) {
    for (const p of v) {
      if (!p || typeof p !== 'object') continue;
      push(p.es ?? p.example_es, p.en ?? p.example_en);
    }
  }
  if (!out.length) push(legacyEs, legacyEn);
  return out;
}

// Normalize one authored/generated card into the enriched seed shape.
// Accepts either {spanish, english} (draft) or the fully enriched object.
// When the card has example pairs, the legacy example_es/example_en/
// example_sentence columns are mirrored from pair 0 mechanically — the pairs
// are the source of truth and the mirror is what pre-0019 consumers (and the
// 0017 sync hash) read.
function normCard(card, deckTitle) {
  const spanish = optText(card.spanish ?? card.spanish_text ?? card.prompt_es);
  const english = optText(card.english ?? card.english_text ?? card.answer_en);
  if (!spanish || !english) throw new Error('card missing spanish/english: ' + JSON.stringify(card));
  const examples = normExamplePairs(card.examples, card.example_es, card.example_en);
  const first = examples[0] || null;
  return {
    spanish_text: spanish,
    english_text: english,
    section_name: optText(card.section_name) ?? deckTitle,
    part_of_speech: optText(card.part_of_speech),
    definition_en: optText(card.definition_en),
    main_translations_es: normList(card.main_translations_es),
    collocations: normList(card.collocations),
    synonyms_en: normList(card.synonyms_en),
    // Example pairs (migration 0019) + the legacy pair-0 mirror.
    examples,
    example_sentence: first ? first.en : optText(card.example_sentence),
    example_es: first ? first.es : optText(card.example_es),
    example_en: first ? first.en : optText(card.example_en),
    // Kept as data (and in seed SQL) even though the app no longer shows it.
    mnemonic_en: optText(card.mnemonic_en),
    // Curated word-bank cloze options (migration 0018).
    cloze_distractors_en: normList(card.cloze_distractors_en),
    _audits: normAudits(card._audits, card.generation_metadata),
  };
}

// Case-insensitive dedup key for a (spanish, english) pair.
function pairKey(spanish, english) {
  return String(spanish).toLowerCase() + ' ' + String(english).toLowerCase();
}

module.exports = { optText, normList, normCard, pairKey };
