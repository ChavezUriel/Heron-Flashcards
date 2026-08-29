// Single-Card AI Review & Fix Engine
//
// Allows users to review a single flashcard from the metadata modal using their
// configured API key & model without needing to manually select a model each time.
//
// Step 1: reviewSingleCard() audits the card for issues (accuracy, definitions,
//         grammar, examples, false friends, missing fields).
// Step 2: generateCardFixes() produces high quality corrected card fields when
//         the user wants to resolve the identified issues.
// Step 3: diffSingleCard() computes before-and-after diffs for approval.

import { loadCredentials, loadBuilderPrefs } from './keyStore.js';
import { createLlmClient, LlmError } from './llmClient.js';
import { cardSingleReviewPrompt, cardSingleFixPrompt } from './prompts.js';
import { optText, normList, normExamplePairs } from './cards.js';

// Retrieve the currently active AI credential (provider, apiKey, model).
// Defaults to the last used provider preference or whichever provider has a key.
export function getEffectiveAiCredential() {
  const prefs = loadBuilderPrefs();
  const credentials = loadCredentials();

  // Try preferred provider first
  const preferred = credentials[prefs.providerId];
  if (preferred && preferred.apiKey && preferred.apiKey.trim()) {
    return preferred;
  }

  // Fall back to any provider that has an API key configured
  for (const providerId of Object.keys(credentials)) {
    const cred = credentials[providerId];
    if (cred && cred.apiKey && cred.apiKey.trim()) {
      return cred;
    }
  }

  return null;
}

// Normalize card input into clean review format
export function normalizeCardForReview(card) {
  const prompt_es = optText(card.prompt_es ?? card.spanish_text ?? card.spanish) ?? '';
  const answer_en = optText(card.answer_en ?? card.english_text ?? card.english) ?? '';
  const examples = normExamplePairs(card.examples, card.example_es, card.example_en || card.example_sentence);

  return {
    prompt_es,
    answer_en,
    section_name: optText(card.section_name),
    part_of_speech: optText(card.part_of_speech),
    definition_en: optText(card.definition_en),
    main_translations_es: normList(card.main_translations_es),
    collocations: normList(card.collocations),
    synonyms_en: normList(card.synonyms_en),
    examples,
    example_es: examples[0]?.es ?? optText(card.example_es),
    example_en: examples[0]?.en ?? optText(card.example_en ?? card.example_sentence),
    example_sentence: examples[0]?.en ?? optText(card.example_sentence ?? card.example_en),
    mnemonic_en: optText(card.mnemonic_en),
  };
}

// Review a single card using the configured AI provider & model
export async function reviewSingleCard(card, options = {}) {
  const { runPrompt, deck, signal } = options;
  const norm = normalizeCardForReview(card);

  let runner = runPrompt;
  if (!runner) {
    const credential = getEffectiveAiCredential();
    if (!credential) {
      throw new LlmError('No AI provider API key configured. Please add an API key in AI settings.');
    }
    const client = createLlmClient(credential);
    runner = (promptObj) => client.chatJson(promptObj, { signal });
  }

  const promptObj = cardSingleReviewPrompt(norm, deck);
  const rawResponse = await runner(promptObj);

  const rawIssues = Array.isArray(rawResponse?.issues) ? rawResponse.issues : [];
  const normalizedIssues = rawIssues
    .map((issue) => {
      if (typeof issue === 'string') {
        return {
          field: 'general',
          severity: 'medium',
          message: issue.trim(),
          suggestion: '',
        };
      }
      return {
        field: String(issue?.field || 'general').trim(),
        severity: ['low', 'medium', 'high', 'critical'].includes(String(issue?.severity || '').toLowerCase())
          ? String(issue.severity).toLowerCase()
          : 'medium',
        message: String(issue?.message || issue?.issue || '').trim(),
        suggestion: String(issue?.suggestion || issue?.remediation || '').trim(),
      };
    })
    .filter((issue) => issue.message || issue.suggestion);

  const hasIssues = Boolean(
    rawResponse?.has_issues === true ||
    rawResponse?.overall_status === 'needs_fix' ||
    normalizedIssues.length > 0
  );

  const summary = String(
    rawResponse?.summary ||
    (hasIssues ? `Found ${normalizedIssues.length} issue(s) needing attention.` : 'Card meets high quality and accuracy standards.')
  ).trim();

  return {
    has_issues: hasIssues,
    overall_status: hasIssues ? 'needs_fix' : 'pass',
    summary,
    issues: normalizedIssues,
    checked_at: new Date().toISOString(),
  };
}

