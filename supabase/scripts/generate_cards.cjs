#!/usr/bin/env node
// AI flashcard generator for DuoCards Clone (Ollama gpt-oss:20b).
//
// Produces / enriches Spanish->English flashcards in the enriched seed-JSON shape
// that supabase/scripts/generate_seed.cjs consumes. Apply with:
//   node supabase/scripts/generate_cards.cjs <command> ...   # write seed_data/*.json
//   node supabase/scripts/generate_seed.cjs                   # compile seed.sql
//
// Commands:
//   generate --spec <file>            Create a new deck from a topic spec.
//   enrich   --slug <slug>            Fill metadata on an existing seed_data deck.
//   review   --slug <slug>            Validate an existing deck; report issues.
//
// Common flags:
//   --limit N        Cap the number of cards processed (cheap smoke tests).
//   --preview        Print results; do NOT write any file.
//   --only-missing   (enrich) Only enrich cards missing metadata. Default: all.
//   --repair         (review) Re-run failing sub-prompts and rewrite the deck.
//   --max-repairs N  Repair attempts per card (default 2).
//   --out <file>     (generate) Output file (default: deck_expansions_generated.json).
//   --model NAME     Model override (default depends on provider).
//   --provider NAME  LLM provider: ollama (default) | go (OpenCode Go) | gemini.
//   --api-key KEY    Cloud provider API key (or set OPENCODE_GO_API_KEY/GEMINI_API_KEY).
//   --base-url URL   Provider base URL override.
//   --checkpoint N   (enrich/generate) Persist the deck file every N enriched
//                   cards so an interrupted run can be resumed without losing
//                   progress. Default 10; 0 disables checkpoint writes.
//
// Quality strategy: light model => many small focused prompts. Cards go through
// lib/enrich.cjs processCard(): deterministic gap-fill sub-prompts (lexical /
// equivalents / examples / synonyms / cloze distractors) plus LLM-as-judge
// audits (example theme fit + blank inferability; cloze solvability), with only
// the failing sub-prompt re-run during repair. To bring EVERY deck up to the
// current feature set in one go, use update_cards.cjs instead.

const fs = require('fs');
const path = require('path');

// Set provider env BEFORE requiring lib/ollama.cjs (it reads them at require
// time). Done with a tiny argv scan here; full flag parsing happens in main().
(function preParse() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') { process.env.OLLAMA_PROVIDER = argv[++i]; }
    else if (a === '--api-key') { process.env.OLLAMA_API_KEY = argv[++i]; }
    else if (a === '--base-url') { process.env.OLLAMA_BASE_URL = argv[++i]; }
    else if (a === '--model') { process.env.OLLAMA_MODEL = argv[++i]; }
  }
})();

const { chatJson, MODEL, BASE_URL, PROVIDER } = require('./lib/ollama.cjs');
const { blueprintPrompt, wordSetPrompt, PROMPT_VERSIONS } = require('./lib/prompts.cjs');
const { hasIssues, flatten } = require('./lib/validate.cjs');
const { processCard, cardStatus } = require('./lib/enrich.cjs');
const { optText, normList, normCard, pairKey } = require('./lib/cards.cjs');
const SEED_DECKS = require('./lib/seed_decks.cjs');

const DATA_DIR = path.resolve(__dirname, '../seed_data');
const GENERATED_FILE = path.join(DATA_DIR, 'deck_expansions_generated.json');

// Persist the deck file every N enriched cards so an interrupted (--only-missing)
// run can be resumed without losing progress. 0 = only write at the very end.
const DEFAULT_CHECKPOINT = 10;

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
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

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// seed_data file IO
// ---------------------------------------------------------------------------
function listExpansionFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^deck_expansions.*\.json$/.test(f))
    .sort();
}

function readJsonArray(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(payload)) throw new Error(`${path.basename(file)} must be a JSON array`);
  return payload;
}

