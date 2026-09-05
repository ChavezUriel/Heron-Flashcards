#!/usr/bin/env node
// Area 3: Unicode Search Fix Tests (P0 regression & property tests)
// Tests text search normalization and highlighting in frontend/src/textSearch.js:
//   - Titles in Cyrillic, Greek, Han, Kana, and Arabic are findable
//   - Spanish-to-English search results and diacritic stripping are unchanged
//   - Property test: normalizeWithIndexMap stays index-for-index consistent
//     with normalizeSearchText across mixed scripts
//   - Highlight segment integrity and character offset tracking
//
//   node supabase/tests/run_area3_unicode_search.mjs

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { pathToFileURL } from 'url';

const textSearchPath = path.resolve('frontend/src/textSearch.js');
const { normalizeSearchText, scoreFieldMatch, buildHighlightSegments } = await import(pathToFileURL(textSearchPath).href);

// Extract internal normalizeWithIndexMap function without modifying product code
const code = fs.readFileSync(textSearchPath, 'utf8');
const script = new vm.Script(
  code
    .replace('export function normalizeSearchText', 'function normalizeSearchText')
    .replace('export function scoreFieldMatch', 'function scoreFieldMatch')
    .replace('export function buildHighlightSegments', 'function buildHighlightSegments') +
    '\nglobalThis.normalizeWithIndexMap = normalizeWithIndexMap;'
);
const ctx = vm.createContext({ console, Math, String, Array });
script.runInContext(ctx);
const normalizeWithIndexMap = ctx.normalizeWithIndexMap;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Area 3: Unicode search tests (frontend/src/textSearch.js)');

  await test('T1: Deck titles in Cyrillic, Greek, Han, Kana, and Arabic normalize properly and are findable', async () => {
    const titles = [
      { script: 'Cyrillic', title: 'Война и мир', query: 'война', expectSubstring: 'воина' },
      { script: 'Cyrillic', title: 'Русский язык для начинающих', query: 'русский', expectSubstring: 'русскии' },
      { script: 'Greek', title: 'Οδύσσεια του Ομήρου', query: 'οδύσσεια', expectSubstring: 'οδυσσεια' },
      { script: 'Greek', title: 'Ελληνική γραμματική', query: 'ελληνική', expectSubstring: 'ελληνικη' },
      { script: 'Han', title: '紅樓夢', query: '紅樓', expectSubstring: '紅樓' },
      { script: 'Han', title: '基础汉语词汇', query: '词汇', expectSubstring: '词汇' },
      { script: 'Kana', title: 'ひらがな と カタカナ', query: 'ひらがな', expectSubstring: 'ひらか' },
      { script: 'Kana', title: 'カタカナ単語集', query: 'カタカナ', expectSubstring: 'カタカナ' },
      { script: 'Arabic', title: 'ألف ليلة وليلة', query: 'ليلة', expectSubstring: 'ليلة' },
      { script: 'Arabic', title: 'قواعد اللغة العربية', query: 'العربية', expectSubstring: 'العربية' },
    ];

    for (const { script: scriptName, title, query, expectSubstring } of titles) {
      const normalizedTitle = normalizeSearchText(title);
      assert.ok(
        normalizedTitle.length > 0,
        `${scriptName} title "${title}" normalized to empty string (P0 regression!)`
      );
      assert.ok(
        normalizedTitle.includes(expectSubstring),
        `${scriptName} title "${title}" expected to contain "${expectSubstring}", got "${normalizedTitle}"`
      );

      // Score matching
      const normalizedQuery = normalizeSearchText(query);
      const score = scoreFieldMatch(title, normalizedQuery);
      assert.ok(
        score > 0,
        `${scriptName} title "${title}" could not be found with query "${query}" (score=${score})`
      );

      // Exact title match gets top score (120)
      const exactScore = scoreFieldMatch(title, normalizedTitle);
      assert.strictEqual(
        exactScore,
        120,
        `exact match score for "${title}" must be 120, got ${exactScore}`
      );
    }
  });

  await test('T2: Spanish-to-English search behavior and diacritic forgivingness are unchanged', async () => {
    // Diacritic stripping in Latin characters is preserved for forgiving search
    assert.strictEqual(normalizeSearchText('Café con leche'), 'cafe con leche');
    assert.strictEqual(normalizeSearchText('El niño juega fútbol'), 'el nino juega futbol');
    assert.strictEqual(normalizeSearchText('¿Dónde está la estación?'), 'donde esta la estacion');
    assert.strictEqual(normalizeSearchText('¡Bienvenidos a España!'), 'bienvenidos a espana');
    assert.strictEqual(normalizeSearchText('Crème brûlée'), 'creme brulee');
    assert.strictEqual(normalizeSearchText('The quick brown fox'), 'the quick brown fox');
    assert.strictEqual(normalizeSearchText('  MULTIPLE   SPACES  '), 'multiple spaces');
    assert.strictEqual(normalizeSearchText(null), '');
    assert.strictEqual(normalizeSearchText(undefined), '');

    // Search scores for Spanish/English queries
    const spanishDeck = 'Vocabulario Básico: Comida y Bebidas';
    assert.strictEqual(scoreFieldMatch(spanishDeck, 'vocabulario basico comida y bebidas'), 120, 'exact match');
    assert.strictEqual(scoreFieldMatch(spanishDeck, 'vocabulario'), 90, 'prefix match');
    assert.strictEqual(scoreFieldMatch(spanishDeck, 'comida'), 70, 'substring match');
    assert.strictEqual(scoreFieldMatch(spanishDeck, 'vocabulario bebidas'), 50, 'all terms matched');
    assert.strictEqual(scoreFieldMatch(spanishDeck, 'vocabulario autos'), 21, 'one of two terms matched');
    assert.strictEqual(scoreFieldMatch(spanishDeck, 'computadora'), 0, 'no terms matched');
  });

  await test('T3: Property test: normalizeWithIndexMap stays index-for-index consistent with normalizeSearchText', async () => {
    const propertyTestCorpus = [
      'Short',
      'A slightly longer English sentence for test matching.',
      '¿Dónde está la biblioteca municipal?',
      'Señor, el niño quiere más puré y café.',
      'Война и мир — роман-эпопея Льва Николаевича Толстого.',
      'Η Ιλιάδα και η Οδύσσεια είναι τα αρχαιότερα έπη της ελληνικής γραμματείας.',
      '西游记，水浒传，三国演义，红楼梦是中国古典四大名著。',
      '日本語のひらがな（あいうえお）とカタカナ（アイウエオ）と漢字（漢字）。',
      'أنا أحب تعلم اللغات الأجنبية كل يوم في الصباح الباكر.',
      'Mixed: Spanish (¿Cómo estás?), Russian (Привет!), Chinese (你好), Arabic (مرحبا)',
      'Accented Polish: Zażółć gęślą jaźń; Turkish: Ağaç, ılık, çeşme, şair.',
      'Symbols & Numbers: 100% Guaranteed! Call: +1 (800) 555-0199 / $49.99 @store #deal',
      '   Spacing:  \t\n  tabs and newlines   and   spaces   ',
      'Special chars: «guillemets», "curly quotes", “smart quotes”, — em dash, – en dash.',
      'Punctuation only: !@#$%^&*()_+-=[]{}|;:",.<>?/~`',
      '',
    ];

    // Systematic property assertions
    for (const text of propertyTestCorpus) {
      const normText = normalizeSearchText(text);
      const { normalized, map } = normalizeWithIndexMap(text);

      // Invariant 1: Collapsing whitespace on index-mapped normalized text must equal normalizeSearchText
      const collapsedFromMap = normalized.replace(/\s+/g, ' ').trim();
      assert.strictEqual(
        collapsedFromMap,
        normText,
        `Index map normalized text mismatch for: "${text}"\n  normalizeSearchText: "${normText}"\n  fromIndexMap:        "${collapsedFromMap}"`
      );

      // Invariant 2: Every index in map is a valid character index of original text
      if (text.length === 0) {
        assert.strictEqual(map.length, 0);
        assert.strictEqual(normalized, '');
      } else {
        assert.strictEqual(
          normalized.length,
          map.length,
          `normalized string and map array must have identical length for "${text}"`
        );
        for (let i = 0; i < map.length; i++) {
          const origIndex = map[i];
          assert.ok(
            origIndex >= 0 && origIndex < text.length,
            `map[${i}] = ${origIndex} is out of bounds for string of length ${text.length}`
          );
        }
      }
    }
  });

  await test('T4: Highlight segments preserve full original text across mixed scripts', async () => {
    const testCases = [
      { text: 'The cat sat on the mat.', query: 'cat' },
      { text: '¿Dónde está el gato negro?', query: 'gato' },
      { text: 'Война и мир Льва Толстого', query: 'мир' },
      { text: 'Ελληνική μυθολογία και ιστορία', query: 'μυθολογια' },
      { text: '红楼梦与三国演义经典文学', query: '三国' },
      { text: 'ひらがなカタカナ日本語の練習', query: 'カタカナ' },
      { text: 'كتاب ألف ليلة وليلة الشهير', query: 'ليلة' },
      { text: 'No match here at all.', query: 'xyz' },
      { text: 'Case INSENSITIVE and ACCÉNT matching: café and CAFÉ', query: 'cafe' },
    ];

    for (const { text, query } of testCases) {
      const normalizedQuery = normalizeSearchText(query);
      const segments = buildHighlightSegments(text, normalizedQuery);

      // Invariant 1: Concatenating all segment texts must reproduce the original string exactly
      const reconstructed = segments.map((s) => s.text).join('');
      assert.strictEqual(
        reconstructed,
        text,
        `Reconstructed text does not equal original text for query "${query}" on "${text}"`
      );

      // Invariant 2: If query occurs, at least one segment must be matched
      if (normalizeSearchText(text).includes(normalizedQuery) && normalizedQuery.length > 0) {
        const hasMatch = segments.some((s) => s.isMatch);
        assert.ok(
          hasMatch,
          `Expected match segment for query "${query}" in text "${text}", but none was marked`
        );
      }
    }
  });

  await test('T5: Highlight offsets accurately bound the matched substring in original text', async () => {
    // English
    const enText = 'The black cat jumped over the lazy dog.';
    const enSegs = buildHighlightSegments(enText, normalizeSearchText('cat'));
    const enMatches = enSegs.filter((s) => s.isMatch);
    assert.strictEqual(enMatches.length, 1);
    assert.strictEqual(enMatches[0].text, 'cat');

    // Spanish with diacritics and inverted punctuation
    const esText = '¿Dónde está el café más rico?';
    const esSegs = buildHighlightSegments(esText, normalizeSearchText('cafe'));
    const esMatches = esSegs.filter((s) => s.isMatch);
    assert.strictEqual(esMatches.length, 1);
    assert.strictEqual(esMatches[0].text, 'café', 'highlight must extract original accented "café"');

    // Russian Cyrillic
    const ruText = 'Это моя любимая книга Война и мир.';
    const ruSegs = buildHighlightSegments(ruText, normalizeSearchText('война'));
    const ruMatches = ruSegs.filter((s) => s.isMatch);
    assert.strictEqual(ruMatches.length, 1);
    assert.strictEqual(ruMatches[0].text, 'Война', 'highlight must preserve original capital "Война"');

    // Greek
    const grText = 'Η αρχαία πόλη των Αθηνών.';
    const grSegs = buildHighlightSegments(grText, normalizeSearchText('πολη'));
    const grMatches = grSegs.filter((s) => s.isMatch);
    assert.strictEqual(grMatches.length, 1);
    assert.strictEqual(grMatches[0].text, 'πόλη', 'highlight must extract original accented "πόλη"');

    // Chinese Han
    const zhText = '我非常喜欢阅读红楼梦这本书。';
    const zhSegs = buildHighlightSegments(zhText, normalizeSearchText('红楼梦'));
    const zhMatches = zhSegs.filter((s) => s.isMatch);
    assert.strictEqual(zhMatches.length, 1);
    assert.strictEqual(zhMatches[0].text, '红楼梦');

    // Arabic
    const arText = 'قصص ألف ليلة وليلة الرائعة.';
    const arSegs = buildHighlightSegments(arText, normalizeSearchText('ليلة'));
    const arMatches = arSegs.filter((s) => s.isMatch);
    assert.strictEqual(arMatches.length, 2, 'should match both occurrences of ليلة');
    assert.strictEqual(arMatches[0].text, 'ليلة');
    assert.strictEqual(arMatches[1].text, 'ليلة');
  });

  console.log(`\nALL ${passed} UNICODE SEARCH TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
