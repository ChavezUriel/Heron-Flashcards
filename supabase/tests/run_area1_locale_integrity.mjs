#!/usr/bin/env node
// Area 1: Locale File Integrity Tests
// Verifies:
//   (a) Keyset parity across all discovered locales with en.json as source of truth
//   (b) No empty, null, or undefined translation values
//   (c) Placeholder token consistency between en.json and each locale
//   (d) CLDR plural category rules for each target language
//   (e) All JSX/JS translation key references exist in en.json
//   (f) All en.json keys are used in the codebase (or flagged as dead)
//
//   node supabase/tests/run_area1_locale_integrity.mjs

import assert from 'assert';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve('frontend/src/locales');
const SRC_DIR = path.resolve('frontend/src');

function flattenKeys(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenKeys(val, fullKey));
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

function getAllCodeFiles(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'locales' && entry.name !== 'node_modules') {
        files = files.concat(getAllCodeFiles(fullPath));
      }
    } else if (entry.name.endsWith('.jsx') || entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

// Discovered locales
const localeFiles = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const locales = {};
const flatLocales = {};
for (const file of localeFiles) {
  const lang = path.basename(file, '.json');
  const raw = fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8');
  locales[lang] = JSON.parse(raw);
  flatLocales[lang] = flattenKeys(locales[lang]);
}

const enKeys = Object.keys(flatLocales['en'] || {});
const enKeySet = new Set(enKeys);

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

(async () => {
  console.log(`Area 1: Locale file integrity tests (${localeFiles.length} locales discovered: ${Object.keys(locales).join(', ')})`);

  // -------------------------------------------------------------------------
  // (a) Keyset parity across all locales
  // -------------------------------------------------------------------------
  await test('T1: Keyset parity across all locales matches en.json exactly', async () => {
    assert.ok(flatLocales['en'], 'en.json must exist as source of truth');
    const otherLocales = Object.keys(flatLocales).filter((l) => l !== 'en');

    for (const loc of otherLocales) {
      const locKeySet = new Set(Object.keys(flatLocales[loc]));
      const missing = enKeys.filter((k) => !locKeySet.has(k));
      const extra = Object.keys(flatLocales[loc]).filter((k) => !enKeySet.has(k));

      assert.strictEqual(
        missing.length,
        0,
        `Locale '${loc}' is missing ${missing.length} keys present in en.json: ${missing.slice(0, 5).join(', ')}...`
      );
      assert.strictEqual(
        extra.length,
        0,
        `Locale '${loc}' has ${extra.length} extra keys not in en.json: ${extra.slice(0, 5).join(', ')}...`
      );
    }
  });

  // -------------------------------------------------------------------------
  // (b) No empty, null, or undefined translation values
  // -------------------------------------------------------------------------
  await test('T2: No translation value is empty, null, or undefined in any locale', async () => {
    for (const [loc, flat] of Object.entries(flatLocales)) {
      for (const [key, val] of Object.entries(flat)) {
        assert.ok(
          val !== null && val !== undefined,
          `Locale '${loc}' key '${key}' is null or undefined`
        );
        assert.strictEqual(
          typeof val,
          'string',
          `Locale '${loc}' key '${key}' is not a string (type: ${typeof val})`
        );
        assert.ok(
          val.trim().length > 0,
          `Locale '${loc}' key '${key}' has an empty translation string`
        );
      }
    }
  });

  // -------------------------------------------------------------------------
  // (c) Placeholder token consistency
  // -------------------------------------------------------------------------
  await test('T3: Placeholder tokens match between en.json and each target locale', async () => {
    function extractPlaceholders(str) {
      const vars = new Set();
      let i = 0;
      function parseMessage(inPlural = false) {
        while (i < str.length) {
          if (str[i] === '{') {
            i++;
            // Check for double brace {{var}}
            if (i < str.length && str[i] === '{') {
              i++;
              const start = i;
              while (i < str.length && str[i] !== '}') i++;
              const token = str.slice(start, i).trim();
              if (token) vars.add(token);
              if (i < str.length && str[i] === '}') i++;
              if (i < str.length && str[i] === '}') i++;
              continue;
            }

            const start = i;
            while (i < str.length && str[i] !== ',' && str[i] !== '}') i++;
            const token = str.slice(start, i).trim();

            if (str[i] === '}') {
              if (token && /^[a-zA-Z0-9_]+$/.test(token)) {
                vars.add(token);
              }
              i++;
            } else if (str[i] === ',') {
              if (token && /^[a-zA-Z0-9_]+$/.test(token)) {
                vars.add(token);
              }
              i++;
              const typeStart = i;
              while (i < str.length && str[i] !== ',' && str[i] !== '}') i++;
              const type = str.slice(typeStart, i).trim();
              if (type === 'plural' || type === 'select' || type === 'selectordinal') {
                if (str[i] === ',') i++;
                while (i < str.length && str[i] !== '}') {
                  while (i < str.length && str[i] !== '{' && str[i] !== '}') i++;
                  if (str[i] === '{') {
                    i++;
                    parseMessage(true);
                  }
                }
                if (str[i] === '}') i++;
              } else {
                while (i < str.length && str[i] !== '}') i++;
                if (str[i] === '}') i++;
              }
            }
          } else if (str[i] === '}') {
            if (inPlural) {
              i++;
              return;
            }
            i++;
          } else {
            i++;
          }
        }
      }

      parseMessage(false);
      return [...vars].sort();
    }

    const otherLocales = Object.keys(flatLocales).filter((l) => l !== 'en');
    for (const loc of otherLocales) {
      const mismatches = [];
      for (const [key, enVal] of Object.entries(flatLocales['en'])) {
        const enTokens = extractPlaceholders(enVal);
        if (enTokens.length === 0) continue;

        const locVal = flatLocales[loc][key] || '';
        const locTokens = extractPlaceholders(locVal);

        if (JSON.stringify(enTokens) !== JSON.stringify(locTokens)) {
          mismatches.push({
            key,
            enTokens,
            locTokens,
            enVal,
            locVal,
          });
        }
      }

      assert.strictEqual(
        mismatches.length,
        0,
        `Locale '${loc}' has ${mismatches.length} placeholder token mismatches with en.json. First: ${JSON.stringify(mismatches[0])}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // (d) CLDR Plural Category Rules
  // -------------------------------------------------------------------------
  await test('T4: Plural forms follow CLDR plural category rules for each target language', async () => {
    const cldrSuffixes = ['zero', 'one', 'two', 'few', 'many', 'other'];

    for (const loc of Object.keys(flatLocales)) {
      // Intl.PluralRules resolution for the locale
      const pr = new Intl.PluralRules(loc);
      const allowedCategories = new Set(pr.resolvedOptions().pluralCategories);

      // Check keys with plural suffixes
      for (const key of Object.keys(flatLocales[loc])) {
        const parts = key.split('_');
        const lastPart = parts[parts.length - 1];
        if (cldrSuffixes.includes(lastPart)) {
          // If the key is a plural form, verify it is allowed in this locale's CLDR categories
          // (or standard i18next convention)
          if (!allowedCategories.has(lastPart) && lastPart !== 'zero') {
            assert.fail(
              `Locale '${loc}' uses plural category '_${lastPart}' in key '${key}', but CLDR only allows [${[...allowedCategories].join(', ')}]`
            );
          }
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // (e) JSX Translation Key References Exist in en.json
  // -------------------------------------------------------------------------
  await test('T5: Every translation key referenced in the JSX codebase actually exists in en.json', async () => {
    const codeFiles = getAllCodeFiles(SRC_DIR);
    const literalKeyRegex = /\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g;
    const transKeyRegex = /i18nKey=\s*['"]([a-zA-Z0-9_.]+)['"]/g;
    const transBraceRegex = /i18nKey=\{\s*['"]([a-zA-Z0-9_.]+)['"]\s*\}/g;

    const missingKeys = [];

    for (const filePath of codeFiles) {
      const relPath = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
      const content = fs.readFileSync(filePath, 'utf8');

      let m;
      while ((m = literalKeyRegex.exec(content)) !== null) {
        const key = m[1];
        // Allow dynamic namespace or plural base keys if pluralized forms exist
        if (!enKeySet.has(key) && !enKeySet.has(`${key}_one`) && !enKeySet.has(`${key}_other`)) {
          missingKeys.push({ file: relPath, key, source: m[0] });
        }
      }

      while ((m = transKeyRegex.exec(content)) !== null) {
        const key = m[1];
        if (!enKeySet.has(key) && !enKeySet.has(`${key}_one`) && !enKeySet.has(`${key}_other`)) {
          missingKeys.push({ file: relPath, key, source: m[0] });
        }
      }

      while ((m = transBraceRegex.exec(content)) !== null) {
        const key = m[1];
        if (!enKeySet.has(key) && !enKeySet.has(`${key}_one`) && !enKeySet.has(`${key}_other`)) {
          missingKeys.push({ file: relPath, key, source: m[0] });
        }
      }
    }

    if (missingKeys.length > 0) {
      const details = missingKeys.map((k) => `  - ${k.file}: key "${k.key}" (${k.source})`).join('\n');
      assert.fail(`Found ${missingKeys.length} translation keys in JSX/JS code missing from en.json:\n${details}`);
    }
  });

  // -------------------------------------------------------------------------
  // (f) Dead key detection in en.json
  // -------------------------------------------------------------------------
  // A key counts as referenced when its literal string appears in the code, or
  // when it sits under a prefix some call site builds dynamically — e.g.
  // SettingsPage does t(`settings.sections.${section.id}`), which a static scan
  // cannot resolve and would otherwise report as ~180 dead keys.
  //
  // This check is advisory on purpose. A dead key is untidy; a missing key (T5)
  // renders a raw key string to the user. Only the latter should fail the run.
  await test('T6: Unreferenced keys in en.json (advisory)', async () => {
    const codeFiles = getAllCodeFiles(SRC_DIR);
    const fullCode = codeFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

    // Capture the static prefix of any dynamically built key: `foo.bar.${...}`
    const dynamicPrefixes = new Set();
    for (const match of fullCode.matchAll(/([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.\$\{/g)) {
      dynamicPrefixes.add(match[1]);
    }

    const deadKeys = [];
    for (const key of enKeys) {
      const baseKey = key.replace(/_(one|other|zero|few|many)$/, '');
      if ([...dynamicPrefixes].some((prefix) => key.startsWith(`${prefix}.`))) continue;
      if (fullCode.includes(key) || fullCode.includes(baseKey)) continue;
      deadKeys.push(key);
    }

    if (dynamicPrefixes.size) {
      console.log(`    i ${dynamicPrefixes.size} dynamic key prefix(es) treated as referenced`);
    }
    if (deadKeys.length) {
      console.log(`    i advisory: ${deadKeys.length} key(s) have no detectable reference`);
      for (const key of deadKeys.slice(0, 15)) console.log(`      - ${key}`);
      if (deadKeys.length > 15) console.log(`      ... and ${deadKeys.length - 15} more`);
    } else {
      console.log('    i advisory: no unreferenced keys detected');
    }
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} test(s) failed in Area 1:`);
    for (const f of failures) {
      console.error(`  - ${f.name}`);
    }
    process.exit(1);
  }

  console.log(`\nALL ${passed} LOCALE INTEGRITY TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
