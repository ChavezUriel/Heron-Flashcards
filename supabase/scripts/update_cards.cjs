#!/usr/bin/env node
// Bring EVERY seed deck up to the app's current card feature set.
//
// This is the one command to run after a new card feature ships: it walks all
// seed_data decks, reports which cards are missing which feature, and (unless
// --dry-run) runs the shared enrichment/audit pipeline (lib/enrich.cjs) on
// exactly the cards that need work. Results are checkpointed back into the
// seed_data JSON, ready for the seed compilers.
//
//   node supabase/scripts/update_cards.cjs --dry-run          # report only (no LLM)
//   node supabase/scripts/update_cards.cjs                    # update everything
//   node supabase/scripts/update_cards.cjs --decks travel     # restrict decks
//   node supabase/scripts/update_cards.cjs --compile          # + regenerate seed SQL
//
// Flags:
//   --dry-run          Report per-deck/per-feature gaps; touch nothing.
//   --decks a,b        Only these deck slugs (default: all seed_data decks).
//   --features a,b     Only select cards failing these features (see FEATURES
//                      below; default: all). Deterministic field gaps are always
//                      fixed on a selected card — they are prerequisites.
//   --limit N          Process at most N cards in total this run (smoke tests).
//   --max-repairs N    Per-card repair attempts per audit (default 2).
//   --checkpoint N     Flush a deck's file every N processed cards (default 10).
//   --model NAME       Model override (sets OLLAMA_MODEL; default depends on provider).
//   --provider NAME    LLM provider: ollama (default) | go (OpenCode Go) | gemini.
//   --api-key KEY      Cloud provider API key (sets OLLAMA_API_KEY; prefer env).
//   --base-url URL     Provider base URL override (sets OLLAMA_BASE_URL).
//   --compile          After updating, run generate_seed.cjs + generate_update.cjs.
//
// Adding a NEW card feature later:
//   1. teach lib/validate.cjs (deterministic shape) and/or lib/prompts.cjs +
//      lib/enrich.cjs (generation prompt / LLM audit) about it;
//   2. add one entry to FEATURES below so it is reported and selectable;
//   3. run this script (then apply supabase/seed_updates.sql to the live DB).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Parse flags BEFORE requiring the Ollama-backed modules: lib/ollama.cjs reads
// OLLAMA_MODEL / OLLAMA_PROVIDER / OLLAMA_BASE_URL / OLLAMA_API_KEY at require
// time, so these flags must be in the env first.
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}
const flags = parseArgs(process.argv.slice(2));
if (typeof flags.model === 'string' && flags.model.trim()) {
  process.env.OLLAMA_MODEL = flags.model.trim();
}
if (typeof flags.provider === 'string' && flags.provider.trim()) {
  process.env.OLLAMA_PROVIDER = flags.provider.trim();
}
if (typeof flags['api-key'] === 'string' && flags['api-key'].trim()) {
  process.env.OLLAMA_API_KEY = flags['api-key'].trim();
}
if (typeof flags['base-url'] === 'string' && flags['base-url'].trim()) {
  process.env.OLLAMA_BASE_URL = flags['base-url'].trim();
}

const { optText, normCard, normList } = require('./lib/cards.cjs');
const { validateCard } = require('./lib/validate.cjs');
const { processCard, cardStatus } = require('./lib/enrich.cjs');
const { MODEL, BASE_URL, PROVIDER } = require('./lib/ollama.cjs');
const SEED_DECKS = require('./lib/seed_decks.cjs');

const DATA_DIR = path.resolve(__dirname, '../seed_data');
const SCRIPTS_DIR = __dirname;
const DEFAULT_CHECKPOINT = 10;

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Feature registry — the app's COMPLETE current card feature set.
// Each feature answers "what does this card still need?" with reason strings
// (empty array = satisfied). `reasons` must stay LLM-free: the dry-run report
// and card selection call it for every card.
// ---------------------------------------------------------------------------
const FEATURES = [
  {
    id: 'fields',
    title: 'Core fields: lexical metadata, equivalents, synonyms',
    reasons: (card) => {
      const v = validateCard(card);
      return [...v.card, ...v.lexical, ...v.equivalents, ...v.synonyms];
    },
  },
  {
    id: 'examples',
    title: '3+ blankable example sentence pairs (fill-in-the-blank variety, migration 0019)',
    reasons: (card) => validateCard(card).examples,
  },
  {
    id: 'cloze-options',
    title: 'Curated cloze distractors for the word-bank cloze (migration 0018)',
    reasons: (card) => validateCard(card).clozeDistractors,
  },
  {
    id: 'example-audit',
    title: 'LLM audit: examples fit the deck theme and imply the blanked answer',
    reasons: (card, deckCtx) =>
      cardStatus(card, deckCtx, { auditFields: false, auditExamples: true, auditCloze: false, wantCloze: false }).audits,
  },
  {
    id: 'cloze-audit',
    title: 'LLM audit: only the real answer fits the blank among the options',
    reasons: (card, deckCtx) =>
      cardStatus(card, deckCtx, { auditFields: false, auditExamples: false, auditCloze: true, wantCloze: true }).audits,
  },
  {
    id: 'field-audit',
    title: 'LLM audit: part of speech, definition, translations, collocations, and synonyms are accurate for this sense',
    reasons: (card, deckCtx) =>
      cardStatus(card, deckCtx, { auditFields: true, auditExamples: false, auditCloze: false, wantCloze: false }).audits,
  },
];

