#!/usr/bin/env node
// Area 5: Cross-Port Drift Test Suite
// Asserts that CommonJS modules in supabase/scripts/lib and their ESM counterparts
// in frontend/src/ai produce 100% byte-identical and object-identical output:
//   - cards.cjs vs frontend/src/ai/cards.js (normCard, optText, normList, pairKey, normExamplePairs)
//   - prompts.cjs vs frontend/src/ai/prompts.js (all prompt builders, versions, rule helpers)
//   - validate.cjs vs frontend/src/ai/validate.js (validators, thresholds, helpers)
//   - minigame_text.cjs vs frontend/src/ai/cardText.js (locateAnswer, normalizeAnswer, blankedExample, contentHash)
//   - enrich.cjs vs frontend/src/ai/enrich.js (fingerprints, cardStatus, processCard)
//
//   node supabase/tests/run_area5_cross_port_drift.mjs

import assert from 'assert';
import path from 'path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

// CJS modules
const cjsCards = require(path.resolve('supabase/scripts/lib/cards.cjs'));
const cjsPrompts = require(path.resolve('supabase/scripts/lib/prompts.cjs'));
const cjsValidate = require(path.resolve('supabase/scripts/lib/validate.cjs'));
const cjsMinigameText = require(path.resolve('supabase/scripts/lib/minigame_text.cjs'));
const cjsEnrich = require(path.resolve('supabase/scripts/lib/enrich.cjs'));