// Find a deck by slug: search seed_data files first (writable), then SEED_DECKS.
function resolveDeck(slug) {
  for (const name of listExpansionFiles()) {
    const file = path.join(DATA_DIR, name);
    const arr = readJsonArray(file);
    const idx = arr.findIndex((d) => optText(d.slug) === slug);
    if (idx !== -1) return { source: 'file', file, array: arr, index: idx, deck: arr[idx] };
  }
  const seed = SEED_DECKS.find((d) => optText(d.slug) === slug);
  if (seed) return { source: 'seed', deck: seed };
  return null;
}

// Deck context handed to the theme-aware prompts (examples / audits /
// distractors). For `generate` the topic spec itself is richer (topic,
// difficulty, learner_profile) and is used directly instead.
function deckContextOf(deck) {
  return {
    slug: optText(deck.slug),
    title: optText(deck.title) || optText(deck.slug),
    description: optText(deck.description) || '',
  };
}

// Upsert a single deck entry (by slug) into an array-shaped seed_data file.
function upsertDeckFile(file, deckEntry) {
  let arr = [];
  if (fs.existsSync(file)) arr = readJsonArray(file);
  const idx = arr.findIndex((d) => optText(d.slug) === deckEntry.slug);
  if (idx === -1) arr.push(deckEntry); else arr[idx] = deckEntry;
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

// Atomic checkpoint write: serialize the deck to its resolved file. Used by
// enrich/generate every --checkpoint cards so a Ctrl+C keeps the work done so
// far. Writes to a tmp file first then renames, so a crash mid-write never
// corrupts the on-disk deck.
function flushResolved(resolved) {
  const tmp = resolved.file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(resolved.array, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, resolved.file);
}

// Enriched working card (l1_text/...) -> seed-JSON card (spanish/english/...).
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
  // Example pairs (migration 0019); the legacy example_* fields mirror pair 0.
  out.examples = (Array.isArray(card.examples) ? card.examples : [])
    .map((p) => {
      if (!p) return null;
      const es = optText(p.l1 ?? p.es ?? p.example_l1 ?? p.example_es);
      const en = optText(p.l2 ?? p.en ?? p.example_l2 ?? p.example_en);
      return (es && en) ? { es, en } : null;
    })
    .filter(Boolean);
  // example_sentence mirrors the English example (the column the app reads).
  const exL2 = card.example_l2 ?? card.example_en ?? card.example_sentence;
  const exL1 = card.example_l1 ?? card.example_es;
  if (optText(exL2)) out.example_sentence = exL2;
  if (optText(exL1)) out.example_es = exL1;
  if (optText(exL2)) out.example_en = exL2;
  // Kept as data even though the app no longer shows mnemonics.
  const mnemonic = card.l2_mnemonic ?? card.mnemonic_en;
  if (optText(mnemonic)) out.mnemonic_en = mnemonic;
  out.cloze_distractors_en = normList(card.l2_cloze_distractors ?? card.cloze_distractors_en);
  // LLM-audit bookkeeping (JSON only; the seed SQL compilers ignore it).
  if (card._audits && Object.keys(card._audits).length) out._audits = card._audits;
  return out;
}

// ---------------------------------------------------------------------------
// pipeline stages
// ---------------------------------------------------------------------------
async function buildBlueprint(spec) {
  if (Array.isArray(spec.sections) && spec.sections.length) {
    log(`Blueprint: using ${spec.sections.length} section(s) from spec.`);
    return spec.sections;
  }
  log('Blueprint: planning sections with the model...');
  const { system, user, temperature } = blueprintPrompt(spec);
  const resp = await chatJson({ system, user, temperature });
  const sections = Array.isArray(resp.sections) ? resp.sections : [];
  if (!sections.length) {
    // Fall back to a single catch-all section.
    return [{ name: spec.title, communicative_goal: spec.topic || spec.title, lexical_focus: [], target_card_count: spec.target_card_count || 20 }];
  }
  return sections;
}