// ---------------------------------------------------------------------------
// seed_data IO (same shapes as generate_cards.cjs)
// ---------------------------------------------------------------------------
function listExpansionFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^deck_expansions.*\.json$/.test(f))
    .sort();
}

function toSeedCard(card) {
  const spanish = card.l1_text ?? card.spanish_text ?? card.spanish;
  const english = card.l2_text ?? card.english_text ?? card.english;
  const out = { spanish, english };
  if (optText(card.section_name)) out.section_name = card.section_name;
  if (optText(card.part_of_speech)) out.part_of_speech = card.part_of_speech;
  const def = card.l2_definition ?? card.definition_en;
  if (optText(def)) out.definition_en = def;
  out.main_translations_es = normList(card.l1_translations ?? card.main_translations_es);
  out.collocations = normList(card.collocations);
  out.synonyms_en = normList(card.l2_synonyms ?? card.synonyms_en);
  out.examples = (Array.isArray(card.examples) ? card.examples : [])
    .map((p) => {
      if (!p) return null;
      const es = optText(p.l1 ?? p.es ?? p.example_l1 ?? p.example_es);
      const en = optText(p.l2 ?? p.en ?? p.example_l2 ?? p.example_en);
      return (es && en) ? { es, en } : null;
    })
    .filter(Boolean);
  const exL2 = card.example_l2 ?? card.example_en ?? card.example_sentence;
  const exL1 = card.example_l1 ?? card.example_es;
  if (optText(exL2)) out.example_sentence = exL2;
  if (optText(exL1)) out.example_es = exL1;
  if (optText(exL2)) out.example_en = exL2;
  const mnemonic = card.l2_mnemonic ?? card.mnemonic_en;
  if (optText(mnemonic)) out.mnemonic_en = mnemonic;
  out.cloze_distractors_en = normList(card.l2_cloze_distractors ?? card.cloze_distractors_en);
  if (card._audits && Object.keys(card._audits).length) out._audits = card._audits;
  return out;
}

// Load every deck from seed_data, keeping (file, index) so updates can be
// written back in place. First slug occurrence wins, matching the compilers.
function loadDecks() {
  const decks = [];
  const seen = new Set();
  const fileCache = new Map(); // file path -> parsed array (shared per file)
  for (const name of listExpansionFiles()) {
    const file = path.join(DATA_DIR, name);
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) throw new Error(`${name} must be a JSON array`);
    fileCache.set(file, arr);
    arr.forEach((d, index) => {
      const slug = optText(d.slug);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      decks.push({ slug, file, index, deck: d });
    });
  }
  // Anything still living only in lib/seed_decks.cjs cannot be written back.
  for (const d of SEED_DECKS) {
    const slug = optText(d.slug);
    if (slug && !seen.has(slug)) {
      log(`! Deck "${slug}" lives in lib/seed_decks.cjs and cannot be updated by this script — move it into seed_data.`);
    }
  }
  return { decks, fileCache };
}

