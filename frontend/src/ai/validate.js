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
  const translations = Array.isArray(card.l1_translations ?? card.main_translations_es)
    ? (card.l1_translations ?? card.main_translations_es)
    : [];
  if (translations.length < 1 || translations.length > 3) {
    issues.equivalents.push('l1_translations must contain 1 to 3 items');
  }
  const collocations = Array.isArray(card.collocations) ? card.collocations : [];
  if (collocations.length < 2 || collocations.length > 4) {
    issues.equivalents.push('collocations must contain 2 to 4 items');
  }
  if (collocations.some((item) => INVERTED_PUNCT.test(String(item)))) {
    issues.equivalents.push('collocations must be English phrases (no ¿ or ¡)');
  }

  // --- examples (examples: [{l1, l2}] + legacy mirror) ---
  const pairs = Array.isArray(card.examples) ? card.examples : [];
  if (pairs.length < EXAMPLES_MIN || pairs.length > EXAMPLES_MAX) {
    issues.examples.push(`examples must contain ${EXAMPLES_MIN} to ${EXAMPLES_MAX} sentence pairs`);
  }
  pairs.forEach((pair, index) => {
    const pairL1 = pair && (pair.l1 ?? pair.example_l1 ?? pair.es ?? pair.example_es);
    const pairL2 = pair && (pair.l2 ?? pair.example_l2 ?? pair.en ?? pair.example_en);
    if (isBlank(pairL1) || isBlank(pairL2)) {
      issues.examples.push(`examples[${index}] needs both l1 and l2 sentences`);
      return;
    }
    if (INVERTED_PUNCT.test(pairL2)) {
      issues.examples.push(`examples[${index}].l2 must be English (no ¿ or ¡)`);
    }
    if (String(pairL1).trim().toLowerCase() === String(pairL2).trim().toLowerCase()) {
      issues.examples.push(`examples[${index}] l1 and l2 must be different sentences`);
    }
    // Cloze eligibility: the app can only blank the answer out of a sentence
    // when it appears verbatim at word boundaries, so every stored pair must be
    // blankable — any of them can back a fill-in-the-blank game.
    if (!isBlank(l2) && locateAnswerInExample(pairL2, l2) === null) {
      issues.examples.push(`examples[${index}].l2 must contain the English answer verbatim (word for word) so it can be blanked`);
    }
  });
  const l2Norms = pairs.map((pair) => normalizeAnswer(String((pair && (pair.l2 ?? pair.example_l2 ?? pair.en ?? pair.example_en)) ?? '')));
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
    const exL1 = card.example_l1 ?? card.example_es;
    const exL2 = card.example_l2 ?? card.example_en;
    if (isBlank(exL1)) issues.examples.push('example_l1 is required');
    if (isBlank(exL2)) issues.examples.push('example_l2 is required');
  }

  // --- synonyms (l2_synonyms) ---
  const synonyms = Array.isArray(card.l2_synonyms ?? card.synonyms_en)
    ? (card.l2_synonyms ?? card.synonyms_en)
    : [];
  if (synonyms.length < 1 || synonyms.length > 3) {
    issues.synonyms.push('l2_synonyms must contain 1 to 3 items');
  }
  if (synonyms.some((item) => INVERTED_PUNCT.test(String(item)))) {
    issues.synonyms.push('l2_synonyms must be English (no ¿ or ¡)');
  }

  // --- cloze distractors (l2_cloze_distractors, migration 0018) ---
  const options = Array.isArray(card.l2_cloze_distractors ?? card.cloze_distractors_en)
    ? (card.l2_cloze_distractors ?? card.cloze_distractors_en)
    : [];
  if (options.length < CLOZE_DISTRACTORS_MIN || options.length > CLOZE_DISTRACTORS_MAX) {
    issues.clozeDistractors.push(`l2_cloze_distractors must contain ${CLOZE_DISTRACTORS_MIN} to ${CLOZE_DISTRACTORS_MAX} items`);
  }
  if (options.some((option) => INVERTED_PUNCT.test(String(option)))) {
    issues.clozeDistractors.push('l2_cloze_distractors must be English (no ¿ or ¡)');
  }
  if (options.some((option) => String(option).length > 60)) {
    issues.clozeDistractors.push('each cloze distractor must stay short (max 60 chars)');
  }
  const normOptions = options.map((option) => normalizeAnswer(String(option)));
  if (new Set(normOptions.filter(Boolean)).size !== normOptions.length) {
    issues.clozeDistractors.push('l2_cloze_distractors must not contain blanks or duplicates');
  }
  const answerForms = new Set(
    [l2, ...synonyms].map((item) => normalizeAnswer(String(item ?? ''))).filter(Boolean),
  );
  if (normOptions.some((option) => answerForms.has(option))) {
    issues.clozeDistractors.push('l2_cloze_distractors must not restate the answer or its synonyms');
  }
  const sentences = pairs.length
    ? pairs.map((pair) => (pair && (pair.l2 ?? pair.example_l2 ?? pair.en ?? pair.example_en)) || '')
    : [card.example_l2 ?? card.example_en].filter((sentence) => !isBlank(sentence));
  if (options.some((option) => sentences.some((en) => !isBlank(en) && locateAnswerInExample(en, String(option)) !== null))) {
    issues.clozeDistractors.push('l2_cloze_distractors must not reuse a word already present in an example sentence');
  }

  return issues;
}

export function hasIssues(issues) {
  return Object.values(issues).some((group) => group.length > 0);
}

export function flatten(issues) {
  return Object.values(issues).flat();
}
