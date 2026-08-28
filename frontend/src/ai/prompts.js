// Prompt builders for the card generator — browser port of
// supabase/scripts/lib/prompts.cjs, kept text-for-text identical so the in-app
// builder produces cards indistinguishable from the CLI's.
//
// Every builder returns { system, user, temperature }. The `user` content is a
// compact JSON document — light models follow an explicit schema + rules better
// than prose. Each enrichment builder accepts an optional `issues` array so the
// SAME builder is reused for targeted repair (re-run only the failing
// sub-prompt).
//
// Two kinds of builders live here:
//   * enrichment (write fields):   lexical / equivalents / examples (3+ pairs) /
//                                  exampleRewrite (one pair) / synonyms /
//                                  clozeDistractors
//   * audit (judge fields, LLM-as-judge): exampleAudit (one pair) / clozeSolve
//     (one sentence) — verdicts that enrich.js turns into repair issues for the
//     enrichment builders. Audits run at temperature 0 so verdicts are stable.

import { blankedExample } from './cardText.js';

export const PROMPT_VERSIONS = {
  blueprint: 'blueprint-v1',
  wordset: 'wordset-v1',
  lexical: 'enrich-lexical-v1',
  equivalents: 'enrich-equivalents-v1',
  examples: 'enrich-examples-v3',
  exampleRewrite: 'enrich-example-rewrite-v1',
  synonyms: 'enrich-synonyms-v1',
  clozeDistractors: 'cloze-distractors-v1',
  exampleAudit: 'audit-examples-v1',
  clozeSolve: 'audit-cloze-solve-v1',
  fieldAudit: 'audit-fields-v2',
};

// How many example sentence pairs a card carries.
export const EXAMPLES_TARGET = 3;

export function deckContext(spec) {
  const source = spec ?? {};
  return {
    title: source.title,
    description: source.description,
    topic: source.topic || source.title,
    difficulty: source.difficulty || 'beginner',
    learner_profile: source.learner_profile || 'Spanish-speaking learners of English',
    generation_notes: source.generation_notes || '',
  };
}

function withIssues(doc, issues) {
  if (Array.isArray(issues) && issues.length) {
    doc.fix_these_issues = issues;
    doc.note = 'A previous attempt was rejected. Fix the listed issues and return corrected JSON only.';
  }
  return doc;
}

// The rules every example_en sentence must obey, shared by the set builder and
// the single-pair rewrite so the two can never drift apart.
const EXAMPLE_PAIR_RULES = [
  'Each example_es is a natural Spanish sentence that uses the Spanish prompt; each example_en is its English counterpart using the English answer naturally; the two must mean the same thing.',
  'Every sentence must fit the deck topic and difficulty described in `deck`.',
  'Every example_en must contain the English answer VERBATIM — the exact words, uninflected and uninterrupted — because the app blanks it out for a fill-in-the-blank exercise.',
  'Write concrete, specific scenes: if the English answer were replaced by a blank, the rest of the sentence should strongly imply the missing answer. Avoid generic frames like "I like ...", "This is a ...", or "... is good", where almost any word fits.',
  'example_en must be in English (no inverted ¿ ¡ punctuation); example_es is in Spanish.',
];