function atomicWrite(file, arr) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const dryRun = !!flags['dry-run'];
  const onlySlugs = typeof flags.decks === 'string'
    ? new Set(flags.decks.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const selectedIds = typeof flags.features === 'string'
    ? flags.features.split(',').map((s) => s.trim()).filter(Boolean)
    : FEATURES.map((f) => f.id);
  const unknown = selectedIds.filter((id) => !FEATURES.some((f) => f.id === id));
  if (unknown.length) {
    throw new Error(`Unknown feature(s): ${unknown.join(', ')}. Known: ${FEATURES.map((f) => f.id).join(', ')}`);
  }
  const selected = FEATURES.filter((f) => selectedIds.includes(f.id));
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;
  const checkpoint = ('checkpoint' in flags) ? Number(flags.checkpoint) : DEFAULT_CHECKPOINT;

  // Pipeline gates derived from the selected features. Deterministic field
  // fixes always run on a selected card (they are prerequisites for audits).
  const gates = {
    auditFields: selectedIds.includes('field-audit'),
    auditExamples: selectedIds.includes('example-audit'),
    auditCloze: selectedIds.includes('cloze-audit'),
    wantCloze: selectedIds.includes('cloze-options') || selectedIds.includes('cloze-audit'),
  };

  const { decks, fileCache } = loadDecks();
  const targetDecks = decks.filter((d) => !onlySlugs || onlySlugs.has(d.slug));
  if (onlySlugs) {
    for (const slug of onlySlugs) {
      if (!targetDecks.some((d) => d.slug === slug)) log(`! Deck not found in seed_data: ${slug}`);
    }
  }

  log(`Card feature updater — ${selected.length}/${FEATURES.length} feature(s), ${targetDecks.length} deck(s)${dryRun ? ' [dry-run]' : ` (${PROVIDER}: ${MODEL} @ ${BASE_URL})`}.`);
  for (const f of selected) log(`  * ${f.id}: ${f.title}`);

  // ---- report + selection ----
  let totalNeeding = 0;
  const plans = []; // { deckRef, deckCtx, working, targets: [indexes] }
  for (const ref of targetDecks) {
    const title = optText(ref.deck.title) || ref.slug;
    const deckCtx = { slug: ref.slug, title, description: optText(ref.deck.description) || '' };
    const working = (Array.isArray(ref.deck.cards) ? ref.deck.cards : []).map((c) => normCard(c, title));
    const perFeature = new Map(selected.map((f) => [f.id, 0]));
    const targets = [];
    working.forEach((card, idx) => {
      let needs = false;
      for (const f of selected) {
        const reasons = f.reasons(card, deckCtx);
        if (reasons.length) {
          perFeature.set(f.id, perFeature.get(f.id) + 1);
          needs = true;
        }
      }
      if (needs) targets.push(idx);
    });
    totalNeeding += targets.length;
    const summary = selected.map((f) => `${f.id} ${perFeature.get(f.id)}`).join(', ');
    log(`\n${ref.slug}: ${targets.length}/${working.length} card(s) need work  [${summary}]`);
    if (targets.length) plans.push({ ref, deckCtx, working, targets });
  }

  if (dryRun) {
    log(`\n--dry-run: ${totalNeeding} card(s) across ${plans.length} deck(s) would be processed.`);
    return;
  }
  if (!totalNeeding) {
    log('\nAll decks already meet the current feature set — nothing to do.');
    return;
  }

  // ---- processing ----
  let processedTotal = 0;
  let stillFailing = 0;
  for (const plan of plans) {
    if (processedTotal >= limit) break;
    const { ref, deckCtx, working, targets } = plan;
    log(`\n=== ${ref.slug} (${targets.length} card(s)) ===`);
    let sinceFlush = 0;
    let processedHere = 0;

    const flush = () => {
      const arr = fileCache.get(ref.file);
      arr[ref.index] = { ...ref.deck, cards: working.map(toSeedCard) };
      atomicWrite(ref.file, arr);
      sinceFlush = 0;
    };

    const advance = () => {
      processedTotal++;
      processedHere++;
      sinceFlush++;
      if (checkpoint > 0 && sinceFlush >= checkpoint) {
        flush();
        log(`    checkpoint: wrote ${ref.slug} to ${path.basename(ref.file)} — safe to Ctrl+C and re-run.`);
      }
    };

    for (const idx of targets) {
      if (processedTotal >= limit) break;
      const c = working[idx];
      log(`  [${processedHere + 1}/${targets.length}] ${c.l1_text ?? c.spanish_text} -> ${c.l2_text ?? c.english_text}`);
      const t0 = Date.now();
      let result;
      try {
        result = await processCard(c, { deck: deckCtx, maxRepairs, log, ...gates });
      } catch (err) {
        if (!/chat failed after \d+ attempt\(s\):.*did not return valid JSON/.test(err.message)) throw err;
        log(`    ✗ failed attempt (model returned no JSON): ${err.message.split('\n')[0]}`);
        stillFailing++;
        advance();
        continue;
      }
      log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      working[idx] = result.card;
      advance();
      const remaining = selected.flatMap((f) => f.reasons(result.card, deckCtx));
      if (remaining.length) {
        stillFailing++;
        log(`    ✗ still failing: ${remaining.join('; ')}`);
      }
    }
    if (sinceFlush > 0 || processedHere > 0) flush();
    log(`  wrote ${ref.slug} to ${path.basename(ref.file)}`);
  }

  log(`\nProcessed ${processedTotal} card(s); ${processedTotal - stillFailing} clean, ${stillFailing} still failing (re-run or raise --max-repairs).`);

  // ---- compile + next steps ----
  if (flags.compile) {
    for (const script of ['generate_seed.cjs', 'generate_update.cjs']) {
      log(`\n== node supabase/scripts/${script}`);
      const r = spawnSync('node', [path.join(SCRIPTS_DIR, script)], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`${script} exited with status ${r.status}`);
    }
    log('\nDone. Apply to a live DB with:');
    log('  psql "<connection string>" -f supabase/seed.sql          # new decks/cards');
    log('  psql "<connection string>" -f supabase/seed_updates.sql  # metadata on existing cards');
  } else {
    log('\nNext: node supabase/scripts/update_cards.cjs --compile   (or run generate_seed.cjs + generate_update.cjs)');
  }

  process.exitCode = stillFailing ? 1 : 0;
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
