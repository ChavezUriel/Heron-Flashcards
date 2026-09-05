#!/usr/bin/env node
// Area 2: Language Registry and Multi-Pair Configuration Tests
// Tests the authoritative registry in frontend/src/languages.js:
//   - Entry completeness across the engine-consumed fields
//   - Well-formed BCP-47 TTS tags
//   - Invariant: supported pairs never have source == target
//   - Pair clozeStrategy names an implemented engine strategy rather than a stub
//   - getPair, isPairSupported, and defaultPair behavior (defaultPair -> es->en)
//   - Referential integrity: all pair languages exist in registry
//   - Minigame filtering and script constraints
//
//   node supabase/tests/run_area2_language_registry.mjs

import assert from 'assert';
import path from 'path';
import { pathToFileURL } from 'url';

const languagesModulePath = pathToFileURL(path.resolve('frontend/src/languages.js')).href;
const minigameTextModulePath = pathToFileURL(path.resolve('frontend/src/minigameText.js')).href;

const {
  LANGUAGES,
  PAIRS,
  supportedPairs,
  getLanguage,
  getPair,
  isPairSupported,
  defaultPair,
  isGameSupportedForLanguage,
  standardTypoBudget,
  zeroTypoBudget,
  SCRIPT_MATCHERS,
  hasDisallowedScriptLetter,
  getPairValidationRule,
} = await import(languagesModulePath);