// ---- Stage 1: deck blueprint (sections) -----------------------------------
export function blueprintPrompt(spec) {
  const system =
    'You design high-quality Spanish to English flashcard decks for Spanish-speaking learners of English. ' +
    'Return JSON only. Plan a coherent set of thematic sections that, together, cover the deck topic well.';
  const user = JSON.stringify({
    task: 'Plan the sections of a Spanish to English flashcard deck.',
    deck: deckContext(spec),
    target_total_cards: spec.target_card_count || 20,
    required_output: {
      sections: [
        { name: 'string', communicative_goal: 'string', lexical_focus: ['string'], target_card_count: 0 },
      ],
    },
    rules: [
      'Produce 2 to 6 sections.',
      'The sum of target_card_count across sections should equal target_total_cards.',
      'Each section needs 3 to 8 concrete lexical_focus keywords (in English).',
      'Sections must be communicatively distinct, not overlapping.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0.2 };
}

// ---- Stage 2: word-set draft for one section ------------------------------
export function wordSetPrompt(spec, section, requestedCount, mustAvoidPairs) {
  const system =
    'You build Spanish to English flashcard word sets for Spanish-speaking learners of English. ' +
    'Return JSON only. Focus on a coherent, well-distributed set of pairs. ' +
    'Avoid duplicates, trivial variants, and near-synonyms.';
  const user = JSON.stringify({
    task: 'Generate Spanish to English flashcard pairs for one section.',
    deck: deckContext(spec),
    section: {
      name: section.name,
      communicative_goal: section.communicative_goal || '',
      lexical_focus: section.lexical_focus || [],
    },
    requested_count: requestedCount,
    must_avoid_pairs: (mustAvoidPairs || []).slice(0, 200),
    required_output: { cards: [{ spanish: 'string', english: 'string' }] },
    rules: [
      'Return up to the requested number of cards.',
      'Spanish is the prompt; English is the answer.',
      'Do not repeat any pair listed in must_avoid_pairs.',
      'Output only the spanish and english fields in this phase.',
      'Spread cards across the section lexical_focus; do not cluster on one subtopic.',
      'Prefer communicatively distinct cards over inflectional variants.',
      'Keep the English answer short, natural, and learner-friendly.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0.3 };
}

// ---- Stage 3a: lexical metadata (part_of_speech + definition_en) ----------
export function lexicalPrompt(card, issues) {
  const system =
    'You add precise linguistic metadata to a single Spanish to English flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Provide part_of_speech and an English definition for the English answer.',
    card: { spanish: card.spanish_text, english: card.english_text },
    required_output: { part_of_speech: 'string', definition_en: 'string' },
    rules: [
      'part_of_speech describes the English answer (e.g. noun, verb, adjective, expression, question).',
      'definition_en is one concise, natural English sentence defining the English answer.',
      'Do not include Spanish text in either field.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.1 };
}

// ---- Stage 3b: equivalents (main_translations_es + collocations) ----------
export function equivalentsPrompt(card, issues) {
  const system =
    'You add Spanish equivalents and English collocations to a single flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Provide Spanish translations of the prompt and English collocations for the answer.',
    card: { spanish: card.spanish_text, english: card.english_text },
    required_output: { main_translations_es: ['string'], collocations: ['string'] },
    rules: [
      'main_translations_es: 1 to 3 natural Spanish equivalents of the Spanish prompt (in Spanish).',
      'collocations: 2 to 4 common English phrases that use the English answer (in English).',
      'No duplicates within a list. Keep each item short.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.2 };
}

// ---- Stage 3c: example set (examples: 3 pairs) -----------------------------
export function examplesPrompt(card, issues, deck) {
  const system =
    'You write matched example sentence pairs for a single Spanish to English flashcard. Return JSON only.';
  const existing = (Array.isArray(card.examples) ? card.examples : [])
    .filter((pair) => pair && pair.es && pair.en)
    .map((pair) => ({ example_es: pair.es, example_en: pair.en }));
  const user = JSON.stringify(withIssues({
    task: 'Write Spanish example sentences and their English counterparts.',
    deck: deckContext(deck),
    card: {
      spanish: card.spanish_text,
      english: card.english_text,
      part_of_speech: card.part_of_speech || undefined,
    },
    existing_examples: existing,
    required_output: { examples: [{ example_es: 'string', example_en: 'string' }] },
    rules: [
      `Return exactly ${EXAMPLES_TARGET} example pairs — the complete final set.`,
      'Each pair must show a DIFFERENT concrete situation; no two example_en sentences may be near-duplicates of each other.',
      'You may keep any pair from existing_examples that already satisfies every rule; replace the ones that do not.',
      ...EXAMPLE_PAIR_RULES,
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.3 };
}

// ---- Stage 3c': single-pair rewrite (audit repair) --------------------------
export function exampleRewritePrompt(card, deck, pair, issues, otherExamples) {
  const system =
    'You rewrite one example sentence pair of a Spanish to English flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Rewrite this example sentence pair.',
    deck: deckContext(deck),
    card: {
      spanish: card.spanish_text,
      english: card.english_text,
      part_of_speech: card.part_of_speech || undefined,
    },
    rejected_pair: { example_es: pair.es, example_en: pair.en },
    keep_these_other_examples: (otherExamples || []).map((other) => other.en),
    required_output: { example_es: 'string', example_en: 'string' },
    rules: [
      'Return ONE replacement pair fixing the listed issues.',
      'The new example_en must describe a different situation from every sentence in keep_these_other_examples.',
      ...EXAMPLE_PAIR_RULES,
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.4 };
}

// ---- Stage 3d: synonyms (synonyms_en) --------------------------------------
export function synonymsPrompt(card, issues) {
  const system =
    'You list English synonyms of the English answer of a Spanish to English flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Provide English synonyms of the English answer.',
    card: { spanish: card.spanish_text, english: card.english_text },
    required_output: { synonyms_en: ['string'] },
    rules: [
      'synonyms_en: 1 to 3 English words or short phrases that mean the same as the English answer (synonyms, NOT translations).',
      'Each item must be in English only (no Spanish, no inverted ¿ ¡ punctuation).',
      'Do not repeat the English answer itself as a synonym.',
      'No duplicates within the list. Keep each item short and natural.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.2 };
}

// ---- Stage 3e: cloze distractors (cloze_distractors_en) --------------------
export function clozeDistractorsPrompt(card, deck, issues) {
  const sentences = (Array.isArray(card.examples) && card.examples.length
    ? card.examples.map((pair) => pair.en)
    : [card.example_en])
    .map((en) => blankedExample(en ?? '', card.english_text))
    .filter(Boolean);
  const system =
    'You write wrong-answer options for a fill-in-the-blank English vocabulary exercise. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Write challenging but clearly wrong options for the blank in these sentences.',
    deck: deckContext(deck),
    exercise: {
      sentences_with_blank: sentences,
      correct_answer: card.english_text,
      part_of_speech: card.part_of_speech || undefined,
      answer_synonyms: Array.isArray(card.synonyms_en) ? card.synonyms_en : [],
    },
    required_output: { cloze_distractors_en: ['string'] },
    rules: [
      'Return exactly 5 candidate options.',
      "Each option must be English and match the correct answer's part of speech and surface form (same tense, number, and capitalization style), so it looks grammatically possible in the blank.",
      'Each option should be plausible for the deck topic, so the exercise is challenging — but placed in the blank of EVERY listed sentence it must produce a sentence that is clearly wrong, absurd, or contradicted by the rest of the sentence.',
      'The correct answer must be the ONLY option that truly fits any of the sentences. Never include the answer itself, its synonyms, its close paraphrases, or any word already present in the sentences.',
      'Keep each option roughly the same length and shape as the correct answer; options must be distinct from each other.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.4 };
}

// ---- Audit A: example quality (theme fit + blank inferability), ONE pair ----
export function exampleAuditPrompt(card, deck, pair) {
  const system =
    'You are a strict but fair quality auditor for Spanish to English flashcards. Judge one example sentence pair. Return JSON only.';
  const user = JSON.stringify({
    task: 'Audit one example sentence pair of this flashcard.',
    deck: deckContext(deck),
    card: {
      spanish: card.spanish_text,
      english: card.english_text,
      part_of_speech: card.part_of_speech || undefined,
    },
    pair: { example_es: pair.es, example_en: pair.en },
    sentence_with_blank: blankedExample(pair.en, card.english_text),
    required_output: { theme_fit: 'pass | fail', blank_inferable: 'pass | fail', issues: ['string'] },
    rules: [
      'theme_fit: fail ONLY when the example sentences clearly do not belong to the deck topic described in `deck`; otherwise pass. A neutral everyday sentence that could appear in this deck passes.',
      'blank_inferable: read sentence_with_blank (the English example with the answer replaced by ____). Pass only if the surrounding context strongly implies the missing answer, so a learner who knows the word could produce it. Fail generic frames like "I like ____." or "This is a ____." where many unrelated words fit equally well.',
      'blank_inferable: close synonyms of the answer also fitting is fine; fail only when the context gives little or no clue about the meaning of the missing word.',
      'Also fail (with an issue) if example_es and example_en do not mean the same thing.',
      'issues: for every fail, one short English instruction describing how to rewrite the pair (e.g. "add context that points to the missing word"). Empty array when everything passes.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0 };
}

// ---- Audit B: cloze solvability (only the answer may fit), ONE sentence -----
export function clozeSolvePrompt(sentenceWithBlank, options) {
  const system =
    'You are a careful English examiner solving a fill-in-the-blank vocabulary question. Return JSON only.';
  const user = JSON.stringify({
    task: 'Decide which of the offered options complete the sentence naturally.',
    exercise: {
      sentence_with_blank: sentenceWithBlank,
      options,
    },
    required_output: { fitting_options: ['string'] },
    rules: [
      'fitting_options: every option that produces a natural, meaningful, grammatical sentence when placed in the blank.',
      'Judge each option independently and only by the sentence context; do not guess which word the exercise designer wanted.',
      'If several options fit, list all of them. If none fit, return an empty array.',
      'Copy each fitting option VERBATIM from the provided options list.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0 };
}

// ---- Audit C: field quality (lexical, equivalents, synonyms), ONE card ------
export function fieldAuditPrompt(card, deck) {
  const system =
    'You are a strict but fair linguistic quality auditor for Spanish to English flashcards. Judge the accuracy and quality of vocabulary fields. Return JSON only.';
  const user = JSON.stringify({
    task: 'Audit the vocabulary fields of this Spanish to English flashcard.',
    deck: deckContext(deck),
    card: {
      spanish: card.spanish_text,
      english: card.english_text,
      part_of_speech: card.part_of_speech || undefined,
      definition_en: card.definition_en || undefined,
      main_translations_es: Array.isArray(card.main_translations_es) ? card.main_translations_es : [],
      collocations: Array.isArray(card.collocations) ? card.collocations : [],
      synonyms_en: Array.isArray(card.synonyms_en) ? card.synonyms_en : [],
    },
    required_output: {
      pair_correct: 'pass | fail',
      pair_issues: ['string'],
      mismatch_type: 'translation_mismatch | totally_incorrect',
      proposed_fixes: [
        {
          target: 'target_language | source_language | repair',
          spanish_text: 'string',
          english_text: 'string',
          reason: 'string',
        },
      ],
      lexical: 'pass | fail',
      lexical_issues: ['string'],
      equivalents: 'pass | fail',
      equivalents_issues: ['string'],
      synonyms: 'pass | fail',
      synonyms_issues: ['string'],
    },
    rules: [
      'pair_correct: pass if spanish (the prompt) and english (the answer) are valid translation counterparts of each other in the context of the deck. Fail if the pair is mistranslated, mismatched, or invalid.',
      'mismatch_type: when pair_correct fails, set to "translation_mismatch" if both terms are valid words on their own but do not translate to each other. Set to "totally_incorrect" if one or both terms are nonsense, corrupted, severe typos, or unusable.',
      'proposed_fixes: when pair_correct fails:',
      '  - If mismatch_type is "translation_mismatch", provide exactly 2 candidate fixes:',
      '    1. target="target_language": preserves the English answer (english_text: card.english) and provides its correct Spanish translation (spanish_text).',
      '    2. target="source_language": preserves the Spanish prompt (spanish_text: card.spanish) and provides its correct English translation (english_text).',
      '  - If mismatch_type is "totally_incorrect", provide exactly 1 candidate fix:',
      '    1. target="repair": provides a clean, corrected Spanish-English pair (spanish_text, english_text).',
      '  - Empty array when pair_correct passes.',
      'lexical: pass if part_of_speech accurately describes the English answer, AND definition_en is an accurate, concise English definition for THIS sense of the word in English only. Fail if definition is in Spanish, inaccurate for this sense, or part of speech is wrong.',
      'equivalents: pass if main_translations_es are natural Spanish translations of the prompt (in Spanish) consistent with spanish_text, AND collocations are natural, common English collocations of the English answer (in English).',
      'synonyms: pass if synonyms_en contains 1 to 3 true English synonyms for the English answer in THIS sense (synonyms in English, NOT Spanish translations or unrelated words).',
      'For each group that fails, provide short, actionable English instructions in the corresponding *_issues list describing what is wrong (e.g. "definition must be in English", "part_of_speech should be verb"). Empty array when that group passes.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0 };
}

