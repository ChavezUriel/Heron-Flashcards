#!/usr/bin/env node
// Area 6: Database-Level Contracts & View Immutability Tests
// Runs the throwaway Postgres harness (run.ps1 / run.sh) to verify:
//   1. RPC payloads (get_deck_preview, get_deck_cards_for_ai, get_home_decks,
//      get_market_decks) carry language_from and language_to on decks and cards.
//   2. public.cards_legacy view is genuinely read-only (INSERT, UPDATE, DELETE fail).
//
//   node supabase/tests/run_area6_database_contracts.mjs

import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('Area 6: Database contract tests (PostgreSQL harness)');

  await test('T1: Database harness runs successfully and verifies language pair RPC payloads and read-only cards_legacy', async () => {
    const isWindows = process.platform === 'win32';
    const testDir = path.resolve('supabase/tests/database_contract');
    const scriptPath = isWindows
      ? path.join(testDir, 'run.ps1')
      : path.join(testDir, 'run.sh');

    console.log(`    Running database harness (${isWindows ? 'PowerShell' : 'Bash'})...`);

    const result = isWindows
      ? spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120000,
        })
      : spawnSync('bash', [scriptPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120000,
        });

    if (result.error) {
      throw result.error;
    }

    const output = (result.stdout || '') + (result.stderr || '');

    assert.ok(
      output.includes('PASS T1: get_deck_preview carries language_from and language_to on deck and cards'),
      'Harness did not complete T1'
    );
    assert.ok(
      output.includes('PASS T2: get_deck_cards_for_ai carries language_from and language_to on cards'),
      'Harness did not complete T2'
    );
    assert.ok(
      output.includes('PASS T3: get_home_decks carries language_from and language_to'),
      'Harness did not complete T3'
    );
    assert.ok(
      output.includes('PASS T4: get_market_decks carries language_from and language_to'),
      'Harness did not complete T4'
    );
    assert.ok(
      output.includes('PASS T5: public.cards_legacy select reads legacy column aliases'),
      'Harness did not complete T5'
    );
    assert.ok(
      output.includes('PASS T6a: authenticated cannot INSERT into cards_legacy'),
      'Harness did not complete T6a'
    );
    assert.ok(
      output.includes('PASS T6b: authenticated cannot UPDATE cards_legacy'),
      'Harness did not complete T6b'
    );
    assert.ok(
      output.includes('PASS T6c: authenticated cannot DELETE from cards_legacy'),
      'Harness did not complete T6c'
    );
    assert.ok(
      output.includes('PASS T6d: anon cannot INSERT into cards_legacy'),
      'Harness did not complete T6d'
    );
    assert.ok(
      output.includes('PASS T6e: anon cannot UPDATE cards_legacy'),
      'Harness did not complete T6e'
    );
    assert.ok(
      output.includes('ALL DATABASE CONTRACT TESTS PASSED'),
      'Harness did not output final success message'
    );
    assert.strictEqual(result.status, 0, `Harness exited with non-zero code ${result.status}`);
  });

  console.log(`\nALL ${passed} DATABASE CONTRACT TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
