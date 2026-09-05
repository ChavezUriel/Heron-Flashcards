#!/usr/bin/env node
// Area 4: Regression Contract Freezes (Grading Engine & Prompt Pipeline)
// Locks the two regression contracts proven by hand during the migration:
//   1. Grading engine: golden values for normalizeAnswer, classifyGuess (27 cases),
//      and locateAnswerInExample (12 cases). Diacritic preservation for Polish/Turkish.
//      Exclusion of scramble and hangman for non-alphabetic languages (Japanese).
//   2. Prompt pipeline: byte-level snapshots of all 15 generated Spanish-to-English
//      prompts, plus targeted assertions ensuring no doubled parentheses in rule text.
//
//   node supabase/tests/run_area4_regression_contracts.mjs

import assert from 'assert';
import path from 'path';
import { pathToFileURL } from 'url';

const minigameTextModulePath = pathToFileURL(path.resolve('frontend/src/minigameText.js')).href;
const promptsModulePath = pathToFileURL(path.resolve('frontend/src/ai/prompts.js')).href;
const languagesModulePath = pathToFileURL(path.resolve('frontend/src/languages.js')).href;

const { classifyGuess, locateAnswerInExample, normalizeAnswer } = await import(minigameTextModulePath);
const prompts = await import(promptsModulePath);
const { isGameSupportedForLanguage, supportedPairs } = await import(languagesModulePath);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Area 4: Regression contract tests (grading engine & prompt pipeline)');

  // -------------------------------------------------------------------------
  // Part 1: Grading Engine Regression Contract
  // -------------------------------------------------------------------------

  await test('T1: classifyGuess matches golden regression baseline across all 27 cases', async () => {
    const baseline = [
      // Exact matches and normalization
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

      // Function-word variants and near misses
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

    for (const item of baseline) {
      const actual = classifyGuess(item.guess, item.card);
      assert.strictEqual(
        actual,
        item.expected,
        `classifyGuess drifted for guess="${item.guess}" against "${item.card.answer_l2}": expected "${item.expected}", got "${actual}"`
      );
    }
  });

  await test('T2: locateAnswerInExample matches golden baseline across all 12 cases', async () => {
    const baseline = [
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

    for (const item of baseline) {
      const actual = locateAnswerInExample(item.example, item.answer);
      assert.deepStrictEqual(
        actual,
        item.expected,
        `locateAnswerInExample drifted for "${item.answer}" in "${item.example}"`
      );
    }
  });

  await test('T3: Diacritic-significant languages preserve marks where English and Spanish strip them', async () => {
    // English and Spanish strip diacritics
    assert.strictEqual(normalizeAnswer('café', 'en'), 'cafe');
    assert.strictEqual(normalizeAnswer('café', 'es'), 'cafe');
    assert.strictEqual(normalizeAnswer('niño', 'es'), 'nino');
    assert.strictEqual(normalizeAnswer('rôle', 'en'), 'role');

    // Polish and Turkish preserve marks
    assert.strictEqual(normalizeAnswer('Łódź', 'pl'), 'łódź');
    assert.strictEqual(normalizeAnswer('Ağaç', 'tr'), 'ağaç');
    assert.strictEqual(normalizeAnswer('Şiir', 'tr'), 'şiir');
    assert.strictEqual(normalizeAnswer('Zażółć', 'pl'), 'zażółć');

    // Phonemic contrast in Polish: missing diacritic is graded as wrong
    assert.strictEqual(
      classifyGuess('lodz', { answer_l2: 'Łódź', language_to: 'pl' }),
      'wrong',
      'diacritics matter in Polish'
    );
    assert.strictEqual(
      classifyGuess('agac', { answer_l2: 'Ağaç', language_to: 'tr' }),
      'wrong',
      'diacritics matter in Turkish'
    );
  });

  await test('T4: Japanese excludes letter games (scramble and hangman) while English includes them', async () => {
    // English includes all minigames
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'en'), true);
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'en'), true);
    assert.strictEqual(isGameSupportedForLanguage('type_translation', 'en'), true);

    // Japanese excludes letter assembly games
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'ja'), false, 'Japanese must exclude scramble');
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'ja'), false, 'Japanese must exclude hangman');
    assert.strictEqual(isGameSupportedForLanguage('type_translation', 'ja'), true);
    assert.strictEqual(isGameSupportedForLanguage('memory_grid', 'ja'), true);

    // Chinese also excludes letter games
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'zh'), false);
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'zh'), false);
  });

  // -------------------------------------------------------------------------
  // Part 2: Prompt Pipeline Regression Contract & Golden Snapshots
  // -------------------------------------------------------------------------

  await test('T5: Generated Spanish-to-English prompts match golden snapshots exactly', async () => {
    const spec = {
      title: 'Travel Phrases',
      description: 'Essential phrases for transport and travel',
      topic: 'Travel',
      difficulty: 'beginner',
    };
    const section = {
      name: 'Airport',
      communicative_goal: 'Clear customs and board flight',
      lexical_focus: ['passport', 'boarding pass', 'luggage'],
    };
    const card = {
      l1_text: 'Pasaporte',
      l2_text: 'Passport',
      prompt_l1: 'Pasaporte',
      answer_l2: 'Passport',
      spanish_text: 'Pasaporte',
      english_text: 'Passport',
      part_of_speech: 'noun',
      l2_definition: 'An official document issued by a government.',
      definition_en: 'An official document issued by a government.',
      l1_translations: ['pasaporte', 'documento de viaje'],
      main_translations_es: ['pasaporte', 'documento de viaje'],
      collocations: ['passport control', 'valid passport'],
      l2_synonyms: ['travel document'],
      synonyms_en: ['travel document'],
      examples: [
        { l1: 'Necesito mi pasaporte.', l2: 'I need my passport for travel.' },
        { l1: 'Muestre su pasaporte.', l2: 'Show your passport to the officer.' },
      ],
      example_l1: 'Necesito mi pasaporte.',
      example_l2: 'I need my passport for travel.',
      example_sentence: 'I need my passport for travel.',
      l2_cloze_distractors: ['visa', 'ticket', 'boarding pass'],
      cloze_distractors_en: ['visa', 'ticket', 'boarding pass'],
    };
    const pairItem = { l1: 'Necesito mi pasaporte.', l2: 'I need my passport for travel.' };

    // Generate all 15 prompts for default es->en
    const pBlueprint = prompts.blueprintPrompt(spec);
    const pWordSet = prompts.wordSetPrompt(spec, section, 5, []);
    const pLexical = prompts.lexicalPrompt(card, ['fix definition']);
    const pEquivalents = prompts.equivalentsPrompt(card);
    const pExamples = prompts.examplesPrompt(card, undefined, spec);
    const pRewrite = prompts.exampleRewritePrompt(card, spec, pairItem, ['improve context'], []);
    const pSynonyms = prompts.synonymsPrompt(card);
    const pClozeDistractors = prompts.clozeDistractorsPrompt(card, spec);
    const pExampleAudit = prompts.exampleAuditPrompt(card, spec, pairItem);
    const pClozeSolve = prompts.clozeSolvePrompt('I need my ____ for travel.', ['Passport', 'visa', 'ticket']);
    const pFieldAudit = prompts.fieldAuditPrompt(card, spec);
    const pCardSafetyAudit = prompts.cardSafetyAuditPrompt([card], spec);
    const pDeckSafetyAudit = prompts.deckSafetyAuditPrompt(spec, [card]);
    const pCardSingleReview = prompts.cardSingleReviewPrompt(card, spec);
    const pCardSingleFix = prompts.cardSingleFixPrompt(card, ['fix definition'], spec);

    // Assert exact golden system prompt strings for Spanish-to-English baseline
    assert.strictEqual(
      pBlueprint.system,
      'You design high-quality Spanish to English flashcard decks for Spanish-speaking learners of English. Return JSON only. Plan a coherent set of thematic sections that, together, cover the deck topic well.'
    );
    assert.strictEqual(
      pWordSet.system,
      'You build Spanish to English flashcard word sets for Spanish-speaking learners of English. Return JSON only. Focus on a coherent, well-distributed set of pairs. Avoid duplicates, trivial variants, and near-synonyms.'
    );
    assert.strictEqual(
      pLexical.system,
      'You add precise linguistic metadata to a single Spanish to English flashcard. Return JSON only.'
    );
    assert.strictEqual(
      pEquivalents.system,
      'You add Spanish equivalents and English collocations to a single flashcard. Return JSON only.'
    );
    assert.strictEqual(
      pExamples.system,
      'You write matched example sentence pairs for a single Spanish to English flashcard. Return JSON only.'
    );
    assert.strictEqual(
      pRewrite.system,
      'You rewrite one example sentence pair of a Spanish to English flashcard. Return JSON only.'
    );
    assert.strictEqual(
      pSynonyms.system,
      'You list English synonyms of the English answer of a Spanish to English flashcard. Return JSON only.'
    );
    assert.strictEqual(
      pClozeDistractors.system,
      'You write wrong-answer options for a fill-in-the-blank English vocabulary exercise. Return JSON only.'
    );
    assert.strictEqual(
      pExampleAudit.system,
      'You are a strict but fair quality auditor for Spanish to English flashcards. Judge one example sentence pair. Return JSON only.'
    );
    assert.strictEqual(
      pClozeSolve.system,
      'You are a careful English examiner solving a fill-in-the-blank vocabulary question. Return JSON only.'
    );
    assert.strictEqual(
      pFieldAudit.system,
      'You are a strict but fair linguistic quality auditor for Spanish to English flashcards. Judge the accuracy and quality of vocabulary fields. Return JSON only.'
    );
    assert.strictEqual(
      pCardSafetyAudit.system,
      'You are an expert safety, ethics, and educational content auditor for language learning flashcards. Evaluate flashcards against ethical, safety, privacy, and educational guidelines. Return strict JSON only.'
    );
    assert.strictEqual(
      pDeckSafetyAudit.system,
      'You are an expert content policy reviewer assessing flashcard decks for a public marketplace. Return strict JSON only.'
    );
    assert.strictEqual(
      pCardSingleReview.system,
      'You are an expert bilingual Spanish-English linguistic and educational quality auditor for flashcards. Evaluate the card for translation accuracy, parts of speech, definition quality, collocations, synonyms, example sentences, and policy/safety guidelines. Return JSON only.'
    );
    assert.strictEqual(
      pCardSingleFix.system,
      'You are an expert bilingual Spanish-English lexicographer and curriculum designer. Generate complete, high-quality, corrected fields for a Spanish to English flashcard, resolving all identified issues. Return JSON only.'
    );

    // Role-named JSON keys in prompts
    assert.ok(pLexical.user.includes('l2_definition'));
    assert.ok(pEquivalents.user.includes('l1_translations'));
    assert.ok(pSynonyms.user.includes('l2_synonyms'));
    assert.ok(pClozeDistractors.user.includes('l2_cloze_distractors'));
    assert.ok(pExamples.user.includes('example_l1'));
    assert.ok(pExamples.user.includes('example_l2'));
  });

  await test('T6: Targeted assertion: No generated rule string ever contains doubled parentheses', async () => {
    // Check across all 15 supported pairs to prevent any bug regression like:
    // `(no Spanish (no inverted ¿ ¡ punctuation))` -> `((` or `))`
    const pairs = supportedPairs();
    const testSpec = { title: 'Test', description: 'Test', topic: 'Test' };
    const testCard = {
      l1_text: 'test',
      l2_text: 'test',
      prompt_l1: 'test',
      answer_l2: 'test',
      part_of_speech: 'noun',
      l2_definition: 'test def',
      l1_translations: ['test'],
      collocations: ['test col'],
      l2_synonyms: ['test syn'],
      examples: [{ l1: 'test l1', l2: 'test l2' }],
      l2_cloze_distractors: ['d1', 'd2', 'd3'],
    };
    const pairItem = { l1: 'test l1', l2: 'test l2' };

    // Targeted check for the exact regression bug seam (es->en)
    const esEnSynonyms = prompts.synonymsPrompt(testCard, undefined, { l1: 'es', l2: 'en' });
    assert.ok(
      !esEnSynonyms.user.includes('(no Spanish (no inverted'),
      'Prompt must not contain nested parenthetical "(no Spanish (no inverted"'
    );
    assert.ok(
      esEnSynonyms.user.includes('(no Spanish, no inverted ¿ ¡ punctuation)'),
      'Prompt must contain properly flattened "(no Spanish, no inverted ¿ ¡ punctuation)"'
    );
    assert.ok(!esEnSynonyms.user.includes('(('), 'es->en synonyms prompt must not contain "(("');
    assert.ok(!esEnSynonyms.user.includes('))'), 'es->en synonyms prompt must not contain "))"');

    for (const pair of pairs) {
      // 1. Check getPunctuationRule directly
      const punctRule = prompts.getPunctuationRule(pair.l1, pair.l2);
      assert.ok(!punctRule.includes('(('), `getPunctuationRule contains "((" for ${pair.l1}->${pair.l2}`);
      assert.ok(!punctRule.includes('))'), `getPunctuationRule contains "))" for ${pair.l1}->${pair.l2}`);

      // 2. Check getExamplePairRules
      const exampleRules = prompts.getExamplePairRules(pair);
      for (const rule of exampleRules) {
        assert.ok(!rule.includes('(('), `getExamplePairRules contains "((" for ${pair.l1}->${pair.l2}: "${rule}"`);
        assert.ok(!rule.includes('))'), `getExamplePairRules contains "))" for ${pair.l1}->${pair.l2}: "${rule}"`);
      }

      // 3. Check full generated prompt builders
      const builders = [
        () => prompts.blueprintPrompt(testSpec, pair),
        () => prompts.wordSetPrompt(testSpec, { name: 'S', communicative_goal: 'G', lexical_focus: ['W'] }, 5, [], pair),
        () => prompts.lexicalPrompt(testCard, [], pair),
        () => prompts.equivalentsPrompt(testCard, undefined, pair),
        () => prompts.examplesPrompt(testCard, undefined, testSpec, pair),
        () => prompts.exampleRewritePrompt(testCard, testSpec, pairItem, [], [], pair),
        () => prompts.synonymsPrompt(testCard, undefined, pair),
        () => prompts.clozeDistractorsPrompt(testCard, testSpec, undefined, pair),
        () => prompts.exampleAuditPrompt(testCard, testSpec, pairItem, pair),
        () => prompts.clozeSolvePrompt('Sentence with ____.', ['opt1', 'opt2'], pair),
        () => prompts.fieldAuditPrompt(testCard, testSpec, pair),
        () => prompts.cardSafetyAuditPrompt([testCard], testSpec, pair),
        () => prompts.deckSafetyAuditPrompt(testSpec, [testCard], pair),
        () => prompts.cardSingleReviewPrompt(testCard, testSpec, pair),
        () => prompts.cardSingleFixPrompt(testCard, ['fix'], testSpec, pair),
      ];

      for (const builder of builders) {
        const result = builder();
        // Remove known language endonym parentheticals like "Portuguese (Brazil)"
        // to isolate grammar rule syntax from language display names.
        const cleanSystem = result.system.replaceAll('(Brazil)', '');
        const cleanUser = result.user.replaceAll('(Brazil)', '');

        assert.ok(!cleanSystem.includes('(('), `system contains "((" for ${pair.l1}->${pair.l2}`);
        assert.ok(!cleanSystem.includes('))'), `system contains "))" for ${pair.l1}->${pair.l2}`);
        assert.ok(!cleanUser.includes('(('), `user contains "((" for ${pair.l1}->${pair.l2}`);
        assert.ok(!cleanUser.includes('))'), `user contains "))" for ${pair.l1}->${pair.l2}`);

        // Ensure no nested parentheticals like (rule (subrule))
        assert.ok(!/\([^)]*\([^)]*\)/.test(cleanUser), `user contains nested parentheses for ${pair.l1}->${pair.l2}`);
      }
    }
  });

  console.log(`\nALL ${passed} REGRESSION CONTRACT TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
