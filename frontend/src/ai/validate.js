// Deterministic flashcard validators.
// Consumed by both the browser ESM pipeline and re-exported by
// supabase/scripts/lib/validate.cjs (P4).
//
// validateCard() returns issues grouped by the enrichment sub-prompt responsible
// for fixing them ({ lexical, equivalents, examples, synonyms, clozeDistractors,
// card, warnings }), so the generator can re-run ONLY the failing sub-prompt during
// repair. Empty arrays === valid.
//
// Language-aware validation contracts (P4):
// 1. Language checks are parameterized by the language pair descriptor { l1, l2 }
//    via getPairValidationRule() from frontend/src/languages.js.
// 2. Script-range check ensures L2 fields only contain characters of L2's script.
// 3. For same-script pairs, an in-repo n-gram heuristic checks for L1 intrusion.
// 4. Inverted punctuation (¿/¡) only applies when L1 is Spanish and L2 is not.
// 5. Cloze eligibility check respects pair.clozeStrategy; non-verbatim pairs
//    or cloze-ineligible cards report cloze ineligibility as a warning rather than
//    a hard failure in examples, preventing repair loop thrashing.
// 6. es->en verdicts and error messages remain byte-identical to the baseline.

import { locateAnswerInExample, normalizeAnswer } from './cardText.js';
import { getPairValidationRule } from '../languages.js';
import { resolvePairDescriptor } from './promptRules.js';

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