const { CLOZE_STRATEGIES } = await import(minigameTextModulePath);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Area 2: Language registry tests (frontend/src/languages.js)');

  await test('T1: Every registry entry has all engine-consumed fields with correct types', async () => {
    const requiredFields = [
      'tag',
      'name',
      'endonym',
      'script',
      'diacriticsSignificant',
      'functionWords',
      'typoBudget',
      'ttsTag',
      'games',
      'tier',
      'tierL1',
      'tierL2',
    ];

    assert.ok(Object.keys(LANGUAGES).length >= 16, `expected at least 16 language entries, got ${Object.keys(LANGUAGES).length}`);

    for (const [tag, entry] of Object.entries(LANGUAGES)) {
      assert.strictEqual(entry.tag, tag, `tag mismatch for ${tag}`);
      for (const field of requiredFields) {
        assert.ok(
          entry[field] !== undefined,
          `language "${tag}" is missing required field "${field}"`
        );
      }
      assert.strictEqual(typeof entry.name, 'string', `${tag}.name must be string`);
      assert.strictEqual(typeof entry.endonym, 'string', `${tag}.endonym must be string`);
      assert.strictEqual(typeof entry.script, 'string', `${tag}.script must be string`);
      assert.strictEqual(typeof entry.diacriticsSignificant, 'boolean', `${tag}.diacriticsSignificant must be boolean`);
      assert.ok(Array.isArray(entry.functionWords), `${tag}.functionWords must be an array`);
      assert.strictEqual(typeof entry.typoBudget, 'function', `${tag}.typoBudget must be a function`);
      assert.strictEqual(typeof entry.ttsTag, 'string', `${tag}.ttsTag must be string`);
      assert.ok(entry.games instanceof Set, `${tag}.games must be a Set`);

      // Verify typoBudget profiles
      if (entry.script === 'Latn' || entry.script === 'Cyrl' || entry.script === 'Arab' || entry.script === 'Hebr') {
        assert.strictEqual(entry.typoBudget(3), 0);
        assert.strictEqual(entry.typoBudget(5), 1);
        assert.strictEqual(entry.typoBudget(10), 2);
      } else {
        assert.strictEqual(entry.typoBudget(10), 0, `${tag} non-alphabetic must have zero typo budget`);
      }
    }
  });

  await test('T2: Every ttsTag is a well-formed BCP-47 language tag', async () => {
    for (const [tag, entry] of Object.entries(LANGUAGES)) {
      assert.doesNotThrow(() => {
        const canonical = Intl.getCanonicalLocales(entry.ttsTag);
        assert.strictEqual(canonical.length, 1, `canonical locale length should be 1 for ${entry.ttsTag}`);
      }, `invalid BCP-47 ttsTag "${entry.ttsTag}" for language "${tag}"`);

      // Format check (e.g. 'en-US', 'es-ES', 'pt-BR')
      assert.match(
        entry.ttsTag,
        /^[a-z]{2,3}(-[A-Z]{2}|-[A-Z][a-z]{3})?$/,
        `ttsTag "${entry.ttsTag}" does not match standard BCP-47 pattern`
      );
    }
  });

  await test('T3: supportedPairs never contains any pair whose source equals its target', async () => {
    const supported = supportedPairs();
    assert.ok(supported.length > 0, 'supportedPairs() returned empty array');
    assert.strictEqual(supported.length, 15, `expected 15 Tier 1 pairs, got ${supported.length}`);

    for (const pair of supported) {
      assert.notStrictEqual(
        pair.l1,
        pair.l2,
        `supported pair cannot have source equal to target: ${pair.l1} -> ${pair.l2}`
      );
    }
  });

  await test('T4: Every pair clozeStrategy names a strategy the engine actually implements', async () => {
    const implementedStrategies = Object.keys(CLOZE_STRATEGIES);
    assert.ok(implementedStrategies.includes('verbatim'), 'engine must implement verbatim strategy');

    // Test that the engine's verbatim strategy actually finds match spans
    const testMatch = CLOZE_STRATEGIES.verbatim('The cat sat.', 'cat');
    assert.deepStrictEqual(testMatch, { start: 4, end: 7 }, 'verbatim strategy implementation check');

    // Test that stub strategies return null (seams present but not implemented)
    assert.strictEqual(CLOZE_STRATEGIES.lemma('The cat sat.', 'cat'), null, 'lemma strategy must be a stub');
    assert.strictEqual(CLOZE_STRATEGIES.segmenter('The cat sat.', 'cat'), null, 'segmenter strategy must be a stub');

    // Every supported pair must use the implemented 'verbatim' strategy
    for (const pair of supportedPairs()) {
      assert.strictEqual(
        pair.clozeStrategy,
        'verbatim',
        `pair ${pair.l1}->${pair.l2} uses unverified strategy "${pair.clozeStrategy}"`
      );
      assert.ok(
        typeof CLOZE_STRATEGIES[pair.clozeStrategy] === 'function',
        `pair clozeStrategy "${pair.clozeStrategy}" is not a registered engine strategy`
      );
    }
  });

  await test('T5: getPair, isPairSupported, and defaultPair behave; defaultPair resolves to es->en', async () => {
    // defaultPair regression contract
    const def = defaultPair();
    assert.deepStrictEqual(def, { l1: 'es', l2: 'en' }, 'defaultPair() must resolve to { l1: "es", l2: "en" }');

    // getPair lookups
    const esEn = getPair('es', 'en');
    assert.ok(esEn, 'getPair("es", "en") must return pair descriptor');
    assert.strictEqual(esEn.l1, 'es');
    assert.strictEqual(esEn.l2, 'en');
    assert.strictEqual(esEn.tier, 1);
    assert.strictEqual(esEn.clozeStrategy, 'verbatim');
    assert.strictEqual(esEn.minModelTier, 'tier1');

    // Object signature
    const esEnObj = getPair({ l1: 'es', l2: 'en' });
    assert.deepStrictEqual(esEnObj, esEn, 'getPair({ l1, l2 }) must match getPair(l1, l2)');

    // Unsupported and reflex pairs
    assert.strictEqual(getPair('es', 'es'), null, 'reflective pair must return null');
    assert.strictEqual(getPair('ja', 'en'), null, 'out-of-scope pair must return null');
    assert.strictEqual(getPair(null, 'en'), null);
    assert.strictEqual(getPair('es', null), null);

    // isPairSupported
    assert.strictEqual(isPairSupported('es', 'en'), true);
    assert.strictEqual(isPairSupported('fr', 'en'), true);
    assert.strictEqual(isPairSupported('pt-BR', 'es'), true);
    assert.strictEqual(isPairSupported('es', 'es'), false);
    assert.strictEqual(isPairSupported('ja', 'en'), false);
    assert.strictEqual(isPairSupported('ru', 'en'), false);
    assert.strictEqual(isPairSupported('en', 'de'), false, 'de as target is Tier 2, not Tier 1');
  });

  await test('T6: Every language referenced in PAIRS exists in the LANGUAGES registry', async () => {
    for (const pair of PAIRS) {
      const l1 = LANGUAGES[pair.l1];
      const l2 = LANGUAGES[pair.l2];
      assert.ok(l1, `pair source language "${pair.l1}" does not exist in LANGUAGES registry`);
      assert.ok(l2, `pair target language "${pair.l2}" does not exist in LANGUAGES registry`);

      // getLanguage resolution
      assert.strictEqual(getLanguage(pair.l1)?.tag, pair.l1);
      assert.strictEqual(getLanguage(pair.l2)?.tag, pair.l2);
    }

    // Fuzzy/case-insensitive/subtag fallback
    assert.strictEqual(getLanguage('pt-br')?.tag, 'pt-BR');
    assert.strictEqual(getLanguage('ES')?.tag, 'es');
    assert.strictEqual(getLanguage('en-US')?.tag, 'en');
    assert.strictEqual(getLanguage('es-419')?.tag, 'es');
    assert.strictEqual(getLanguage('invalid-xxx'), null);
  });

  await test('T7: Minigame support and script matchers adhere to language constraints', async () => {
    // English minigames include all 12
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'en'), true);
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'en'), true);
    assert.strictEqual(isGameSupportedForLanguage('multiple_choice', 'en'), true);

    // Japanese/Chinese exclude letter games
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'ja'), false);
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'ja'), false);
    assert.strictEqual(isGameSupportedForLanguage('scramble', 'zh'), false);
    assert.strictEqual(isGameSupportedForLanguage('hangman', 'zh'), false);
    assert.strictEqual(isGameSupportedForLanguage('type_translation', 'ja'), true);

    // Script matchers
    assert.ok(SCRIPT_MATCHERS.Latn.test('Hello'));
    assert.ok(SCRIPT_MATCHERS.Cyrl.test('Привет'));
    assert.ok(SCRIPT_MATCHERS.Hans.test('中文'));
    assert.ok(SCRIPT_MATCHERS.Arab.test('عربي'));

    // hasDisallowedScriptLetter
    assert.strictEqual(hasDisallowedScriptLetter('Hello world', 'Latn'), false);
    assert.strictEqual(hasDisallowedScriptLetter('Hello мир', 'Latn'), true);
    assert.strictEqual(hasDisallowedScriptLetter('Привет мир', 'Cyrl'), false);
    assert.strictEqual(hasDisallowedScriptLetter('Привет world', 'Cyrl'), true);

    // Pair validation rule helper
    const esEnRule = getPairValidationRule({ l1: 'es', l2: 'en' });
    assert.strictEqual(esEnRule.isDefault, true);
    assert.ok(esEnRule.disallowedPunctuation?.test('¿Hello?'));
    assert.strictEqual(esEnRule.isInvalidTargetText('¿Where is the library?'), true);
    assert.strictEqual(esEnRule.isInvalidTargetText('Where is the library?'), false);

    const enEsRule = getPairValidationRule({ l1: 'en', l2: 'es' });
    assert.strictEqual(enEsRule.disallowedPunctuation, null, 'en->es should not disallow Spanish punctuation in target');
    assert.strictEqual(enEsRule.isInvalidTargetText('¿Dónde está la biblioteca?'), false);
  });

  console.log(`\nALL ${passed} LANGUAGE REGISTRY TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