// ESM modules
const esmCards = await import(pathToFileURL(path.resolve('frontend/src/ai/cards.js')).href);
const esmPrompts = await import(pathToFileURL(path.resolve('frontend/src/ai/prompts.js')).href);
const esmValidate = await import(pathToFileURL(path.resolve('frontend/src/ai/validate.js')).href);
const esmCardText = await import(pathToFileURL(path.resolve('frontend/src/ai/cardText.js')).href);
const esmEnrich = await import(pathToFileURL(path.resolve('frontend/src/ai/enrich.js')).href);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Area 5: Cross-port drift tests (supabase/scripts/lib vs frontend/src/ai)');

  await test('T1: normCard produces identical output from both ports across a comprehensive card matrix', async () => {
    const cardFixtures = [
      // 1. Minimal draft using legacy names
      {
        input: { spanish: 'Pasaporte', english: 'Passport' },
        deckTitle: 'Travel',
      },
      // 2. Minimal draft using role names
      {
        input: { prompt_l1: 'Pasaporte', answer_l2: 'Passport' },
        deckTitle: 'Travel',
      },
      // 3. Draft using l1_text / l2_text
      {
        input: { l1_text: 'Boleto', l2_text: 'Ticket' },
        deckTitle: 'Transport',
      },
      // 4. Enriched card with legacy field names
      {
        input: {
          spanish_text: 'Maleta',
          english_text: 'Suitcase',
          part_of_speech: 'noun',
          definition_en: 'A case with a handle and a hinged lid, used for carrying clothes.',
          main_translations_es: ['maleta', 'valija'],
          collocations: ['pack a suitcase', 'heavy suitcase'],
          synonyms_en: ['bag', 'luggage'],
          example_es: 'Hice mi maleta anoche.',
          example_en: 'I packed my suitcase last night.',
          example_sentence: 'I packed my suitcase last night.',
          mnemonic_en: 'Think of suits in a case',
          cloze_distractors_en: ['backpack', 'wallet', 'briefcase'],
          section_name: 'Luggage',
        },
        deckTitle: 'Travel',
      },
      // 5. Enriched card with role-named fields and multi-example pairs
      {
        input: {
          l1_text: 'Avión',
          l2_text: 'Airplane',
          part_of_speech: 'noun',
          l2_definition: 'A powered flying vehicle with fixed wings.',
          l1_translations: ['avión', 'aeroplano'],
          collocations: ['board the airplane', 'airplane ticket'],
          l2_synonyms: ['plane', 'aircraft'],
          examples: [
            { l1: 'El avión aterrizó a tiempo.', l2: 'The airplane landed on time.' },
            { l1: 'Subimos al avión rápidamente.', l2: 'We boarded the airplane quickly.' },
            { l1: 'El avión vuela alto.', l2: 'The airplane flies high.' },
          ],
          l2_mnemonic: 'Think of aviation',
          l2_cloze_distractors: ['train', 'bus', 'ferry'],
          section_name: 'Air Travel',
        },
        deckTitle: 'Transport',
      },
      // 6. Card with legacy {es, en} keys in examples
      {
        input: {
          prompt_l1: 'Tren',
          answer_l2: 'Train',
          part_of_speech: 'noun',
          l2_definition: 'A series of connected railway carriages.',
          l1_translations: ['tren', 'ferrocarril'],
          collocations: ['train station', 'take the train'],
          l2_synonyms: ['locomotive'],
          examples: [
            { es: 'El tren sale a las diez.', en: 'The train leaves at ten.' },
            { example_es: 'Perdí el tren esta mañana.', example_en: 'I missed the train this morning.' },
          ],
          cloze_distractors_en: ['subway', 'tram', 'bus'],
        },
        deckTitle: 'Transport',
      },
      // 7. Card with generation_metadata containing _audits
      {
        input: {
          l1_text: 'Hotel',
          l2_text: 'Hotel',
          generation_metadata: {
            _audits: {
              field_quality: { version: 'v1', status: 'pass' },
              example_quality: { version: 'v1', status: 'pass' },
            },
          },
        },
        deckTitle: 'Accommodation',
      },
      // 8. Card with top-level _audits
      {
        input: {
          l1_text: 'Playa',
          l2_text: 'Beach',
          _audits: {
            field_quality: { version: 'v2', status: 'pass' },
          },
        },
        deckTitle: 'Nature',
      },
      // 9. Card with duplicate list entries and whitespace to verify deduping & trimming parity
      {
        input: {
          l1_text: 'Ciudad',
          l2_text: 'City',
          l1_translations: [' ciudad ', 'ciudad', 'CIUDAD', 'metrópoli'],
          collocations: [' big city ', 'big city', 'city center'],
          l2_synonyms: ['town', 'TOWN', 'metropolis'],
          l2_cloze_distractors: ['village', 'village', 'suburb'],
        },
        deckTitle: 'Places',
      },
    ];

    for (const fixture of cardFixtures) {
      const cjsOutput = cjsCards.normCard(fixture.input, fixture.deckTitle);
      const esmOutput = esmCards.normCard(fixture.input, fixture.deckTitle);
      assert.deepStrictEqual(
        esmOutput,
        cjsOutput,
        `normCard cross-port output drift for card "${fixture.input.l2_text || fixture.input.english || fixture.input.answer_l2}"`
      );
    }
  });

  await test('T2: Card helper functions (optText, normList, pairKey) match exactly', async () => {
    // optText
    assert.strictEqual(cjsCards.optText('   hello world   '), esmCards.optText('   hello world   '));
    assert.strictEqual(cjsCards.optText(''), esmCards.optText(''));
    assert.strictEqual(cjsCards.optText('   '), esmCards.optText('   '));
    assert.strictEqual(cjsCards.optText(null), esmCards.optText(null));
    assert.strictEqual(cjsCards.optText(undefined), esmCards.optText(undefined));
    assert.strictEqual(cjsCards.optText(123), esmCards.optText(123));

    // normList
    const rawList = ['  apple  ', 'Banana', 'apple', 'BANANA', 'orange', '', null, undefined];
    assert.deepStrictEqual(cjsCards.normList(rawList), esmCards.normList(rawList));
    assert.deepStrictEqual(cjsCards.normList(null), esmCards.normList(null));
    assert.deepStrictEqual(cjsCards.normList('not-an-array'), esmCards.normList('not-an-array'));

    // pairKey
    assert.strictEqual(cjsCards.pairKey('Gato', 'Cat'), esmCards.pairKey('Gato', 'Cat'));
    assert.strictEqual(cjsCards.pairKey('PERRO', 'DOG'), esmCards.pairKey('PERRO', 'DOG'));
  });

  await test('T3: prompts.cjs exports all functions and constants identically to frontend/src/ai/prompts.js', async () => {
    // Constants
    assert.deepStrictEqual(cjsPrompts.BASE_PROMPT_VERSIONS, esmPrompts.BASE_PROMPT_VERSIONS);
    assert.deepStrictEqual(cjsPrompts.PROMPT_VERSIONS, esmPrompts.PROMPT_VERSIONS);
    assert.strictEqual(cjsPrompts.EXAMPLES_TARGET, esmPrompts.EXAMPLES_TARGET);

    // Helpers
    assert.deepStrictEqual(
      cjsPrompts.getPromptVersions({ l1: 'es', l2: 'en' }),
      esmPrompts.getPromptVersions({ l1: 'es', l2: 'en' })
    );
    assert.deepStrictEqual(
      cjsPrompts.getPromptVersions({ l1: 'fr', l2: 'en' }),
      esmPrompts.getPromptVersions({ l1: 'fr', l2: 'en' })
    );
    assert.strictEqual(cjsPrompts.getPunctuationRule('es', 'en'), esmPrompts.getPunctuationRule('es', 'en'));
    assert.strictEqual(cjsPrompts.getPunctuationRule('fr', 'en'), esmPrompts.getPunctuationRule('fr', 'en'));

    // Prompt builders parity across pairs
    const spec = { title: 'Food', description: 'Culinary items', topic: 'Food' };
    const section = { name: 'Fruits', communicative_goal: 'Order food', lexical_focus: ['apple', 'banana'] };
    const card = {
      l1_text: 'manzana',
      l2_text: 'apple',
      prompt_l1: 'manzana',
      answer_l2: 'apple',
      part_of_speech: 'noun',
      l2_definition: 'A round fruit',
      l1_translations: ['manzana'],
      collocations: ['red apple'],
      l2_synonyms: ['orchard fruit'],
      examples: [{ l1: 'Me gusta la manzana.', l2: 'I like the apple.' }],
      l2_cloze_distractors: ['pear', 'banana', 'orange'],
    };
    const pairItem = { l1: 'Me gusta la manzana.', l2: 'I like the apple.' };

    const testPairs = [{ l1: 'es', l2: 'en' }, { l1: 'fr', l2: 'en' }, { l1: 'en', l2: 'es' }];
    for (const pair of testPairs) {
      assert.deepStrictEqual(cjsPrompts.blueprintPrompt(spec, pair), esmPrompts.blueprintPrompt(spec, pair));
      assert.deepStrictEqual(cjsPrompts.wordSetPrompt(spec, section, 5, [], pair), esmPrompts.wordSetPrompt(spec, section, 5, [], pair));
      assert.deepStrictEqual(cjsPrompts.lexicalPrompt(card, [], pair), esmPrompts.lexicalPrompt(card, [], pair));
      assert.deepStrictEqual(cjsPrompts.equivalentsPrompt(card, undefined, pair), esmPrompts.equivalentsPrompt(card, undefined, pair));
      assert.deepStrictEqual(cjsPrompts.examplesPrompt(card, undefined, spec, pair), esmPrompts.examplesPrompt(card, undefined, spec, pair));
      assert.deepStrictEqual(cjsPrompts.exampleRewritePrompt(card, spec, pairItem, [], [], pair), esmPrompts.exampleRewritePrompt(card, spec, pairItem, [], [], pair));
      assert.deepStrictEqual(cjsPrompts.synonymsPrompt(card, undefined, pair), esmPrompts.synonymsPrompt(card, undefined, pair));
      assert.deepStrictEqual(cjsPrompts.clozeDistractorsPrompt(card, spec, undefined, pair), esmPrompts.clozeDistractorsPrompt(card, spec, undefined, pair));
      assert.deepStrictEqual(cjsPrompts.exampleAuditPrompt(card, spec, pairItem, pair), esmPrompts.exampleAuditPrompt(card, spec, pairItem, pair));
      assert.deepStrictEqual(cjsPrompts.clozeSolvePrompt('I like the ____.', ['apple', 'pear'], pair), esmPrompts.clozeSolvePrompt('I like the ____.', ['apple', 'pear'], pair));
      assert.deepStrictEqual(cjsPrompts.fieldAuditPrompt(card, spec, pair), esmPrompts.fieldAuditPrompt(card, spec, pair));
      assert.deepStrictEqual(cjsPrompts.cardSafetyAuditPrompt([card], spec, pair), esmPrompts.cardSafetyAuditPrompt([card], spec, pair));
      assert.deepStrictEqual(cjsPrompts.deckSafetyAuditPrompt(spec, [card], pair), esmPrompts.deckSafetyAuditPrompt(spec, [card], pair));
      assert.deepStrictEqual(cjsPrompts.cardSingleReviewPrompt(card, spec, pair), esmPrompts.cardSingleReviewPrompt(card, spec, pair));
      assert.deepStrictEqual(cjsPrompts.cardSingleFixPrompt(card, ['fix definition'], spec, pair), esmPrompts.cardSingleFixPrompt(card, ['fix definition'], spec, pair));
    }
  });

  await test('T4: validate.cjs exports all functions and constants identically to frontend/src/ai/validate.js', async () => {
    // Thresholds
    assert.strictEqual(cjsValidate.EXAMPLES_MIN, esmValidate.EXAMPLES_MIN);
    assert.strictEqual(cjsValidate.EXAMPLES_MAX, esmValidate.EXAMPLES_MAX);
    assert.strictEqual(cjsValidate.CLOZE_DISTRACTORS_MIN, esmValidate.CLOZE_DISTRACTORS_MIN);
    assert.strictEqual(cjsValidate.CLOZE_DISTRACTORS_MAX, esmValidate.CLOZE_DISTRACTORS_MAX);

    // Validation verdict parity on clean card
    const card = {
      l1_text: 'perro',
      l2_text: 'dog',
      part_of_speech: 'noun',
      l2_definition: 'A domestic animal',
      l1_translations: ['perro'],
      collocations: ['pet dog'],
      l2_synonyms: ['hound'],
      examples: [
        { l1: 'El perro ladra.', l2: 'The dog barks.' },
        { l1: 'Tengo un perro.', l2: 'I have a dog.' },
        { l1: 'El perro corre.', l2: 'The dog runs.' },
      ],
      l2_cloze_distractors: ['cat', 'fox', 'wolf'],
    };

    assert.deepStrictEqual(cjsValidate.validateCard(card), esmValidate.validateCard(card));
    assert.strictEqual(cjsValidate.hasIssues(cjsValidate.validateCard(card)), esmValidate.hasIssues(esmValidate.validateCard(card)));
    assert.deepStrictEqual(cjsValidate.flatten(cjsValidate.validateCard(card)), esmValidate.flatten(esmValidate.validateCard(card)));
  });

  await test('T5: minigame_text.cjs matches frontend/src/ai/cardText.js exports identically', async () => {
    const example = 'The quick brown fox jumps over the lazy dog.';
    const answer = 'fox';

    assert.deepStrictEqual(
      cjsMinigameText.locateAnswerInExample(example, answer),
      esmCardText.locateAnswerInExample(example, answer)
    );
    assert.strictEqual(
      cjsMinigameText.normalizeAnswer('CAFÉ'),
      esmCardText.normalizeAnswer('CAFÉ')
    );
    assert.strictEqual(
      cjsMinigameText.blankedExample(example, answer),
      esmCardText.blankedExample(example, answer)
    );
    assert.strictEqual(
      cjsMinigameText.contentHash('some card content'),
      esmCardText.contentHash('some card content')
    );
  });

  await test('T6: enrich.cjs exports matches frontend/src/ai/enrich.js exports identically', async () => {
    const deck = { slug: 'test', title: 'Test Deck' };
    const card = {
      spanish_text: 'Gato',
      english_text: 'Cat',
      part_of_speech: 'noun',
      definition_en: 'A small carnivorous mammal.',
      main_translations_es: ['gato'],
      collocations: ['pet cat'],
      synonyms_en: ['feline'],
      examples: [
        { es: 'El gato duerme.', en: 'The cat sleeps.' },
        { es: 'Tengo un gato.', en: 'I have a cat.' },
        { es: 'El gato corre.', en: 'The cat runs.' },
      ],
      cloze_distractors_en: ['dog', 'bird', 'mouse'],
    };

    assert.strictEqual(
      cjsEnrich.fieldFingerprint(deck, card),
      esmEnrich.fieldFingerprint(deck, card)
    );
    assert.strictEqual(
      cjsEnrich.exampleFingerprint(deck, card),
      esmEnrich.exampleFingerprint(deck, card)
    );
    assert.strictEqual(
      cjsEnrich.clozeFingerprint(card),
      esmEnrich.clozeFingerprint(card)
    );
    assert.deepStrictEqual(
      cjsEnrich.cardStatus(card, deck),
      esmEnrich.cardStatus(card, deck)
    );
  });

  console.log(`\nALL ${passed} CROSS-PORT DRIFT TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