export function validateCard(card, pair) {
  const issues = {
    lexical: [],
    equivalents: [],
    examples: [],
    synonyms: [],
    clozeDistractors: [],
    card: [],
    warnings: [],
  };

  const resolvedPair = resolvePairDescriptor(pair, card);
  const rule = getPairValidationRule(resolvedPair);
  const { l2Name, isDefault } = rule;

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
  } else if (rule.isInvalidTargetText(def)) {
    issues.lexical.push(isDefault
      ? 'l2_definition must be English (no ¿ or ¡)'
      : `l2_definition must be ${l2Name}`);
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
  if (collocations.some((item) => rule.isInvalidTargetText(String(item)))) {
    issues.equivalents.push(isDefault
      ? 'collocations must be English phrases (no ¿ or ¡)'
      : `collocations must be ${l2Name} phrases`);
  }

  // --- examples (examples: [{l1, l2}] + legacy mirror) ---
  const pairs = Array.isArray(card.examples) ? card.examples : [];
  if (pairs.length < EXAMPLES_MIN || pairs.length > EXAMPLES_MAX) {
    issues.examples.push(`examples must contain ${EXAMPLES_MIN} to ${EXAMPLES_MAX} sentence pairs`);
  }
  pairs.forEach((pairItem, index) => {
    const pairL1 = pairItem && (pairItem.l1 ?? pairItem.example_l1 ?? pairItem.es ?? pairItem.example_es);
    const pairL2 = pairItem && (pairItem.l2 ?? pairItem.example_l2 ?? pairItem.en ?? pairItem.example_en);
    if (isBlank(pairL1) || isBlank(pairL2)) {
      issues.examples.push(`examples[${index}] needs both l1 and l2 sentences`);
      return;
    }
    if (rule.isInvalidTargetText(pairL2)) {
      issues.examples.push(isDefault
        ? `examples[${index}].l2 must be English (no ¿ or ¡)`
        : `examples[${index}].l2 must be ${l2Name}`);
    }
    if (String(pairL1).trim().toLowerCase() === String(pairL2).trim().toLowerCase()) {
      issues.examples.push(`examples[${index}] l1 and l2 must be different sentences`);
    }
    // Cloze eligibility:
    // When clozeStrategy is 'verbatim', the app requires the answer verbatim in the sentence.
    // When clozeStrategy is not 'verbatim' (or card is flagged cloze_ineligible),
    // report cloze-ineligibility as a warning rather than a hard failure so the repair
    // loop does not thrash on an unsatisfiable constraint.
    if (!isBlank(l2)) {
      const isBlankable = locateAnswerInExample(pairL2, l2) !== null;
      if (!isBlankable) {
        if (resolvedPair.clozeStrategy === 'verbatim' && !card.cloze_ineligible) {
          issues.examples.push(isDefault
            ? `examples[${index}].l2 must contain the English answer verbatim (word for word) so it can be blanked`
            : `examples[${index}].l2 must contain the ${l2Name} answer verbatim (word for word) so it can be blanked`);
        } else {
          issues.warnings.push(
            `examples[${index}].l2 does not contain the ${l2Name} answer verbatim (cloze-ineligible for verbatim blanking)`
          );
        }
      }
    }
  });
  const l2Norms = pairs.map((pairItem) => normalizeAnswer(String((pairItem && (pairItem.l2 ?? pairItem.example_l2 ?? pairItem.en ?? pairItem.example_en)) ?? '')));
  if (new Set(l2Norms.filter(Boolean)).size !== l2Norms.length) {
    issues.examples.push(isDefault
      ? 'examples must not repeat the same English sentence'
      : `examples must not repeat the same ${l2Name} sentence`);
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
    if (isBlank(exL2)) {
      issues.examples.push('example_l2 is required');
    } else if (rule.isInvalidTargetText(exL2)) {
      issues.examples.push(isDefault
        ? 'example_l2 must be English (no ¿ or ¡)'
        : `example_l2 must be ${l2Name}`);
    }
  }

  // --- synonyms (l2_synonyms) ---
  const synonyms = Array.isArray(card.l2_synonyms ?? card.synonyms_en)
    ? (card.l2_synonyms ?? card.synonyms_en)
    : [];
  if (synonyms.length < 1 || synonyms.length > 3) {
    issues.synonyms.push('l2_synonyms must contain 1 to 3 items');
  }
  if (synonyms.some((item) => rule.isInvalidTargetText(String(item)))) {
    issues.synonyms.push(isDefault
      ? 'l2_synonyms must be English (no ¿ or ¡)'
      : `l2_synonyms must be ${l2Name}`);
  }

  // --- cloze distractors (l2_cloze_distractors, migration 0018) ---
  const options = Array.isArray(card.l2_cloze_distractors ?? card.cloze_distractors_en)
    ? (card.l2_cloze_distractors ?? card.cloze_distractors_en)
    : [];
  if (options.length < CLOZE_DISTRACTORS_MIN || options.length > CLOZE_DISTRACTORS_MAX) {
    issues.clozeDistractors.push(`l2_cloze_distractors must contain ${CLOZE_DISTRACTORS_MIN} to ${CLOZE_DISTRACTORS_MAX} items`);
  }
  if (options.some((option) => rule.isInvalidTargetText(String(option)))) {
    issues.clozeDistractors.push(isDefault
      ? 'l2_cloze_distractors must be English (no ¿ or ¡)'
      : `l2_cloze_distractors must be ${l2Name}`);
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
    ? pairs.map((pairItem) => (pairItem && (pairItem.l2 ?? pairItem.example_l2 ?? pairItem.en ?? pairItem.example_en)) || '')
    : [card.example_l2 ?? card.example_en].filter((sentence) => !isBlank(sentence));
  if (options.some((option) => sentences.some((en) => !isBlank(en) && locateAnswerInExample(en, String(option)) !== null))) {
    issues.clozeDistractors.push('l2_cloze_distractors must not reuse a word already present in an example sentence');
  }

  return issues;
}

export function hasIssues(issues) {
  if (!issues || typeof issues !== 'object') return false;
  const { warnings, ...hardGroups } = issues;
  return Object.values(hardGroups).some((group) => Array.isArray(group) && group.length > 0);
}

export function flatten(issues) {
  if (!issues || typeof issues !== 'object') return [];
  const { warnings, ...hardGroups } = issues;
  return Object.values(hardGroups).flat();
}

export function hasWarnings(issues) {
  return Array.isArray(issues?.warnings) && issues.warnings.length > 0;
}

export function flattenWarnings(issues) {
  return Array.isArray(issues?.warnings) ? [...issues.warnings] : [];
}
