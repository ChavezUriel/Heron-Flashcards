// Deterministic flashcard validators — browser port of
// supabase/scripts/lib/validate.cjs.
//
// validateCard() returns issues grouped by the enrichment sub-prompt responsible
// for fixing them ({ lexical, equivalents, examples, synonyms, clozeDistractors,
// card }), so the generator can re-run ONLY the failing sub-prompt during
// repair. Empty arrays === valid.
//
// LLM-judged quality (theme fit, blank inferability, cloze solvability) is NOT
// checked here — that lives in the audits in enrich.js.

// Explicit .js extension is required by run_browser_pipeline_tests.mjs (Node ESM resolver)
import { locateAnswerInExample, normalizeAnswer } from './cardText.js';

const INVERTED_PUNCT = /[¿¡]/; // Spanish-only punctuation; must not appear in English fields

// Every card carries 3–4 matched example pairs so the fill-in-the-blank games
// can vary the sentence across presentations (migration 0019).
export const EXAMPLES_MIN = 3;
export const EXAMPLES_MAX = 4;

// The word-bank cloze needs 3 wrong options for a 4-tile round; 4 gives the
// distractor RPC room to vary repeat plays (migration 0018).
export const CLOZE_DISTRACTORS_MIN = 3;
export const CLOZE_DISTRACTORS_MAX = 4;

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

export function validateCard(card) {
  const issues = { lexical: [], equivalents: [], examples: [], synonyms: [], clozeDistractors: [], card: [] };

  // --- card-level ---
  if (isBlank(card.spanish_text)) issues.card.push('spanish_text is empty');
  if (isBlank(card.english_text)) issues.card.push('english_text is empty');
  if (!isBlank(card.spanish_text) && !isBlank(card.english_text) &&
      card.spanish_text.trim().toLowerCase() === card.english_text.trim().toLowerCase()) {
    issues.card.push('spanish_text and english_text must differ');
  }

  // --- lexical (part_of_speech + definition_en) ---
  if (isBlank(card.part_of_speech)) issues.lexical.push('part_of_speech is required');
  if (isBlank(card.definition_en)) {
    issues.lexical.push('definition_en is required');
  } else if (INVERTED_PUNCT.test(card.definition_en)) {
    issues.lexical.push('definition_en must be English (no ¿ or ¡)');
  }

  // --- equivalents (main_translations_es + collocations) ---
  const translations = Array.isArray(card.main_translations_es) ? card.main_translations_es : [];
  if (translations.length < 1 || translations.length > 3) {
    issues.equivalents.push('main_translations_es must contain 1 to 3 items');
  }
  const collocations = Array.isArray(card.collocations) ? card.collocations : [];
  if (collocations.length < 2 || collocations.length > 4) {
    issues.equivalents.push('collocations must contain 2 to 4 items');
  }
  if (collocations.some((item) => INVERTED_PUNCT.test(String(item)))) {
    issues.equivalents.push('collocations must be English phrases (no ¿ or ¡)');
  }

  // --- examples (examples: [{es, en}] + legacy mirror) ---
  const pairs = Array.isArray(card.examples) ? card.examples : [];
  if (pairs.length < EXAMPLES_MIN || pairs.length > EXAMPLES_MAX) {
    issues.examples.push(`examples must contain ${EXAMPLES_MIN} to ${EXAMPLES_MAX} sentence pairs`);
  }
  pairs.forEach((pair, index) => {
    const es = pair && pair.es;
    const en = pair && pair.en;
    if (isBlank(es) || isBlank(en)) {
      issues.examples.push(`examples[${index}] needs both es and en sentences`);
      return;
    }
    if (INVERTED_PUNCT.test(en)) {
      issues.examples.push(`examples[${index}].en must be English (no ¿ or ¡)`);
    }
    if (es.trim().toLowerCase() === en.trim().toLowerCase()) {
      issues.examples.push(`examples[${index}] es and en must be different sentences`);
    }
    // Cloze eligibility: the app can only blank the answer out of a sentence
    // when it appears verbatim at word boundaries, so every stored pair must be
    // blankable — any of them can back a fill-in-the-blank game.
    if (!isBlank(card.english_text) && locateAnswerInExample(en, card.english_text) === null) {
      issues.examples.push(`examples[${index}].en must contain the English answer verbatim (word for word) so it can be blanked`);
    }
  });
  const enNorms = pairs.map((pair) => normalizeAnswer(String((pair && pair.en) ?? '')));
  if (new Set(enNorms.filter(Boolean)).size !== enNorms.length) {
    issues.examples.push('examples must not repeat the same English sentence');
  }
  if (pairs.length && pairs[0] && !isBlank(pairs[0].en)) {
    if (card.example_en !== pairs[0].en || card.example_es !== pairs[0].es ||
        card.example_sentence !== pairs[0].en) {
      issues.examples.push('example_es/example_en/example_sentence must mirror examples[0]');
    }
  } else if (pairs.length === 0) {
    if (isBlank(card.example_es)) issues.examples.push('example_es is required');
    if (isBlank(card.example_en)) issues.examples.push('example_en is required');
  }

  // --- synonyms (synonyms_en) ---
  const synonyms = Array.isArray(card.synonyms_en) ? card.synonyms_en : [];
  if (synonyms.length < 1 || synonyms.length > 3) {
    issues.synonyms.push('synonyms_en must contain 1 to 3 items');
  }
  if (synonyms.some((item) => INVERTED_PUNCT.test(String(item)))) {
    issues.synonyms.push('synonyms_en must be English (no ¿ or ¡)');
  }

  // --- cloze distractors (cloze_distractors_en, migration 0018) ---
  const options = Array.isArray(card.cloze_distractors_en) ? card.cloze_distractors_en : [];
  if (options.length < CLOZE_DISTRACTORS_MIN || options.length > CLOZE_DISTRACTORS_MAX) {
    issues.clozeDistractors.push(`cloze_distractors_en must contain ${CLOZE_DISTRACTORS_MIN} to ${CLOZE_DISTRACTORS_MAX} items`);
  }
  if (options.some((option) => INVERTED_PUNCT.test(String(option)))) {
    issues.clozeDistractors.push('cloze_distractors_en must be English (no ¿ or ¡)');
  }
  if (options.some((option) => String(option).length > 60)) {
    issues.clozeDistractors.push('each cloze distractor must stay short (max 60 chars)');
  }
  const normOptions = options.map((option) => normalizeAnswer(String(option)));
  if (new Set(normOptions.filter(Boolean)).size !== normOptions.length) {
    issues.clozeDistractors.push('cloze_distractors_en must not contain blanks or duplicates');
  }
  const answerForms = new Set(
    [card.english_text, ...synonyms].map((item) => normalizeAnswer(String(item ?? ''))).filter(Boolean),
  );
  if (normOptions.some((option) => answerForms.has(option))) {
    issues.clozeDistractors.push('cloze_distractors_en must not restate the answer or its synonyms');
  }
  const sentences = pairs.length
    ? pairs.map((pair) => (pair && pair.en) || '')
    : [card.example_en].filter((sentence) => !isBlank(sentence));
  if (options.some((option) => sentences.some((en) => !isBlank(en) && locateAnswerInExample(en, String(option)) !== null))) {
    issues.clozeDistractors.push('cloze_distractors_en must not reuse a word already present in an example sentence');
  }

  return issues;
}

export function hasIssues(issues) {
  return Object.values(issues).some((group) => group.length > 0);
}

export function flatten(issues) {
  return Object.values(issues).flat();
}
