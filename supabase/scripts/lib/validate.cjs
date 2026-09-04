// Deterministic flashcard validators.
// validateCard() returns issues grouped by the enrichment sub-prompt responsible
// for fixing them ({ lexical, equivalents, examples, synonyms, clozeDistractors,
// card }), so the generator can re-run ONLY the failing sub-prompt during repair.
// Empty arrays === valid.
//
// mnemonic_en is no longer validated or generated (the memory-hook feature was
// removed from the app on 2026-07-08); existing values are still carried through
// to seed SQL untouched.
//
// LLM-judged quality (theme fit, blank inferability, cloze solvability) is NOT
// checked here — that lives in lib/enrich.cjs audits, which record pass results
// in card._audits.

const { locateAnswerInExample, normalizeAnswer } = require('./minigame_text.cjs');

const INVERTED_PUNCT = /[¿¡]/; // Spanish-only punctuation; must not appear in English fields

// Every card carries 3–4 matched example pairs (examples: [{es, en}]) so the
// fill-in-the-blank games can vary the sentence across presentations
// (migration 0019). The legacy example_es/example_en/example_sentence columns
// mirror pair 0 (lib/cards.cjs normCard keeps them in sync mechanically).
const EXAMPLES_MIN = 3;
const EXAMPLES_MAX = 4;