// Generate proposed fixes for a card based on identified issues
export async function generateCardFixes(card, reviewResult, options = {}) {
  const { runPrompt, deck, signal } = options;
  const norm = normalizeCardForReview(card);

  let runner = runPrompt;
  if (!runner) {
    const credential = getEffectiveAiCredential();
    if (!credential) {
      throw new LlmError('No AI provider API key configured. Please add an API key in AI settings.');
    }
    const client = createLlmClient(credential);
    runner = (promptObj) => client.chatJson(promptObj, { signal });
  }

  const issues = reviewResult?.issues || [];
  const promptObj = cardSingleFixPrompt(norm, issues, deck);
  const rawResponse = await runner(promptObj);

  const prompt_es = optText(rawResponse?.prompt_es) || norm.prompt_es;
  const answer_en = optText(rawResponse?.answer_en) || norm.answer_en;
  const section_name = optText(rawResponse?.section_name) ?? norm.section_name;
  const part_of_speech = optText(rawResponse?.part_of_speech) ?? norm.part_of_speech;
  const definition_en = optText(rawResponse?.definition_en) ?? norm.definition_en;
  const main_translations_es = normList(rawResponse?.main_translations_es ?? norm.main_translations_es).slice(0, 3);
  const collocations = normList(rawResponse?.collocations ?? norm.collocations).slice(0, 4);
  const synonyms_en = normList(rawResponse?.synonyms_en ?? norm.synonyms_en).slice(0, 3);

  let examples = normExamplePairs(rawResponse?.examples, null, null);
  if (examples.length === 0) {
    examples = norm.examples;
  }

  const firstExample = examples[0] ?? null;

  return {
    prompt_es,
    answer_en,
    section_name,
    part_of_speech,
    definition_en,
    main_translations_es,
    collocations,
    synonyms_en,
    examples,
    example_sentence: firstExample ? firstExample.en : norm.example_sentence,
    example_es: firstExample ? firstExample.es : norm.example_es,
    example_en: firstExample ? firstExample.en : norm.example_en,
    mnemonic_en: norm.mnemonic_en,
    explanation: String(rawResponse?.explanation || 'Applied suggested corrections.').trim(),
  };
}

// Compute diff between original card and fixed card for review modal
export function diffSingleCard(originalCard, fixedCard) {
  const orig = normalizeCardForReview(originalCard);
  const fixed = normalizeCardForReview(fixedCard);

  const formatList = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr.join(', ') : '');
  const formatExamples = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    return arr.map((p, idx) => `${idx + 1}. [ES] ${p.es} — [EN] ${p.en}`).join('\n');
  };

  const fields = [
    { key: 'prompt_es', label: 'Spanish prompt', from: orig.prompt_es, to: fixed.prompt_es },
    { key: 'answer_en', label: 'English answer', from: orig.answer_en, to: fixed.answer_en },
    { key: 'section_name', label: 'Section', from: orig.section_name || '', to: fixed.section_name || '' },
    { key: 'part_of_speech', label: 'Part of speech', from: orig.part_of_speech || '', to: fixed.part_of_speech || '' },
    { key: 'definition_en', label: 'English definition', from: orig.definition_en || '', to: fixed.definition_en || '' },
    { key: 'main_translations_es', label: 'Spanish translations', from: formatList(orig.main_translations_es), to: formatList(fixed.main_translations_es) },
    { key: 'collocations', label: 'Collocations', from: formatList(orig.collocations), to: formatList(fixed.collocations) },
    { key: 'synonyms_en', label: 'Synonyms (EN)', from: formatList(orig.synonyms_en), to: formatList(fixed.synonyms_en) },
    { key: 'examples', label: 'Example sentences', from: formatExamples(orig.examples), to: formatExamples(fixed.examples), isMultiline: true },
  ];

  return fields.map((f) => ({
    ...f,
    isChanged: f.from.trim() !== f.to.trim(),
  }));
}
