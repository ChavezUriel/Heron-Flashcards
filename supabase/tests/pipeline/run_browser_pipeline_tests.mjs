#!/usr/bin/env node
// Offline tests for the browser ESM enrichment/audit pipeline (frontend/src/ai/enrich.js + friends).
// Guarantees zero behavioral drift between browser ESM bundle and supabase/scripts/lib/enrich.cjs.
//
//   node supabase/tests/pipeline/run_browser_pipeline_tests.mjs

import assert from 'assert';
import { createRequire } from 'node:module';
import {
  processCard,
  cardStatus,
  fieldFingerprint as esmFieldFingerprint,
  exampleFingerprint as esmExampleFingerprint,
  clozeFingerprint as esmClozeFingerprint,
} from '../../../frontend/src/ai/enrich.js';
import { validateCard, flatten, hasIssues, hasWarnings, flattenWarnings } from '../../../frontend/src/ai/validate.js';
import * as esmValidate from '../../../frontend/src/ai/validate.js';
import { locateAnswerInExample } from '../../../frontend/src/ai/cardText.js';
import * as esmCardText from '../../../frontend/src/ai/cardText.js';
import * as esmMinigameText from '../../../frontend/src/minigameText.js';
import { getLanguage, getPair, isGameSupportedForLanguage } from '../../../frontend/src/languages.js';
import * as esmPrompts from '../../../frontend/src/ai/prompts.js';
import { validateModelTier } from '../../../frontend/src/ai/providers.js';

const require = createRequire(import.meta.url);
const cjsEnrich = require('../../scripts/lib/enrich.cjs');
const cjsPrompts = require('../../scripts/lib/prompts.cjs');
const cjsValidate = require('../../scripts/lib/validate.cjs');
const cjsMinigameText = require('../../scripts/lib/minigame_text.cjs');
const { normCard } = require('../../scripts/lib/cards.cjs');

const DECK = { slug: 'travel', title: 'Travel Phrases', description: 'Short phrases for transport, directions, and common travel moments.' };

// Identify which prompt builder produced a request by its user-JSON `task`.
function kindOf(p) {
  const task = JSON.parse(p.user).task;
  if (task.startsWith('Provide part_of_speech')) return 'lexical';
  if (task.startsWith('Provide Spanish translations')) return 'equivalents';
  if (task.startsWith('Write Spanish example sentences')) return 'examples';
  if (task.startsWith('Rewrite this example sentence pair')) return 'rewrite';
  if (task.startsWith('Provide English synonyms')) return 'synonyms';
  if (task.startsWith('Write challenging but clearly wrong options')) return 'distractors';
  if (task.startsWith('Audit the vocabulary fields')) return 'fieldAudit';
  if (task.startsWith('Audit one example sentence pair')) return 'exampleAudit';
  if (task.startsWith('Decide which of the offered options')) return 'clozeSolve';
  throw new Error('unknown prompt task: ' + task);
}

// Scripted model: `script` maps kind -> array of responses (or a function of
// the parsed user doc), consumed in call order; the last entry repeats.
function makeStub(script, calls) {
  return async (p) => {
    const kind = kindOf(p);
    calls.push(kind);
    const entries = script[kind];
    if (!entries) throw new Error(`stub has no script for ${kind}`);
    const i = Math.min(calls.filter((c) => c === kind).length - 1, entries.length - 1);
    const entry = entries[i];
    return typeof entry === 'function' ? entry(JSON.parse(p.user)) : entry;
  };
}

const PAIRS = [
  { example_es: 'Necesito renovar mi pasaporte antes de viajar a Londres.', example_en: 'I need to renew my passport before traveling to London.' },
  { example_es: 'El agente selló mi pasaporte en el control.', example_en: 'The border agent stamped my passport at the checkpoint.' },
  { example_es: 'Revisaron cada pasaporte antes de subir al ferry.', example_en: 'Officials checked every passport before we got on the ferry.' },
];
const PASS_AUDIT = { theme_fit: 'pass', blank_inferable: 'pass', issues: [] };
const PASS_FIELD_AUDIT = {
  pair_correct: 'pass',
  lexical: 'pass',
  equivalents: 'pass',
  synonyms: 'pass',
};
const solveOnly = (words) => (u) => ({ fitting_options: u.exercise.options.filter((o) => words.includes(o)) });

const BASE_SCRIPT = {
  lexical: [{ part_of_speech: 'noun', definition_en: 'An official travel document.' }],
  equivalents: [{ main_translations_es: ['documento de viaje'], collocations: ['passport control', 'passport photo'] }],
  examples: [{ examples: PAIRS }],
  rewrite: [],
  synonyms: [{ synonyms_en: ['travel document'] }],
  // 5 candidates; the applier must drop the answer restatement.
  distractors: [{ cloze_distractors_en: ['visa', 'ticket', 'suitcase', 'boarding pass', 'Passport'] }],
  fieldAudit: [PASS_FIELD_AUDIT],
  exampleAudit: [PASS_AUDIT],
  clozeSolve: [solveOnly(['Passport'])],
};

