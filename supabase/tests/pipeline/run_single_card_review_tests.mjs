#!/usr/bin/env node
// Unit tests for Single Card AI Review and Fix Engine (frontend/src/ai/singleCardReview.js)
//
// Run with:
//   node supabase/tests/pipeline/run_single_card_review_tests.mjs

import assert from 'assert';
import {
  normalizeCardForReview,
  reviewSingleCard,
  generateCardFixes,
  diffSingleCard,
} from '../../../frontend/src/ai/singleCardReview.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Single Card AI Review & Fix Tests');

  // Test 1: Clean card passes AI review
  await test('T1: Clean card passes review with no issues', async () => {
    const card = {
      prompt_es: 'el gato',
      answer_en: 'cat',
      part_of_speech: 'noun',
      definition_en: 'A small domesticated carnivorous mammal with soft fur.',
      main_translations_es: ['gato', 'felino'],
      collocations: ['black cat', 'pet cat'],
      synonyms_en: ['feline', 'kitty'],
      examples: [
        { es: 'El gato duerme en el sofá.', en: 'The cat is sleeping on the sofa.' },
        { es: 'Tengo un gato negro.', en: 'I have a black cat at home.' },
        { es: 'El gato bebe leche.', en: 'The cat drinks warm milk every morning.' },
      ],
    };

    const mockRunPrompt = async (promptObj) => {
      const parsed = JSON.parse(promptObj.user);
      assert.strictEqual(parsed.card.prompt_es, 'el gato');
      assert.strictEqual(parsed.card.answer_en, 'cat');
      return {
        has_issues: false,
        overall_status: 'pass',
        summary: 'This flashcard is accurate, well-formatted, and complete.',
        issues: [],
      };
    };

    const result = await reviewSingleCard(card, { runPrompt: mockRunPrompt });
    assert.strictEqual(result.has_issues, false);
    assert.strictEqual(result.overall_status, 'pass');
    assert.strictEqual(result.issues.length, 0);
    assert.ok(result.summary.includes('accurate'));
  });

  // Test 2: Card with issues returns structured issues list
  await test('T2: Card with issues reports structured issues with fields and severity', async () => {
    const flawedCard = {
      prompt_es: 'correr',
      answer_en: 'run',
      part_of_speech: 'noun', // Error: should be verb
      definition_en: 'La acción de desplazarse rápidamente.', // Error: in Spanish instead of English
      main_translations_es: [],
      collocations: [],
      synonyms_en: ['walk'], // Inaccurate synonym
      examples: [
        { es: 'Me gusta correr.', en: 'I like it.' }, // Missing target word 'run'
      ],
    };

    const mockRunPrompt = async () => {
      return {
        has_issues: true,
        overall_status: 'needs_fix',
        summary: 'Found 4 issues with part of speech, definition language, synonyms, and example sentence.',
        issues: [
          {
            field: 'part_of_speech',
            severity: 'high',
            message: 'Part of speech is marked as noun, but "run" is used as a verb here.',
            suggestion: 'Change part of speech to "verb".',
          },
          {
            field: 'definition_en',
            severity: 'high',
            message: 'Definition is written in Spanish instead of English.',
            suggestion: 'Provide a concise English definition like "To move swiftly on foot with rapid strides."',
          },
          {
            field: 'synonyms_en',
            severity: 'medium',
            message: '"walk" is an antonym/different speed, not a synonym for run.',
            suggestion: 'Use synonyms like "sprint", "jog", "dash".',
          },
          {
            field: 'examples',
            severity: 'high',
            message: 'Example English sentence does not contain the word "run".',
            suggestion: 'Include the word "run" verbatim in the English sentence with context.',
          },
        ],
      };
    };

    const result = await reviewSingleCard(flawedCard, { runPrompt: mockRunPrompt });
    assert.strictEqual(result.has_issues, true);
    assert.strictEqual(result.overall_status, 'needs_fix');
    assert.strictEqual(result.issues.length, 4);
    assert.strictEqual(result.issues[0].field, 'part_of_speech');
    assert.strictEqual(result.issues[0].severity, 'high');
    assert.strictEqual(result.issues[1].field, 'definition_en');
  });

  // Test 3: Generate fixes produces high quality corrected card fields
  await test('T3: Generate fixes resolves issues and generates complete card fields', async () => {
    const originalCard = {
      prompt_es: 'correr',
      answer_en: 'run',
      part_of_speech: 'noun',
      definition_en: 'La acción de desplazarse.',
      main_translations_es: [],
      collocations: [],
      synonyms_en: [],
      examples: [],
    };

    const reviewResult = {
      has_issues: true,
      issues: [
        { field: 'part_of_speech', message: 'Should be verb' },
        { field: 'definition_en', message: 'Definition must be in English' },
      ],
    };

    const mockRunFixPrompt = async (promptObj) => {
      const parsed = JSON.parse(promptObj.user);
      assert.strictEqual(parsed.original_card.prompt_es, 'correr');
      assert.strictEqual(parsed.original_card.answer_en, 'run');
      assert.ok(parsed.issues_to_fix.length > 0);

      return {
        prompt_es: 'correr',
        answer_en: 'run',
        part_of_speech: 'verb',
        definition_en: 'To move swiftly on foot with rapid strides.',
        main_translations_es: ['correr', 'desplazarse rápidamente'],
        collocations: ['run fast', 'run a marathon', 'run away'],
        synonyms_en: ['sprint', 'jog', 'dash'],
        examples: [
          { es: 'Ella suele correr en el parque cada mañana.', en: 'She likes to run in the park every morning.' },
          { es: 'Ellos corren para no perder el autobús.', en: 'They run quickly to catch the departing bus.' },
          { es: 'Puedo correr cinco kilómetros sin parar.', en: 'I can run five kilometers without stopping.' },
        ],
        explanation: 'Updated part of speech to verb, added English definition, and generated 3 contextual examples.',
      };
    };

    const fixed = await generateCardFixes(originalCard, reviewResult, { runPrompt: mockRunFixPrompt });
    assert.strictEqual(fixed.part_of_speech, 'verb');
    assert.strictEqual(fixed.definition_en, 'To move swiftly on foot with rapid strides.');
    assert.strictEqual(fixed.main_translations_es.length, 2);
    assert.strictEqual(fixed.collocations.length, 3);
    assert.strictEqual(fixed.synonyms_en.length, 3);
    assert.strictEqual(fixed.examples.length, 3);
    assert.strictEqual(fixed.example_sentence, 'She likes to run in the park every morning.');
    assert.ok(fixed.explanation.includes('Updated part of speech'));
  });

  // Test 4: diffSingleCard accurately computes before-and-after differences
  await test('T4: diffSingleCard computes accurate field changes', async () => {
    const originalCard = {
      prompt_es: 'el libro',
      answer_en: 'book',
      part_of_speech: 'noun',
      definition_en: '',
      main_translations_es: ['libro'],
      collocations: [],
      synonyms_en: [],
      examples: [{ es: 'Leo un libro.', en: 'I read a book.' }],
    };

    const fixedCard = {
      prompt_es: 'el libro',
      answer_en: 'book',
      part_of_speech: 'noun',
      definition_en: 'A written work published in printed or electronic format.',
      main_translations_es: ['libro', 'tomo'],
      collocations: ['read a book', 'open a book'],
      synonyms_en: ['volume', 'tome'],
      examples: [
        { es: 'Leo un libro interesante.', en: 'I read an interesting book before sleeping.' },
        { es: 'Ella compró un libro nuevo.', en: 'She bought a new book at the bookstore.' },
        { es: 'El libro está sobre la mesa.', en: 'The book is lying open on the study table.' },
      ],
    };

    const diffs = diffSingleCard(originalCard, fixedCard);
    const changed = diffs.filter((d) => d.isChanged);
    const unchanged = diffs.filter((d) => !d.isChanged);

    assert.strictEqual(unchanged.some((d) => d.key === 'prompt_es'), true);
    assert.strictEqual(unchanged.some((d) => d.key === 'answer_en'), true);
    assert.strictEqual(unchanged.some((d) => d.key === 'part_of_speech'), true);

    assert.strictEqual(changed.some((d) => d.key === 'definition_en'), true);
    assert.strictEqual(changed.some((d) => d.key === 'main_translations_es'), true);
    assert.strictEqual(changed.some((d) => d.key === 'collocations'), true);
    assert.strictEqual(changed.some((d) => d.key === 'synonyms_en'), true);
    assert.strictEqual(changed.some((d) => d.key === 'examples'), true);
  });

  // Test 5: normalizeCardForReview handles various input shapes
  await test('T5: normalizeCardForReview normalizes draft and legacy cards safely', async () => {
    const rawCard = {
      spanish_text: 'la manzana',
      english_text: 'apple',
      example_es: 'Como una manzana.',
      example_en: 'I eat an apple.',
    };

    const norm = normalizeCardForReview(rawCard);
    assert.strictEqual(norm.prompt_es, 'la manzana');
    assert.strictEqual(norm.answer_en, 'apple');
    assert.strictEqual(norm.examples.length, 1);
    assert.strictEqual(norm.examples[0].es, 'Como una manzana.');
    assert.strictEqual(norm.examples[0].en, 'I eat an apple.');
  });

  console.log(`\nALL ${passed} SINGLE CARD REVIEW TESTS PASSED\n`);
})();