async function generateWordSet(spec, sections, totalTarget) {
  const cards = [];
  const seen = new Set();
  for (const section of sections) {
    if (cards.length >= totalTarget) break;
    const remaining = totalTarget - cards.length;
    const want = Math.min(remaining, Number(section.target_card_count) || remaining);
    if (want <= 0) continue;
    const mustAvoid = cards.map((c) => `${c.l1_text ?? c.spanish_text} -> ${c.l2_text ?? c.english_text}`);
    log(`  Word set: section "${section.name}" requesting ${want} card(s)...`);
    const { system, user, temperature } = wordSetPrompt(spec, section, want, mustAvoid);
    const resp = await chatJson({ system, user, temperature });
    const raw = Array.isArray(resp.cards) ? resp.cards : [];
    for (const rc of raw) {
      const spanish = optText(rc.spanish);
      const english = optText(rc.english);
      if (!spanish || !english) continue;
      const key = pairKey(spanish, english);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ l1_text: spanish, l2_text: english, section_name: optText(section.name) || spec.title });
      if (cards.length >= totalTarget) break;
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdGenerate(flags) {
  if (!flags.spec) throw new Error('generate requires --spec <file>');
  const specPath = path.isAbsolute(flags.spec) ? flags.spec : path.resolve(process.cwd(), flags.spec);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  for (const k of ['slug', 'title', 'description']) {
    if (!optText(spec[k])) throw new Error(`spec is missing required field: ${k}`);
  }
  const limit = flags.limit ? Number(flags.limit) : null;
  const totalTarget = limit || Number(spec.target_card_count) || 20;
  const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;
  const checkpoint = ('checkpoint' in flags) ? Number(flags.checkpoint) : DEFAULT_CHECKPOINT;
  const writeCheckpoints = !flags.preview && checkpoint > 0;
  const outFile = flags.out
    ? (path.isAbsolute(flags.out) ? flags.out : path.resolve(process.cwd(), flags.out))
    : GENERATED_FILE;

  log(`\nGenerating deck "${spec.slug}" (${PROVIDER}: ${MODEL} @ ${BASE_URL}), target ${totalTarget} card(s).`);
  const sections = await buildBlueprint(spec);
  const drafts = await generateWordSet(spec, sections, totalTarget);
  log(`Drafted ${drafts.length} card(s). Enriching (focused sub-prompts + audits each)...`);
  if (writeCheckpoints) log(`Checkpointing to ${path.basename(outFile)} every ${checkpoint} card(s) — safe to Ctrl+C.`);

  // Re-seed from a previous interrupted run if the output file already has
  // cards for this slug: an existing enriched card skips its own draft, so
  // re-running picks up where it left off.
  const prior = resolveDeck(spec.slug);
  let enriched = [];
  if (prior && prior.source === 'file' && Array.isArray(prior.deck.cards) && prior.deck.cards.length) {
    enriched = prior.deck.cards.map((c) => normCard(c, spec.title));
    log(`Resuming: ${enriched.length} already-enriched card(s) found in ${path.basename(prior.file)}.`);
  }

  // Map each draft by pairKey; remove ones already enriched so we don't redo them.
  const seenKeys = new Set(enriched.map((c) => pairKey(c.l1_text ?? c.spanish_text, c.l2_text ?? c.english_text)));
  const todo = drafts.filter((d) => !seenKeys.has(pairKey(d.l1_text ?? d.spanish_text, d.l2_text ?? d.english_text)));

  const rejected = [];
  let sinceFlush = 0;
  function flushCheckpoint() {
    if (!writeCheckpoints) return;
    const partial = {
      slug: spec.slug,
      title: spec.title,
      description: spec.description,
      language_from: optText(spec.language_from) || 'es',
      language_to: optText(spec.language_to) || 'en',
      _meta: {
        generated_by: MODEL,
        generated_at: new Date().toISOString(),
        prompt_versions: PROMPT_VERSIONS,
      },
      cards: enriched.map(toSeedCard),
    };
    // Wrap into a resolved-shape { file, array, index } so flushResolved can write it.
    upsertDeckFile(outFile, partial);
    log(`    checkpoint: wrote ${enriched.length} card(s) to ${path.basename(outFile)}`);
    sinceFlush = 0;
  }

  for (let i = 0; i < todo.length; i++) {
    log(`  [${i + 1}/${todo.length}] ${todo[i].l1_text ?? todo[i].spanish_text} -> ${todo[i].l2_text ?? todo[i].english_text}`);
    const t0 = Date.now();
    // The topic spec is the richest deck context (topic/difficulty/notes).
    const { card, issues } = await processCard(todo[i], { deck: spec, maxRepairs, log });
    log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (hasIssues(issues)) {
      rejected.push({ card, issues: flatten(issues) });
    } else {
      enriched.push(card);
      sinceFlush++;
      if (writeCheckpoints && sinceFlush >= checkpoint) {
        flushCheckpoint();
      }
    }
  }

  const deckEntry = {
    slug: spec.slug,
    title: spec.title,
    description: spec.description,
    language_from: optText(spec.language_from) || 'es',
    language_to: optText(spec.language_to) || 'en',
    _meta: {
      generated_by: MODEL,
      generated_at: new Date().toISOString(),
      prompt_versions: PROMPT_VERSIONS,
    },
    cards: enriched.map(toSeedCard),
  };

  reportRejected(rejected);
  log(`\nDeck "${spec.slug}": ${enriched.length} enriched, ${rejected.length} rejected.`);

  if (flags.preview) {
    log('\n--- PREVIEW (no file written) ---');
    log(JSON.stringify(deckEntry, null, 2));
    return;
  }
  upsertDeckFile(outFile, deckEntry);
  log(`\nWrote deck "${spec.slug}" to ${outFile}`);
  log('Next: node supabase/scripts/generate_seed.cjs  (compile seed.sql)');
}

async function cmdEnrich(flags) {
  if (!flags.slug) throw new Error('enrich requires --slug <slug>');
  const resolved = resolveDeck(flags.slug);
  if (!resolved) throw new Error(`Deck not found in seed_data or starter decks: ${flags.slug}`);
  if (resolved.source === 'seed') {
    throw new Error(`Deck "${flags.slug}" is defined in lib/seed_decks.cjs (already enriched). Edit it there, or move it to seed_data to enrich.`);
  }
  const deck = resolved.deck;
  const deckCtx = deckContextOf(deck);
  const title = optText(deck.title) || flags.slug;
  const rawCards = Array.isArray(deck.cards) ? deck.cards : [];
  const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;
  const onlyMissing = !!flags['only-missing'];
  const limit = flags.limit ? Number(flags.limit) : null;
  const checkpoint = ('checkpoint' in flags) ? Number(flags.checkpoint) : DEFAULT_CHECKPOINT;
  const writeCheckpoints = !flags.preview && checkpoint > 0;

  // Normalize existing cards, decide which to (re)enrich. "Missing" includes
  // stale/unpassed LLM audits, so --only-missing picks up cards whose content
  // changed since their last audit.
  const working = rawCards.map((rc) => normCard(rc, title));
  let targets = working.map((c, idx) => ({ c, idx }));
  if (onlyMissing) targets = targets.filter(({ c }) => hasIssues(cardStatus(c, deckCtx)));
  if (limit) targets = targets.slice(0, limit);

  log(`\nEnriching deck "${flags.slug}" in ${path.basename(resolved.file)}: ${targets.length} of ${working.length} card(s) (${PROVIDER}: ${MODEL}).`);
  if (writeCheckpoints) log(`Checkpointing to disk every ${checkpoint} card(s) — safe to Ctrl+C and re-run with --only-missing.`);

  const rejected = [];
  let sinceFlush = 0;
  for (let t = 0; t < targets.length; t++) {
    const { c, idx } = targets[t];
    log(`  [${t + 1}/${targets.length}] ${c.l1_text ?? c.spanish_text} -> ${c.l2_text ?? c.english_text}`);
    const t0 = Date.now();
    const { card, issues } = await processCard(c, { deck: deckCtx, maxRepairs, log });
    log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    working[idx] = card; // replace in place (keeps card order)
    if (hasIssues(issues)) rejected.push({ card, issues: flatten(issues) });
    sinceFlush++;
    if (writeCheckpoints && sinceFlush >= checkpoint) {
      resolved.array[resolved.index] = { ...deck, cards: working.map(toSeedCard) };
      flushResolved(resolved);
      log(`    checkpoint: wrote ${sinceFlush} enriched card(s) to ${path.basename(resolved.file)}`);
      sinceFlush = 0;
    }
  }
  reportRejected(rejected);

  const newCards = working.map(toSeedCard);
  if (flags.preview) {
    log('\n--- PREVIEW (no file written) ---');
    log(JSON.stringify(newCards, null, 2));
    return;
  }
  resolved.array[resolved.index] = {
    ...deck,
    cards: newCards,
  };
  flushResolved(resolved);
  log(`\nUpdated ${targets.length} card(s) in ${resolved.file}`);
  log('Next: node supabase/scripts/generate_seed.cjs  (compile seed.sql)');
}

async function cmdReview(flags) {
  if (!flags.slug) throw new Error('review requires --slug <slug>');
  const resolved = resolveDeck(flags.slug);
  if (!resolved) throw new Error(`Deck not found: ${flags.slug}`);
  const deck = resolved.deck;
  const deckCtx = deckContextOf(deck);
  const title = optText(deck.title) || flags.slug;
  const working = (Array.isArray(deck.cards) ? deck.cards : []).map((rc) => normCard(rc, title));

  let bad = 0;
  log(`\nReviewing deck "${flags.slug}" (${working.length} cards, source: ${resolved.source}).`);
  const failing = [];
  working.forEach((card, i) => {
    const issues = cardStatus(card, deckCtx);
    if (hasIssues(issues)) {
      bad++;
      failing.push(i);
      log(`  ✗ [${i + 1}] ${card.l1_text ?? card.spanish_text} -> ${card.l2_text ?? card.english_text}`);
      flatten(issues).forEach((m) => log(`      - ${m}`));
    }
  });
  log(`\n${working.length - bad}/${working.length} cards OK, ${bad} with issues.`);

  if (bad && flags.repair) {
    if (resolved.source !== 'file') {
      log('Cannot --repair: deck is defined in lib/seed_decks.cjs, not seed_data.');
      return;
    }
    const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;
    log(`\nRepairing ${failing.length} card(s)...`);
    for (const i of failing) {
      log(`  ${working[i].l1_text ?? working[i].spanish_text} -> ${working[i].l2_text ?? working[i].english_text}`);
      const t0 = Date.now();
      const { card } = await processCard(working[i], { deck: deckCtx, maxRepairs, log });
      log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      working[i] = card;
    }
    resolved.array[resolved.index] = { ...deck, cards: working.map(toSeedCard) };
    fs.writeFileSync(resolved.file, JSON.stringify(resolved.array, null, 2) + '\n', 'utf8');
    log(`\nRewrote ${resolved.file}`);
    log('Next: node supabase/scripts/generate_seed.cjs  (compile seed.sql)');
  }
}

function reportRejected(rejected) {
  if (!rejected.length) return;
  log(`\n${rejected.length} card(s) still have issues after repair:`);
  for (const r of rejected) {
    log(`  ✗ ${r.card.l1_text ?? r.card.spanish_text} -> ${r.card.l2_text ?? r.card.english_text}: ${r.issues.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
async function main() {
  const command = process.argv[2];
  const flags = parseArgs(process.argv.slice(3));
  switch (command) {
    case 'generate': return cmdGenerate(flags);
    case 'enrich': return cmdEnrich(flags);
    case 'review': return cmdReview(flags);
    default:
      log('Usage: node supabase/scripts/generate_cards.cjs <generate|enrich|review> [flags]');
      log('  generate --spec <file> [--limit N] [--preview] [--out <file>] [--max-repairs N] [--checkpoint N]');
      log('  enrich   --slug <slug> [--only-missing] [--limit N] [--preview] [--max-repairs N] [--checkpoint N]');
      log('  review   --slug <slug> [--repair] [--max-repairs N]');
      log('To sweep EVERY deck up to the current feature set: node supabase/scripts/update_cards.cjs');
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