const DRAFT = { spanish_text: 'Pasaporte', english_text: 'Passport' };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('pipeline stub tests');

  await test('T1 fresh draft: 3 pairs generated, per-pair audits + per-sentence solves pass', async () => {
    const calls = [];
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    assert.deepStrictEqual(flatten(issues), [], 'final card must be clean: ' + flatten(issues));
    assert.strictEqual(card.examples.length, 3);
    assert.strictEqual(card.example_en, PAIRS[0].example_en, 'legacy mirror = pair 0');
    assert.strictEqual(card.example_sentence, PAIRS[0].example_en);
    assert.deepStrictEqual(card.cloze_distractors_en, ['visa', 'ticket', 'suitcase', 'boarding pass']);
    assert.ok(card._audits.field_quality?.status === 'pass');
    assert.ok(card._audits.example_quality?.status === 'pass');
    assert.ok(card._audits.cloze_options?.status === 'pass');
    assert.strictEqual(calls.filter((c) => c === 'fieldAudit').length, 1, 'one field audit');
    assert.strictEqual(calls.filter((c) => c === 'examples').length, 1);
    assert.strictEqual(calls.filter((c) => c === 'exampleAudit').length, 3, 'one audit per pair');
    assert.strictEqual(calls.filter((c) => c === 'clozeSolve').length, 3, 'one solve per sentence');
    assert.strictEqual(calls.filter((c) => c === 'distractors').length, 1);
  });

  await test('T2 audit rejects ONE pair -> only that pair rewritten, siblings kept', async () => {
    const calls = [];
    const fixedPair = { example_es: 'Mostré mi pasaporte azul en la aduana.', example_en: 'I showed my blue passport at customs.' };
    const script = {
      ...BASE_SCRIPT,
      examples: [{ examples: [{ example_es: 'Me gusta mi pasaporte.', example_en: 'I like my passport.' }, PAIRS[1], PAIRS[2]] }],
      rewrite: [fixedPair],
      // Sweep 1: pair 0 fails, 1-2 pass. Sweep 2 (after rewrite): all pass.
      exampleAudit: [
        { theme_fit: 'pass', blank_inferable: 'fail', issues: ['add context that points to the missing word'] },
        PASS_AUDIT, PASS_AUDIT, PASS_AUDIT, PASS_AUDIT, PASS_AUDIT,
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.strictEqual(calls.filter((c) => c === 'examples').length, 1, 'full set generated once');
    assert.strictEqual(calls.filter((c) => c === 'rewrite').length, 1, 'exactly one pair rewritten');
    assert.strictEqual(card.examples[0].l2, fixedPair.example_en, 'rejected pair replaced');
    assert.strictEqual(card.example_en, fixedPair.example_en, 'legacy mirror follows pair 0');
    assert.strictEqual(card.examples[1].l2, PAIRS[1].example_en, 'good pairs untouched');
    assert.ok(card._audits.example_quality?.status === 'pass');
  });

  await test('T3 solve flags an option in ONE sentence -> pruned, survivors accepted without regen', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      clozeSolve: [(u) => ({
        fitting_options: u.exercise.options.filter((o) =>
          o === 'Passport' || (o === 'visa' && u.exercise.sentence_with_blank.includes('border agent'))),
      })],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.deepStrictEqual(card.cloze_distractors_en, ['ticket', 'suitcase', 'boarding pass'], 'union offender pruned');
    assert.strictEqual(calls.filter((c) => c === 'distractors').length, 1, 'no regeneration needed');
    assert.ok(card._audits.cloze_options?.status === 'pass');
  });

  await test('T4 too many options fit -> full distractor regeneration with feedback', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      distractors: [
        { cloze_distractors_en: ['visa', 'ID card', 'permit', 'licence', 'certificate'] },
        { cloze_distractors_en: ['suitcase', 'pillow', 'sandwich', 'umbrella'] },
      ],
      clozeSolve: [
        solveOnly(['Passport', 'visa', 'ID card', 'permit']),
        solveOnly(['Passport', 'visa', 'ID card', 'permit']),
        solveOnly(['Passport', 'visa', 'ID card', 'permit']),
        solveOnly(['Passport']),
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.deepStrictEqual(card.cloze_distractors_en, ['suitcase', 'pillow', 'sandwich', 'umbrella']);
    assert.strictEqual(calls.filter((c) => c === 'distractors').length, 2, 'regenerated once');
    assert.ok(card._audits.cloze_options?.status === 'pass');
  });

  await test('T5 examiner rejects the answer in one sentence -> that pair rewritten', async () => {
    const calls = [];
    const fixedPair = { example_es: 'Enseñé mi pasaporte al embarcar.', example_en: 'I showed my passport when boarding the plane.' };
    const script = {
      ...BASE_SCRIPT,
      rewrite: [fixedPair],
      clozeSolve: [
        solveOnly(['Passport']),
        solveOnly(['Passport']),
        solveOnly([]),          // sentence 3: answer not accepted
        solveOnly(['Passport']),
        solveOnly(['Passport']),
        solveOnly(['Passport']),
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.strictEqual(calls.filter((c) => c === 'rewrite').length, 1);
    assert.strictEqual(card.examples[2].l2, fixedPair.example_en, 'offending sentence replaced');
  });

  await test('T6 finished card: re-run makes zero LLM calls (fingerprint skip)', async () => {
    const calls = [];
    const { card } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    const { issues } = await processCard(card, {
      deck: DECK,
      runPrompt: async () => { throw new Error('must not be called'); },
    });
    assert.deepStrictEqual(flatten(issues), []);
  });

  await test('T7 content edits re-flag audits; blankability stays deterministic', async () => {
    const calls = [];
    const { card } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    const edited = {
      ...card,
      examples: [{ l1: card.examples[0].l1, l2: 'I must renew my passport before my trip to Paris.' }, ...card.examples.slice(1)],
    };
    edited.example_l2 = edited.examples[0].l2;
    edited.example_en = edited.examples[0].l2;
    edited.example_sentence = edited.examples[0].l2;
    assert.ok(cardStatus(edited, DECK).audits.length >= 1, 'edited sentence must re-flag audits');
    const broken = { ...card, examples: [{ l1: 'x', l2: 'She renewed her passports yesterday.' }, ...card.examples.slice(1)] };
    assert.ok(validateCard(broken).examples.some((m) => m.includes('verbatim')), 'inflected answer must flag');
  });

  await test('T8 legacy single-example card seeds the pair set and reaches 3 pairs', async () => {
    const legacy = normCard({
      spanish: 'Pasaporte', english: 'Passport', part_of_speech: 'noun',
      definition_en: 'An official travel document.',
      main_translations_es: ['documento'], collocations: ['passport control', 'passport photo'],
      synonyms_en: ['travel document'],
      example_es: PAIRS[0].example_es, example_en: PAIRS[0].example_en, example_sentence: PAIRS[0].example_en,
    }, 'Travel Phrases');
    assert.strictEqual(legacy.examples.length, 1, 'legacy pair seeds examples');
    assert.ok(validateCard(legacy).examples.some((m) => m.includes('3 to 4')), 'needs more pairs');
    const calls = [];
    let sawExisting = null;
    const stub = makeStub(BASE_SCRIPT, calls);
    const spy = async (p) => {
      if (kindOf(p) === 'examples') sawExisting = JSON.parse(p.user).existing_examples;
      return stub(p);
    };
    const { card, issues } = await processCard(legacy, { deck: DECK, runPrompt: spy });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.strictEqual(card.examples.length, 3);
    assert.deepStrictEqual(sawExisting, [{ example_l1: PAIRS[0].example_es, example_l2: PAIRS[0].example_en }],
      'prompt saw the legacy pair as keepable');
  });

  await test('T9 validator: distractor shape rules across all sentences', async () => {
    const base = {
      ...DRAFT, part_of_speech: 'noun', definition_en: 'd',
      main_translations_es: ['x'], collocations: ['a', 'b'], synonyms_en: ['travel document'],
      examples: PAIRS.map((p) => ({ es: p.example_es, en: p.example_en })),
      example_es: PAIRS[0].example_es, example_en: PAIRS[0].example_en, example_sentence: PAIRS[0].example_en,
    };
    assert.deepStrictEqual(validateCard({ ...base, cloze_distractors_en: ['visa', 'ticket', 'suitcase'] }).clozeDistractors, []);
    assert.ok(validateCard({ ...base, cloze_distractors_en: [] }).clozeDistractors.length, 'empty set flags');
    assert.ok(validateCard({ ...base, cloze_distractors_en: ['visa', 'ticket', 'travel document'] }).clozeDistractors
      .some((m) => m.includes('restate')), 'synonym restatement flags');
    assert.ok(validateCard({ ...base, cloze_distractors_en: ['visa', 'ticket', 'ferry'] }).clozeDistractors
      .some((m) => m.includes('already present')), 'word from ANY sentence flags');
    assert.ok(validateCard({ ...base, examples: base.examples.slice(0, 2) }).examples
      .some((m) => m.includes('3 to 4')), 'fewer than 3 pairs flags');
  });

  await test('T10 cloze span mirror matches multi-word + diacritic cases', async () => {
    assert.ok(locateAnswerInExample('Excuse me, where is the station, please?', 'Where is the station?'));
    assert.ok(locateAnswerInExample('Se dice: ¿dónde está la estación?', 'Dónde esta la estacion'));
    assert.strictEqual(locateAnswerInExample('I gave up quickly.', 'give up'), null);
  });

  await test('T11 protect option ignores non-empty definitions and groups', async () => {
    const calls = [];
    const customDef = 'A unique user-written definition.';
    const draftWithDef = {
      ...DRAFT,
      part_of_speech: 'noun',
      definition_en: customDef,
    };
    const { card, issues } = await processCard(draftWithDef, {
      deck: DECK,
      protect: new Set(['lexical']),
      runPrompt: makeStub(BASE_SCRIPT, calls),
    });
    assert.strictEqual(card.definition_en, customDef, 'custom definition must not be overwritten');
    assert.strictEqual(calls.filter((c) => c === 'lexical').length, 0, 'lexical prompt not called');
  });

  await test('T12 fieldAudit failure routes repair to lexical group and sets reason', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      fieldAudit: [
        {
          pair_correct: 'pass',
          lexical: { verdict: 'fail', issues: ['definition is too vague — explain it is a formal travel permit'] },
          equivalents: 'pass',
          synonyms: 'pass',
        },
        PASS_FIELD_AUDIT,
      ],
      lexical: [
        { part_of_speech: 'noun', definition_en: 'An official document issued by a government.' },
        { part_of_speech: 'noun', definition_en: 'An official government travel document certifying identity.' },
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), []);
    assert.strictEqual(calls.filter((c) => c === 'fieldAudit').length, 2, 're-audited after repair');
    assert.strictEqual(calls.filter((c) => c === 'lexical').length, 2, 'lexical called initially and after audit rejection');
    assert.strictEqual(card.definition_en, 'An official government travel document certifying identity.');
    assert.ok(card._audits.field_quality?.status === 'pass');
  });

  await test('T13 fieldAudit pass recorded in _audits and skipped on second run', async () => {
    const calls = [];
    const { card } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    assert.ok(card._audits.field_quality?.status === 'pass');
    const secondCalls = [];
    const { issues } = await processCard(card, {
      deck: DECK,
      runPrompt: makeStub(BASE_SCRIPT, secondCalls),
    });
    assert.deepStrictEqual(flatten(issues), []);
    assert.strictEqual(secondCalls.length, 0, 'zero LLM calls on fresh card');
  });

  await test('T14 pair_correct failure without proposed_fixes sets card._pair_correct without changing texts', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      fieldAudit: [
        {
          pair_correct: 'fail',
          pair_issues: ['Pasaporte means passport, not ticket.'],
          lexical: 'pass',
          equivalents: 'pass',
          synonyms: 'pass',
        },
      ],
    };
    const draft = { spanish_text: 'Pasaporte', english_text: 'Ticket' };
    const { card } = await processCard(draft, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.strictEqual(card._pair_correct, false);
    assert.deepStrictEqual(card._pair_issues, ['Pasaporte means passport, not ticket.']);
    assert.strictEqual(card.spanish_text, 'Pasaporte', 'spanish text untouched');
    assert.strictEqual(card.english_text, 'Ticket', 'english text untouched');
  });

  await test('T15 translation_mismatch proposes 2 fixes, defaults to target language term update', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      fieldAudit: [
        {
          pair_correct: 'fail',
          pair_issues: ['Pasaporte (passport) does not match Ticket (boleto).'],
          mismatch_type: 'translation_mismatch',
          proposed_fixes: [
            {
              target: 'target_language',
              spanish_text: 'Boleto',
              english_text: 'Ticket',
              reason: 'Match English answer (Ticket)',
            },
            {
              target: 'source_language',
              spanish_text: 'Pasaporte',
              english_text: 'Passport',
              reason: 'Match Spanish prompt (Pasaporte)',
            },
          ],
          lexical: 'pass',
          equivalents: 'pass',
          synonyms: 'pass',
        },
      ],
    };
    const draft = { spanish_text: 'Pasaporte', english_text: 'Ticket' };
    const { card } = await processCard(draft, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.strictEqual(card._pair_correct, false);
    assert.ok(card._pair_mismatch, 'must create _pair_mismatch object');
    assert.strictEqual(card._pair_mismatch.type, 'translation_mismatch');
    assert.strictEqual(card._pair_mismatch.fixes.length, 2);

    const fix0 = card._pair_mismatch.fixes[0];
    const fix1 = card._pair_mismatch.fixes[1];
    assert.strictEqual(fix0.target, 'target_language');
    assert.strictEqual(fix0._selected, true, 'target language fix must be selected by default');
    assert.strictEqual(fix0.spanish_text, 'Boleto');
    assert.strictEqual(fix0.english_text, 'Ticket');

    assert.strictEqual(fix1.target, 'source_language');
    assert.strictEqual(fix1._selected, false, 'source language fix must not be selected by default');
    assert.strictEqual(fix1.spanish_text, 'Pasaporte');
    assert.strictEqual(fix1.english_text, 'Passport');

    // Card should be updated by the default primary fix (target language)
    assert.strictEqual(card.spanish_text, 'Boleto', 'card prompt updated to target term counterpart');
    assert.strictEqual(card.english_text, 'Ticket', 'card answer preserved');
  });

  await test('T16 totally_incorrect proposes 1 repair fix and updates card by default', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      fieldAudit: [
        {
          pair_correct: 'fail',
          pair_issues: ['Garbled text in prompt and wrong answer.'],
          mismatch_type: 'totally_incorrect',
          proposed_fixes: [
            {
              target: 'repair',
              spanish_text: 'Maleta',
              english_text: 'Suitcase',
              reason: 'Replaced garbled pair with valid travel term',
            },
          ],
          lexical: 'pass',
          equivalents: 'pass',
          synonyms: 'pass',
        },
      ],
    };
    const draft = { spanish_text: 'asdf123', english_text: 'wrong123' };
    const { card } = await processCard(draft, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.strictEqual(card._pair_correct, false);
    assert.ok(card._pair_mismatch);
    assert.strictEqual(card._pair_mismatch.type, 'totally_incorrect');
    assert.strictEqual(card._pair_mismatch.fixes.length, 1);
    assert.strictEqual(card._pair_mismatch.fixes[0]._selected, true);
    assert.strictEqual(card.spanish_text, 'Maleta');
    assert.strictEqual(card.english_text, 'Suitcase');
  });

  await test('T17 cross-port parity: ESM and CJS compute identical fingerprints across fixtures', async () => {
    const testCards = [
      {
        spanish_text: 'Pasaporte',
        english_text: 'Passport',
        part_of_speech: 'noun',
        definition_en: 'An official travel document.',
        main_translations_es: ['documento de viaje', 'pasaporte'],
        collocations: ['passport control', 'passport photo'],
        synonyms_en: ['travel document', 'ID'],
        examples: PAIRS,
        cloze_distractors_en: ['visa', 'ticket', 'suitcase', 'boarding pass'],
      },
      {
        spanish_text: 'Boleto',
        english_text: 'Ticket',
        part_of_speech: 'noun',
        definition_en: 'A certificate or token showing that a fare or admission fee has been paid.',
        main_translations_es: ['billete', 'entrada'],
        collocations: ['plane ticket', 'ticket counter'],
        synonyms_en: ['pass', 'voucher'],
        examples: [
          { es: 'Compré un boleto para el tren.', en: 'I bought a ticket for the train.' },
          { es: 'Muestre su boleto al conductor.', en: 'Show your ticket to the conductor.' },
          { es: 'El boleto cuesta diez euros.', en: 'The ticket costs ten euros.' },
        ],
        cloze_distractors_en: ['receipt', 'passport', 'boarding pass'],
      },
    ];

    for (const testCard of testCards) {
      const esmField = esmFieldFingerprint(DECK, testCard);
      const cjsField = cjsEnrich.fieldFingerprint(DECK, testCard);
      assert.strictEqual(esmField, cjsField, `fieldFingerprint mismatch for ${testCard.english_text}: ESM=${esmField}, CJS=${cjsField}`);

      const esmExample = esmExampleFingerprint(DECK, testCard);
      const cjsExample = cjsEnrich.exampleFingerprint(DECK, testCard);
      assert.strictEqual(esmExample, cjsExample, `exampleFingerprint mismatch for ${testCard.english_text}: ESM=${esmExample}, CJS=${cjsExample}`);

      const esmCloze = esmClozeFingerprint(testCard);
      const cjsCloze = cjsEnrich.clozeFingerprint(testCard);
      assert.strictEqual(esmCloze, cjsCloze, `clozeFingerprint mismatch for ${testCard.english_text}: ESM=${esmCloze}, CJS=${cjsCloze}`);
    }
  });

  await test('T18 cross-port parity: cardStatus returns identical issues and audits on same input', async () => {
    const cardWithAudits = {
      spanish_text: 'Pasaporte',
      english_text: 'Passport',
      part_of_speech: 'noun',
      definition_en: 'An official travel document.',
      main_translations_es: ['documento de viaje'],
      collocations: ['passport control'],
      synonyms_en: ['travel document'],
      examples: PAIRS,
      cloze_distractors_en: ['visa', 'ticket', 'suitcase'],
    };

    const esmStatus1 = cardStatus(cardWithAudits, DECK, { auditFields: true, auditExamples: true, auditCloze: true, wantCloze: true });
    const cjsStatus1 = cjsEnrich.cardStatus(cardWithAudits, DECK, { auditFields: true, auditExamples: true, auditCloze: true, wantCloze: true });
    assert.deepStrictEqual(esmStatus1, cjsStatus1, 'cardStatus (unaudited) must match across ESM and CJS');

    const cardPassedAudits = {
      ...cardWithAudits,
      _audits: {
        field_quality: { version: 'audit-fields-v2', fingerprint: esmFieldFingerprint(DECK, cardWithAudits), status: 'pass' },
        example_quality: { version: 'audit-examples-v1', fingerprint: esmExampleFingerprint(DECK, cardWithAudits), status: 'pass' },
        cloze_options: { version: 'audit-cloze-v1', fingerprint: esmClozeFingerprint(cardWithAudits), status: 'pass' },
      },
    };

    const esmStatus2 = cardStatus(cardPassedAudits, DECK, { auditFields: true, auditExamples: true, auditCloze: true, wantCloze: true });
    const cjsStatus2 = cjsEnrich.cardStatus(cardPassedAudits, DECK, { auditFields: true, auditExamples: true, auditCloze: true, wantCloze: true });
    assert.deepStrictEqual(esmStatus2, cjsStatus2, 'cardStatus (audited) must match across ESM and CJS');
    assert.strictEqual(esmStatus2.audits.length, 0);
  });

  await test('T19 cross-port parity: processCard produces identical resulting cards on same scripted prompts', async () => {
    const callsESM = [];
    const callsCJS = [];
    const esmResult = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, callsESM) });
    const cjsResult = await cjsEnrich.processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, callsCJS) });

    assert.deepStrictEqual(callsESM, callsCJS, 'calls sequence must match across ESM and CJS');
    assert.deepStrictEqual(esmResult.issues, cjsResult.issues, 'issues must match across ESM and CJS');

    const stripAuditTimestamp = (c) => {
      const copy = JSON.parse(JSON.stringify(c));
      if (copy._audits) {
        for (const k of Object.keys(copy._audits)) {
          delete copy._audits[k].checked_at;
        }
      }
      return copy;
    };

    assert.deepStrictEqual(stripAuditTimestamp(esmResult.card), stripAuditTimestamp(cjsResult.card), 'resulting card must match across ESM and CJS');
  });

  await test('T20 browser/CLI prompt divergence check and pair-aware rules', async () => {
    // 1. Verify prompt versions consistency
    assert.deepStrictEqual(esmPrompts.PROMPT_VERSIONS, cjsPrompts.PROMPT_VERSIONS);
    assert.deepStrictEqual(esmPrompts.BASE_PROMPT_VERSIONS, cjsPrompts.BASE_PROMPT_VERSIONS);

    const esVersions = esmPrompts.getPromptVersions({ l1: 'es', l2: 'en' });
    const cjsEsVersions = cjsPrompts.getPromptVersions({ l1: 'es', l2: 'en' });
    assert.deepStrictEqual(esVersions, cjsEsVersions);
    assert.strictEqual(esVersions.examples, 'enrich-examples-v3', 'es->en preserves base prompt versions');

    const frVersions = esmPrompts.getPromptVersions({ l1: 'fr', l2: 'en' });
    const cjsFrVersions = cjsPrompts.getPromptVersions({ l1: 'fr', l2: 'en' });
    assert.deepStrictEqual(frVersions, cjsFrVersions);
    assert.strictEqual(frVersions.examples, 'enrich-examples-v3:fr->en', 'fr->en encodes pair tag in version');

    // 2. Cross-port divergence check across all prompt builders for multiple pairs
    const pairsToTest = [
      { l1: 'es', l2: 'en' },
      { l1: 'fr', l2: 'en' },
      { l1: 'en', l2: 'es' },
    ];

    const testSpec = { title: 'Gastronomy', description: 'Culinary traditions and recipes.', topic: 'Food' };
    const testSection = { name: 'Cooking', communicative_goal: 'Order food', lexical_focus: ['knife', 'pan'] };
    const testCard = {
      l1_text: 'la pomme',
      l2_text: 'the apple',
      prompt_l1: 'la pomme',
      answer_l2: 'the apple',
      spanish_text: 'la manzana',
      english_text: 'the apple',
      part_of_speech: 'noun',
      definition_en: 'A round fruit with red or green skin.',
      l2_definition: 'A round fruit with red or green skin.',
      main_translations_es: ['manzana'],
      l1_translations: ['la pomme'],
      collocations: ['apple tree'],
      synonyms_en: ['orchard fruit'],
      l2_synonyms: ['orchard fruit'],
      examples: [{ l1: 'J’aime la pomme.', l2: 'I like the apple.' }],
      cloze_distractors_en: ['pear', 'banana', 'orange'],
      l2_cloze_distractors: ['pear', 'banana', 'orange'],
    };
    const pairItem = { l1: 'J’aime la pomme.', l2: 'I like the apple.' };

    for (const pair of pairsToTest) {
      // blueprintPrompt
      assert.deepStrictEqual(
        esmPrompts.blueprintPrompt(testSpec, pair),
        cjsPrompts.blueprintPrompt(testSpec, pair),
        `blueprintPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // wordSetPrompt
      assert.deepStrictEqual(
        esmPrompts.wordSetPrompt(testSpec, testSection, 5, [], pair),
        cjsPrompts.wordSetPrompt(testSpec, testSection, 5, [], pair),
        `wordSetPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // lexicalPrompt
      assert.deepStrictEqual(
        esmPrompts.lexicalPrompt(testCard, ['fix definition'], pair),
        cjsPrompts.lexicalPrompt(testCard, ['fix definition'], pair),
        `lexicalPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // equivalentsPrompt
      assert.deepStrictEqual(
        esmPrompts.equivalentsPrompt(testCard, undefined, pair),
        cjsPrompts.equivalentsPrompt(testCard, undefined, pair),
        `equivalentsPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // examplesPrompt
      assert.deepStrictEqual(
        esmPrompts.examplesPrompt(testCard, undefined, testSpec, pair),
        cjsPrompts.examplesPrompt(testCard, undefined, testSpec, pair),
        `examplesPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // exampleRewritePrompt
      assert.deepStrictEqual(
        esmPrompts.exampleRewritePrompt(testCard, testSpec, pairItem, ['improve context'], [], pair),
        cjsPrompts.exampleRewritePrompt(testCard, testSpec, pairItem, ['improve context'], [], pair),
        `exampleRewritePrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // synonymsPrompt
      assert.deepStrictEqual(
        esmPrompts.synonymsPrompt(testCard, undefined, pair),
        cjsPrompts.synonymsPrompt(testCard, undefined, pair),
        `synonymsPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // clozeDistractorsPrompt
      assert.deepStrictEqual(
        esmPrompts.clozeDistractorsPrompt(testCard, testSpec, undefined, pair),
        cjsPrompts.clozeDistractorsPrompt(testCard, testSpec, undefined, pair),
        `clozeDistractorsPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // exampleAuditPrompt
      assert.deepStrictEqual(
        esmPrompts.exampleAuditPrompt(testCard, testSpec, pairItem, pair),
        cjsPrompts.exampleAuditPrompt(testCard, testSpec, pairItem, pair),
        `exampleAuditPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // clozeSolvePrompt
      assert.deepStrictEqual(
        esmPrompts.clozeSolvePrompt('I like the ____.', ['the apple', 'pear', 'banana'], pair),
        cjsPrompts.clozeSolvePrompt('I like the ____.', ['the apple', 'pear', 'banana'], pair),
        `clozeSolvePrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // fieldAuditPrompt
      assert.deepStrictEqual(
        esmPrompts.fieldAuditPrompt(testCard, testSpec, pair),
        cjsPrompts.fieldAuditPrompt(testCard, testSpec, pair),
        `fieldAuditPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // cardSafetyAuditPrompt
      assert.deepStrictEqual(
        esmPrompts.cardSafetyAuditPrompt([testCard], testSpec, pair),
        cjsPrompts.cardSafetyAuditPrompt([testCard], testSpec, pair),
        `cardSafetyAuditPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // deckSafetyAuditPrompt
      assert.deepStrictEqual(
        esmPrompts.deckSafetyAuditPrompt(testSpec, [testCard], pair),
        cjsPrompts.deckSafetyAuditPrompt(testSpec, [testCard], pair),
        `deckSafetyAuditPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // cardSingleReviewPrompt
      assert.deepStrictEqual(
        esmPrompts.cardSingleReviewPrompt(testCard, testSpec, pair),
        cjsPrompts.cardSingleReviewPrompt(testCard, testSpec, pair),
        `cardSingleReviewPrompt divergence for ${pair.l1}->${pair.l2}`
      );

      // cardSingleFixPrompt
      assert.deepStrictEqual(
        esmPrompts.cardSingleFixPrompt(testCard, ['bad definition'], testSpec, pair),
        cjsPrompts.cardSingleFixPrompt(testCard, ['bad definition'], testSpec, pair),
        `cardSingleFixPrompt divergence for ${pair.l1}->${pair.l2}`
      );
    }

    // 3. Verify French prompt-side rules specifically
    const frBp = esmPrompts.blueprintPrompt(testSpec, { l1: 'fr', l2: 'en' });
    assert.ok(frBp.system.includes('French to English'), 'French system prompt');
    assert.ok(frBp.system.includes('French-speaking learners of English'), 'French learner profile');

    const frEx = esmPrompts.examplesPrompt(testCard, undefined, testSpec, { l1: 'fr', l2: 'en' });
    const frRules = JSON.parse(frEx.user).rules;
    assert.ok(frRules.some((r) => r.includes('example_l2 must be in English; example_l1 is in French.')), 'French punctuation rule');
    assert.ok(!frRules.some((r) => r.includes('no inverted ¿ ¡ punctuation')), 'No inverted punctuation rule for French prompt');

    const esEx = esmPrompts.examplesPrompt(testCard, undefined, testSpec, { l1: 'es', l2: 'en' });
    const esRules = JSON.parse(esEx.user).rules;
    assert.ok(esRules.some((r) => r.includes('no inverted ¿ ¡ punctuation')), 'Inverted punctuation rule for Spanish prompt');

    // 4. Model tier validation
    assert.throws(
      () => validateModelTier('gemini-2.5-flash-lite', { l1: 'es', l2: 'en', minModelTier: 'tier1' }),
      /does not meet minimum model tier/
    );
    assert.doesNotThrow(
      () => validateModelTier('gemini-2.5-flash', { l1: 'es', l2: 'en', minModelTier: 'tier1' })
    );
  });

  await test('T21 language-aware validation: cross-port parity, script ranges, n-gram detection, and clozeStrategy warning', async () => {
    // 1. Cross-port parity between ESM and CJS validate modules
    assert.strictEqual(typeof esmValidate.validateCard, 'function');
    assert.strictEqual(typeof cjsValidate.validateCard, 'function');
    assert.strictEqual(esmValidate.EXAMPLES_MIN, cjsValidate.EXAMPLES_MIN);
    assert.strictEqual(esmValidate.EXAMPLES_MAX, cjsValidate.EXAMPLES_MAX);
    assert.strictEqual(esmValidate.CLOZE_DISTRACTORS_MIN, cjsValidate.CLOZE_DISTRACTORS_MIN);
    assert.strictEqual(esmValidate.CLOZE_DISTRACTORS_MAX, cjsValidate.CLOZE_DISTRACTORS_MAX);

    const cleanCard = {
      l1_text: 'Pasaporte',
      l2_text: 'Passport',
      part_of_speech: 'noun',
      l2_definition: 'An official travel document issued by a government.',
      l1_translations: ['pasaporte'],
      collocations: ['passport control', 'valid passport'],
      examples: [
        { l1: 'Necesito mi pasaporte.', l2: 'I need my passport for travel.' },
        { l1: 'Muestre su pasaporte.', l2: 'Show your passport to the officer.' },
        { l1: 'Renové mi pasaporte.', l2: 'I renewed my passport yesterday.' },
      ],
      example_l1: 'Necesito mi pasaporte.',
      example_l2: 'I need my passport for travel.',
      example_sentence: 'I need my passport for travel.',
      l2_synonyms: ['travel document'],
      l2_cloze_distractors: ['visa', 'ticket', 'boarding pass'],
    };

    const esmVerdicts = esmValidate.validateCard(cleanCard);
    const cjsVerdicts = cjsValidate.validateCard(cleanCard);
    assert.deepStrictEqual(esmVerdicts, cjsVerdicts, 'clean card validation must match across ESM and CJS');
    assert.strictEqual(esmValidate.hasIssues(esmVerdicts), false, 'clean card has no issues');

    // 2. es->en: Inverted punctuation marks (¿ / ¡) in English fields must flag
    const cardWithSpanishPunct = {
      ...cleanCard,
      l2_definition: '¿An official document?',
      collocations: ['¡passport photo!'],
      examples: [
        { l1: 'x', l2: '¿I need my passport?' },
        cleanCard.examples[1],
        cleanCard.examples[2],
      ],
      example_l1: 'x',
      example_l2: '¿I need my passport?',
      example_sentence: '¿I need my passport?',
      l2_synonyms: ['¡travel document!'],
      l2_cloze_distractors: ['¿visa?', 'ticket', 'boarding pass'],
    };
    const esIssues = esmValidate.validateCard(cardWithSpanishPunct, { l1: 'es', l2: 'en' });
    assert.ok(esIssues.lexical.some((m) => m === 'l2_definition must be English (no ¿ or ¡)'));
    assert.ok(esIssues.equivalents.some((m) => m === 'collocations must be English phrases (no ¿ or ¡)'));
    assert.ok(esIssues.examples.some((m) => m === 'examples[0].l2 must be English (no ¿ or ¡)'));
    assert.ok(esIssues.synonyms.some((m) => m === 'l2_synonyms must be English (no ¿ or ¡)'));
    assert.ok(esIssues.clozeDistractors.some((m) => m === 'l2_cloze_distractors must be English (no ¿ or ¡)'));

    // 3. en->es: Spanish target fields with inverted punctuation must NOT flag false positives
    const cleanSpanishCard = {
      l1_text: 'Passport',
      l2_text: 'Pasaporte',
      part_of_speech: 'noun',
      l2_definition: '¿Qué es? Un documento oficial emitido por el gobierno.',
      l1_translations: ['passport'],
      collocations: ['control de pasaportes', 'pasaporte válido'],
      examples: [
        { l1: 'Where is your passport?', l2: '¿Dónde está su pasaporte?' },
        { l1: 'Show your passport.', l2: '¡Muestre su pasaporte ahora mismo!' },
        { l1: 'I have a passport.', l2: 'Tengo un pasaporte para viajar.' },
      ],
      example_l1: 'Where is your passport?',
      example_l2: '¿Dónde está su pasaporte?',
      example_sentence: '¿Dónde está su pasaporte?',
      l2_synonyms: ['documento de viaje'],
      l2_cloze_distractors: ['boleto', 'visado', 'tarjeta'],
    };
    const enEsIssues = esmValidate.validateCard(cleanSpanishCard, { l1: 'en', l2: 'es' });
    assert.strictEqual(enEsIssues.lexical.length, 0, 'en->es must not flag ¿ in Spanish definition');
    assert.strictEqual(enEsIssues.examples.length, 0, 'en->es must not flag ¿ or ¡ in Spanish examples');
    assert.strictEqual(esmValidate.hasIssues(enEsIssues), false, 'clean en->es card has no issues');

    // 4. en->es: English text in Spanish target fields must be caught by n-gram / language heuristic
    const englishInSpanishCard = {
      ...cleanSpanishCard,
      l2_definition: 'An official document issued by the government for travel.',
      examples: [
        { l1: 'x', l2: 'I bought a ticket for the train yesterday.' },
        cleanSpanishCard.examples[1],
        cleanSpanishCard.examples[2],
      ],
    };
    const enEsCaught = esmValidate.validateCard(englishInSpanishCard, { l1: 'en', l2: 'es' });
    assert.ok(enEsCaught.lexical.some((m) => m === 'l2_definition must be Spanish'));
    assert.ok(enEsCaught.examples.some((m) => m === 'examples[0].l2 must be Spanish'));

    // 5. fr->en: French text in English target fields must be caught
    const frenchInEnglishCard = {
      ...cleanCard,
      l2_definition: 'Un document officiel émis par le gouvernement pour voyager.',
      examples: [
        { l1: 'x', l2: 'J\'ai acheté un billet pour le train hier matin.' },
        cleanCard.examples[1],
        cleanCard.examples[2],
      ],
    };
    const frEnCaught = esmValidate.validateCard(frenchInEnglishCard, { l1: 'fr', l2: 'en' });
    assert.ok(frEnCaught.lexical.some((m) => m === 'l2_definition must be English'));
    assert.ok(frEnCaught.examples.some((m) => m === 'examples[0].l2 must be English'));

    // 6. Script range check: Cyrillic characters in Latin target fields must flag
    const cyrillicCard = {
      ...cleanCard,
      l2_definition: 'Official document паспорт issued by government.',
    };
    const cyrillicIssues = esmValidate.validateCard(cyrillicCard, { l1: 'ru', l2: 'en' });
    assert.ok(cyrillicIssues.lexical.some((m) => m.includes('must be English')));

    // 7. Cloze strategy: when pair.clozeStrategy is 'lemma' (non-verbatim) or card.cloze_ineligible,
    // inflected answers report as warnings rather than hard failures in examples
    const nonVerbatimCard = {
      ...cleanCard,
      examples: [
        { l1: 'x', l2: 'She renewed her passports yesterday.' },
        cleanCard.examples[1],
        cleanCard.examples[2],
      ],
      example_l1: 'x',
      example_l2: 'She renewed her passports yesterday.',
      example_sentence: 'She renewed her passports yesterday.',
    };
    // In verbatim pair (default es->en), inflected answer is a hard failure in examples
    const verbatimIssues = esmValidate.validateCard(nonVerbatimCard, { l1: 'es', l2: 'en', clozeStrategy: 'verbatim' });
    assert.ok(verbatimIssues.examples.some((m) => m.includes('verbatim')), 'verbatim failure flags in examples');
    assert.strictEqual(esmValidate.hasIssues(verbatimIssues), true);

    // In non-verbatim pair (e.g. clozeStrategy: 'lemma'), it reports as a warning
    const lemmaIssues = esmValidate.validateCard(nonVerbatimCard, { l1: 'de', l2: 'en', clozeStrategy: 'lemma' });
    assert.strictEqual(lemmaIssues.examples.length, 0, 'non-verbatim strategy does not fail examples');
    assert.ok(lemmaIssues.warnings.length > 0, 'reports warning for cloze ineligibility');
    assert.ok(lemmaIssues.warnings.some((w) => w.includes('cloze-ineligible')));
    assert.strictEqual(esmValidate.hasIssues(lemmaIssues), false, 'warnings do not count as hard issues');
    assert.deepStrictEqual(esmValidate.flatten(lemmaIssues), [], 'flatten ignores warnings');
    assert.strictEqual(esmValidate.hasWarnings(lemmaIssues), true, 'hasWarnings detects warnings');

    // If marked cloze_ineligible explicitly on verbatim pair
    const markedIneligible = { ...nonVerbatimCard, cloze_ineligible: true };
    const ineligibleIssues = esmValidate.validateCard(markedIneligible, { l1: 'es', l2: 'en' });
    assert.strictEqual(ineligibleIssues.examples.length, 0, 'marked cloze_ineligible does not fail examples');
    assert.ok(ineligibleIssues.warnings.length > 0, 'marked cloze_ineligible produces warning');
  });

  await test('T22 grading engine parameterization: Tier 1 regression, diacritics, function words, cloze seams, and games filtering', async () => {
    // 1. Tier 1 regression contract: English baseline inputs produce byte-identical verdicts
    const baselineClassify = [
      { guess: 'receive', card: { answer_l2: 'receive', l2_synonyms: ['get', 'accept'] }, expected: 'correct' },
      { guess: 'Receive', card: { answer_l2: 'receive', l2_synonyms: ['get', 'accept'] }, expected: 'correct' },
      { guess: 'rèceive', card: { answer_l2: 'receive', l2_synonyms: ['get', 'accept'] }, expected: 'correct' },
      { guess: '  receive  ', card: { answer_l2: 'receive', l2_synonyms: ['get', 'accept'] }, expected: 'correct' },
      { guess: 'listen   to', card: { answer_l2: 'listen to', l2_synonyms: [] }, expected: 'correct' },
      { guess: 'hold-up', card: { answer_l2: 'hold‑up', l2_synonyms: [] }, expected: 'correct' },
      { guess: "don't", card: { answer_l2: "don’t", l2_synonyms: [] }, expected: 'correct' },
      { guess: 'get', card: { answer_l2: 'receive', l2_synonyms: ['get', 'accept'] }, expected: 'correct' },
      // Typo budget
      { guess: 'cot', card: { answer_l2: 'cat' }, expected: 'wrong' },
      { guess: 'cat', card: { answer_l2: 'cat' }, expected: 'correct' },
      { guess: 'recieve', card: { answer_l2: 'receive' }, expected: 'almost' },
      { guess: 'recxxve', card: { answer_l2: 'receive' }, expected: 'wrong' },
      { guess: 'defenitely', card: { answer_l2: 'definitely' }, expected: 'almost' },
      { guess: 'defenetely', card: { answer_l2: 'definitely' }, expected: 'almost' },
      { guess: 'defenatily', card: { answer_l2: 'definitely' }, expected: 'wrong' },
      // Function words
      { guess: 'listen', card: { answer_l2: 'listen to' }, expected: 'almost' },
      { guess: 'give up', card: { answer_l2: 'to give up' }, expected: 'almost' },
      { guess: 'cat', card: { answer_l2: 'a cat' }, expected: 'almost' },
      { guess: 'apple', card: { answer_l2: 'an apple' }, expected: 'almost' },
      { guess: 'dog', card: { answer_l2: 'the dog' }, expected: 'almost' },
      { guess: 'turn', card: { answer_l2: 'turn off' }, expected: 'almost' },
      { guess: 'listen to', card: { answer_l2: 'listen' }, expected: 'almost' },
      { guess: 'to run', card: { answer_l2: 'run' }, expected: 'almost' },
      { guess: 'listen carefully', card: { answer_l2: 'listen' }, expected: 'wrong' },
      { guess: 'big dog', card: { answer_l2: 'dog' }, expected: 'wrong' },
      { guess: 'elephant', card: { answer_l2: 'cat' }, expected: 'wrong' },
      { guess: '', card: { answer_l2: 'cat' }, expected: 'wrong' },
    ];

    for (const item of baselineClassify) {
      assert.strictEqual(
        esmMinigameText.classifyGuess(item.guess, item.card),
        item.expected,
        `classifyGuess baseline for "${item.guess}" against "${item.card.answer_l2}"`
      );
    }

    // 2. Baseline locateAnswerInExample results
    const baselineLocate = [
      { example: 'The cat sat on the mat.', answer: 'cat', expected: { start: 4, end: 7 } },
      { example: 'Cats are great.', answer: 'cats', expected: { start: 0, end: 4 } },
      { example: 'Hello, cat!', answer: 'cat', expected: { start: 7, end: 10 } },
      { example: 'Please listen to me.', answer: 'listen to', expected: { start: 7, end: 16 } },
      { example: 'Never give up on your dreams.', answer: 'give up', expected: { start: 6, end: 13 } },
      { example: 'The caterpillar crawled.', answer: 'cat', expected: null },
      { example: 'Listen carefully.', answer: 'listen to', expected: null },
      { example: 'I listened to music.', answer: 'listen to', expected: null },
      { example: 'He gives it up.', answer: 'give up', expected: null },
      { example: 'Ich rufe dich an.', answer: 'anrufen', expected: null },
      { example: '', answer: 'cat', expected: null },
      { example: null, answer: 'cat', expected: null },
    ];

    for (const item of baselineLocate) {
      assert.deepStrictEqual(
        esmMinigameText.locateAnswerInExample(item.example, item.answer),
        item.expected,
        `locateAnswerInExample baseline for "${item.answer}" in "${item.example}"`
      );
    }

    // 3. Tier 1 diacritics stripping: en, es, fr strip unconditionally
    assert.strictEqual(esmMinigameText.normalizeAnswer('café', 'en'), 'cafe');
    assert.strictEqual(esmMinigameText.normalizeAnswer('café', 'es'), 'cafe');
    assert.strictEqual(esmMinigameText.normalizeAnswer('café', 'fr'), 'cafe');
    assert.strictEqual(esmMinigameText.normalizeAnswer('niño', 'es'), 'nino');

    // 4. Phonemic diacritics preserved for languages where diacriticsSignificant: true (pl, tr)
    assert.strictEqual(esmMinigameText.normalizeAnswer('Łódź', 'pl'), 'łódź');
    assert.strictEqual(esmMinigameText.normalizeAnswer('Ağaç', 'tr'), 'ağaç');
    assert.notStrictEqual(
      esmMinigameText.normalizeAnswer('má', { diacriticsSignificant: true }),
      esmMinigameText.normalizeAnswer('ma', { diacriticsSignificant: true })
    );
    assert.strictEqual(
      esmMinigameText.classifyGuess('ma', { answer_l2: 'má', language_to: 'pl' }),
      'wrong',
      'diacritics matter when diacriticsSignificant is true'
    );

    // 5. Per-language function words (Spanish and French)
    assert.strictEqual(
      esmMinigameText.classifyGuess('perro', { answer_l2: 'el perro', language_to: 'es' }),
      'almost',
      'Spanish article "el" recognized as function word'
    );
    assert.strictEqual(
      esmMinigameText.classifyGuess('el perro', { answer_l2: 'perro', language_to: 'es' }),
      'almost',
      'Spanish added article "el" recognized as near-miss'
    );
    assert.strictEqual(
      esmMinigameText.classifyGuess('maison', { answer_l2: 'la maison', language_to: 'fr' }),
      'almost',
      'French article "la" recognized as function word'
    );
    assert.strictEqual(
      esmMinigameText.classifyGuess('la maison', { answer_l2: 'maison', language_to: 'fr' }),
      'almost',
      'French added article "la" recognized as near-miss'
    );

    // 6. Typo budget parameterization
    const enBudget = getLanguage('en').typoBudget;
    assert.strictEqual(enBudget(3), 0);
    assert.strictEqual(enBudget(5), 1);
    assert.strictEqual(enBudget(9), 2);

    const jaBudget = getLanguage('ja').typoBudget;
    assert.strictEqual(jaBudget(10), 0, 'Japanese has zero typo budget');

    // 7. Cloze strategy hook and seams
    assert.strictEqual(typeof esmMinigameText.CLOZE_STRATEGIES.verbatim, 'function');
    assert.strictEqual(typeof esmMinigameText.CLOZE_STRATEGIES.lemma, 'function');
    assert.strictEqual(typeof esmMinigameText.CLOZE_STRATEGIES.segmenter, 'function');

    // Verbatim strategy locates word
    assert.deepStrictEqual(
      esmMinigameText.locateAnswerInExample('A fast cat runs.', 'cat', 'verbatim'),
      { start: 7, end: 10 }
    );
    // Lemma seam returns null (clearly stubbed for Tier 2)
    assert.strictEqual(
      esmMinigameText.locateAnswerInExample('A fast cat runs.', 'cat', 'lemma'),
      null,
      'lemma strategy seam returns null'
    );
    // Segmenter seam returns null (clearly stubbed for Tier 3b)
    assert.strictEqual(
      esmMinigameText.locateAnswerInExample('A fast cat runs.', 'cat', 'segmenter'),
      null,
      'segmenter strategy seam returns null'
    );

    // Default strategy resolution for Tier 1
    assert.strictEqual(esmMinigameText.resolveClozeStrategy(), 'verbatim');
    assert.strictEqual(esmMinigameText.resolveClozeStrategy({ l1: 'es', l2: 'en' }), 'verbatim');
    assert.strictEqual(esmMinigameText.resolveClozeStrategy({ l1: 'en', l2: 'es' }), 'verbatim');
    assert.strictEqual(esmMinigameText.resolveClozeStrategy({ strategy: 'lemma' }), 'lemma');
    assert.strictEqual(esmMinigameText.resolveClozeStrategy({ strategy: 'segmenter' }), 'segmenter');

    // 8. MinigameHost per-language games set filtering
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'en'), true);
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'es'), true);
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'fr'), true);
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'ja'), false, 'scramble withheld for Japanese');
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'zh'), false, 'hangman withheld for Chinese');
    assert.strictEqual(isGameSupportedForLanguage('type_translation', 'ja'), true);

    // 9. Cross-port parity: CJS re-export matches ESM exports exactly
    const testCases = [
      ['Excuse me, where is the station, please?', 'Where is the station?'],
      ['Se dice: ¿dónde está la estación?', 'Dónde esta la estacion'],
      ['I gave up quickly.', 'give up'],
      ['The quick brown fox jumps.', 'fox'],
    ];

    for (const [ex, ans] of testCases) {
      assert.deepStrictEqual(
        esmCardText.locateAnswerInExample(ex, ans),
        cjsMinigameText.locateAnswerInExample(ex, ans),
        `ESM and CJS locateAnswerInExample parity for "${ans}"`
      );
      assert.strictEqual(
        esmCardText.normalizeAnswer(ans),
        cjsMinigameText.normalizeAnswer(ans),
        `ESM and CJS normalizeAnswer parity for "${ans}"`
      );
      assert.strictEqual(
        esmCardText.blankedExample(ex, ans),
        cjsMinigameText.blankedExample(ex, ans),
        `ESM and CJS blankedExample parity for "${ans}"`
      );
    }
    assert.strictEqual(
      esmCardText.contentHash('test content'),
      cjsMinigameText.contentHash('test content'),
      'ESM and CJS contentHash parity'
    );
  });

  console.log(`\nALL ${passed} BROWSER ESM PIPELINE STUB TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