// The word-bank cloze needs 3 wrong options for a 4-tile round; 4 gives the
// distractor RPC room to vary repeat plays. Keep in sync with migration 0018
// (RPC uses >=2 curated as usable) and MIN_MC_DISTRACTORS in MinigameHost.jsx.
const CLOZE_DISTRACTORS_MIN = 3;
const CLOZE_DISTRACTORS_MAX = 4;

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function validateCard(card) {
  const issues = { lexical: [], equivalents: [], examples: [], synonyms: [], clozeDistractors: [], card: [] };

  const l1 = card.l1_text ?? card.prompt_l1 ?? card.spanish_text ?? card.spanish;
  const l2 = card.l2_text ?? card.answer_l2 ?? card.english_text ?? card.english;

  // --- card-level ---
  if (isBlank(l1)) issues.card.push('l1_text is empty');
  if (isBlank(l2)) issues.card.push('l2_text is empty');
  if (!isBlank(l1) && !isBlank(l2) &&
      String(l1).trim().toLowerCase() === String(l2).trim().toLowerCase()) {
    issues.card.push('l1_text and l2_text must differ');
  }

  // --- lexical (part_of_speech + l2_definition) ---
  const def = card.l2_definition ?? card.definition_en;
  if (isBlank(card.part_of_speech)) issues.lexical.push('part_of_speech is required');
  if (isBlank(def)) {
    issues.lexical.push('l2_definition is required');
  } else if (INVERTED_PUNCT.test(def)) {
    issues.lexical.push('l2_definition must be English (no ¿ or ¡)');
  }

  // --- equivalents (l1_translations + collocations) ---
  const mtsRaw = card.l1_translations ?? card.main_translations_es;
  const mts = Array.isArray(mtsRaw) ? mtsRaw : [];
  if (mts.length < 1 || mts.length > 3) {
    issues.equivalents.push('l1_translations must contain 1 to 3 items');
  }
  const cols = Array.isArray(card.collocations) ? card.collocations : [];
  if (cols.length < 2 || cols.length > 4) {
    issues.equivalents.push('collocations must contain 2 to 4 items');
  }
  if (cols.some((c) => INVERTED_PUNCT.test(String(c)))) {
    issues.equivalents.push('collocations must be English phrases (no ¿ or ¡)');
  }

  // --- examples (examples: [{l1, l2}] + legacy mirror) ---
  const pairs = Array.isArray(card.examples) ? card.examples : [];
  if (pairs.length < EXAMPLES_MIN || pairs.length > EXAMPLES_MAX) {
    issues.examples.push(`examples must contain ${EXAMPLES_MIN} to ${EXAMPLES_MAX} sentence pairs`);
  }
  pairs.forEach((p, i) => {
    const pairL1 = p && (p.l1 ?? p.example_l1 ?? p.es ?? p.example_es);
    const pairL2 = p && (p.l2 ?? p.example_l2 ?? p.en ?? p.example_en);
    if (isBlank(pairL1) || isBlank(pairL2)) {
      issues.examples.push(`examples[${i}] needs both l1 and l2 sentences`);
      return;
    }
    if (INVERTED_PUNCT.test(pairL2)) {
      issues.examples.push(`examples[${i}].l2 must be English (no ¿ or ¡)`);
    }
    if (String(pairL1).trim().toLowerCase() === String(pairL2).trim().toLowerCase()) {
      issues.examples.push(`examples[${i}] l1 and l2 must be different sentences`);
    }
    // Cloze eligibility: the app can only blank the answer out of a sentence
    // when it appears verbatim at word boundaries (same rule as the frontend's
    // locateAnswerInExample). Every stored pair must be blankable, so any of
    // them can back the fill-in-the-blank games.
    if (!isBlank(l2) && locateAnswerInExample(pairL2, l2) === null) {
      issues.examples.push(`examples[${i}].l2 must contain the English answer verbatim (word for word) so it can be blanked`);
    }
  });
  const l2Norms = pairs.map((p) => normalizeAnswer(String((p && (p.l2 ?? p.example_l2 ?? p.en ?? p.example_en)) ?? '')));
  if (new Set(l2Norms.filter(Boolean)).size !== l2Norms.length) {
    issues.examples.push('examples must not repeat the same English sentence');
  }
  // Legacy mirror: example_l1/example_l2/example_sentence must equal pair 0
  // (normCard repairs this mechanically; flagging covers hand-edited data that
  // bypassed normCard).
  if (pairs.length && pairs[0]) {
    const pair0L1 = pairs[0].l1 ?? pairs[0].example_l1 ?? pairs[0].es ?? pairs[0].example_es;
    const pair0L2 = pairs[0].l2 ?? pairs[0].example_l2 ?? pairs[0].en ?? pairs[0].example_en;
    if (!isBlank(pair0L2)) {
      const exL1 = card.example_l1 ?? card.example_es;
      const exL2 = card.example_l2 ?? card.example_en;
      const exSentence = card.example_sentence ?? card.example_l2 ?? card.example_en;
      if (exL2 !== pair0L2 || exL1 !== pair0L1 || exSentence !== pair0L2) {
        issues.examples.push('example_l1/example_l2/example_sentence must mirror examples[0]');
      }
    }
  } else if (pairs.length === 0) {
    // No pair set at all: keep the legacy fields' own sanity checks so partially
    // migrated data still reports something actionable.
    const exL1 = card.example_l1 ?? card.example_es;
    const exL2 = card.example_l2 ?? card.example_en;
    if (isBlank(exL1)) issues.examples.push('example_l1 is required');
    if (isBlank(exL2)) issues.examples.push('example_l2 is required');
  }

  // --- synonyms (l2_synonyms) ---
  const synRaw = card.l2_synonyms ?? card.synonyms_en;
  const syn = Array.isArray(synRaw) ? synRaw : [];
  if (syn.length < 1 || syn.length > 3) {
    issues.synonyms.push('l2_synonyms must contain 1 to 3 items');
  }
  if (syn.some((s) => INVERTED_PUNCT.test(String(s)))) {
    issues.synonyms.push('l2_synonyms must be English (no ¿ or ¡)');
  }

  // --- cloze distractors (l2_cloze_distractors, migration 0018) ---
  // Deterministic shape checks only; whether a distractor secretly fits a
  // blank is judged by the clozeSolve audit in lib/enrich.cjs (per sentence).
  const optsRaw = card.l2_cloze_distractors ?? card.cloze_distractors_en;
  const opts = Array.isArray(optsRaw) ? optsRaw : [];
  if (opts.length < CLOZE_DISTRACTORS_MIN || opts.length > CLOZE_DISTRACTORS_MAX) {
    issues.clozeDistractors.push(`l2_cloze_distractors must contain ${CLOZE_DISTRACTORS_MIN} to ${CLOZE_DISTRACTORS_MAX} items`);
  }
  if (opts.some((o) => INVERTED_PUNCT.test(String(o)))) {
    issues.clozeDistractors.push('l2_cloze_distractors must be English (no ¿ or ¡)');
  }
  if (opts.some((o) => String(o).length > 60)) {
    issues.clozeDistractors.push('each cloze distractor must stay short (max 60 chars)');
  }
  const normOpts = opts.map((o) => normalizeAnswer(String(o)));
  if (new Set(normOpts.filter(Boolean)).size !== normOpts.length) {
    issues.clozeDistractors.push('l2_cloze_distractors must not contain blanks or duplicates');
  }
  // A distractor restating the answer or a synonym would make two options
  // "correct"; one already present in any example sentence reads as broken.
  const answerForms = new Set(
    [l2, ...syn].map((s) => normalizeAnswer(String(s ?? ''))).filter(Boolean),
  );
  if (normOpts.some((o) => answerForms.has(o))) {
    issues.clozeDistractors.push('l2_cloze_distractors must not restate the answer or its synonyms');
  }
  const sentences = pairs.length
    ? pairs.map((p) => (p && (p.l2 ?? p.example_l2 ?? p.en ?? p.example_en)) || '')
    : [card.example_l2 ?? card.example_en].filter((s) => !isBlank(s));
  if (opts.some((o) => sentences.some((en) => !isBlank(en) && locateAnswerInExample(en, String(o)) !== null))) {
    issues.clozeDistractors.push('l2_cloze_distractors must not reuse a word already present in an example sentence');
  }

  return issues;
}

function hasIssues(issues) {
  return Object.values(issues).some((arr) => arr.length > 0);
}

function flatten(issues) {
  return Object.values(issues).flat();
}

module.exports = {
  validateCard, hasIssues, flatten,
  EXAMPLES_MIN, EXAMPLES_MAX,
  CLOZE_DISTRACTORS_MIN, CLOZE_DISTRACTORS_MAX,
};
