// Area 7: apply the language-agnostic migrations to a database that HAS ROWS.
//
// Every other harness migrates an empty database. That is exactly how 0034
// shipped with its examples-jsonb UPDATE ordered before the content-trigger
// helpers were repaired: with no rows the UPDATE matched nothing, the trigger
// never fired, and the migration passed. On a real database it aborted with
// "missing FROM-clause entry for table c".
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'migration_with_data', process.platform === 'win32' ? 'run.ps1' : 'run.sh');

console.log('\nArea 7: migrations applied to a seeded database\n');
let out;
try {
  out = process.platform === 'win32'
    ? execFileSync('pwsh', ['-File', runner], { encoding: 'utf8', stdio: 'pipe' })
    : execFileSync('bash', [runner], { encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  console.error(`${error.stdout || ''}${error.stderr || ''}`);
  console.error('\n  x T1: migrations failed against a database containing rows\n');
  process.exit(1);
}

if (!out.includes('ALL MIGRATION-WITH-DATA TESTS PASSED')) {
  console.error(out);
  console.error('\n  x T1: harness did not report success\n');
  process.exit(1);
}

for (const line of out.split('\n').filter((l) => l.includes('PASS T'))) {
  console.log(`  ${line.slice(line.indexOf('PASS T')).replace('PASS ', '\u2713 ')}`);
}
console.log('\nALL 1 MIGRATION-WITH-DATA SUITES PASSED\n');
