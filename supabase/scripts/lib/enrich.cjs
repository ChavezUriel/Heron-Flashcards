// Card enrichment + LLM-audit engine, shared by generate_cards.cjs and
// update_cards.cjs so every entry point brings a card to the SAME "current
// feature set" (see update_cards.cjs for the feature registry).
//
// processCard() runs two layers until stable:
//   1. deterministic gap-fill — validateCard() names the failing groups
//      (lexical / equivalents / examples / synonyms / clozeDistractors) and only
//      those sub-prompts run, so curated fields are never overwritten. The
//      examples group covers the 3-pair set (each pair blankable: the answer
//      appears verbatim so the cloze games can blank it);
//   2. LLM-as-judge audits — example quality (theme fit + blank inferability,
//      judged PER PAIR with targeted single-pair rewrites) and cloze
//      solvability (a blind examiner solves EVERY sentence; only the real
//      answer may fit). A failed verdict is fed back into the matching
//      enrichment prompt as repair issues.
//
// Audit passes are recorded in card._audits[key] = { version, fingerprint,
// status, checked_at }. The fingerprint hashes the audited content, so editing
// a field (or bumping the audit's PROMPT_VERSIONS entry) automatically makes
// the audit stale — that is what lets update_cards.cjs re-run cheaply and only
// spend LLM time where something actually changed. _audits lives only in the
// seed_data JSON; the seed SQL compilers never emit it.

const path = require('path');
const { chatJson } = require('./ollama.cjs');
const {
  PROMPT_VERSIONS,
  getPromptVersions,
  resolvePairDescriptor,
  lexicalPrompt,
  equivalentsPrompt,
  examplesPrompt,
  exampleRewritePrompt,
  synonymsPrompt,
  clozeDistractorsPrompt,
  exampleAuditPrompt,
  clozeSolvePrompt,
  fieldAuditPrompt,
} = require('./prompts.cjs');
const { validateCard, CLOZE_DISTRACTORS_MIN, CLOZE_DISTRACTORS_MAX, EXAMPLES_MAX } = require('./validate.cjs');
const { optText, normList } = require('./cards.cjs');
const { normalizeAnswer, locateAnswerInExample, blankedExample, contentHash } = require('./minigame_text.cjs');
const { getLanguage } = require(path.resolve(__dirname, '../../../frontend/src/languages.js'));

function getAuditVersions(pair) {
  const versions = getPromptVersions(pair);
  return {
    field_quality: versions.fieldAudit,
    example_quality: versions.exampleAudit,
    cloze_options: versions.clozeSolve,
  };
}

const AUDIT_VERSIONS = {
  field_quality: PROMPT_VERSIONS.fieldAudit,
  example_quality: PROMPT_VERSIONS.exampleAudit,
  cloze_options: PROMPT_VERSIONS.clozeSolve,
  forPair: getAuditVersions,
};

function defaultRunPrompt(p) {
  return chatJson({ system: p.system, user: p.user, temperature: p.temperature });
}

// ---------------------------------------------------------------------------
// audit bookkeeping
// ---------------------------------------------------------------------------
function examplePairs(card) {
  return Array.isArray(card.examples) ? card.examples : [];
}

// Content fingerprints: any change to an audited field (or to the deck's theme
// text, for the example audit) invalidates the stored pass.
// Control byte \u0000 is used instead of a space as separator so that moving text
// between adjacent fields/list items changes the hash and triggers re-audit.
function fieldFingerprint(deck, card, pair) {
  const resolved = resolvePairDescriptor(pair, card || deck);
  const pairTag = (resolved.l1 === 'es' && resolved.l2 === 'en') ? '' : `${resolved.l1}->${resolved.l2}`;
  return contentHash([
    ...(pairTag ? [pairTag] : []),
    deck?.title ?? '', deck?.description ?? '',
    card.l1_text ?? card.prompt_l1 ?? card.spanish_text ?? '',
    card.l2_text ?? card.answer_l2 ?? card.english_text ?? '',
    card.part_of_speech ?? '',
    card.l2_definition ?? card.definition_en ?? '',
    ...(Array.isArray(card.l1_translations ?? card.main_translations_es) ? (card.l1_translations ?? card.main_translations_es) : []),
    ...(Array.isArray(card.collocations) ? card.collocations : []),
    ...(Array.isArray(card.l2_synonyms ?? card.synonyms_en) ? (card.l2_synonyms ?? card.synonyms_en) : []),
  ].join('\u0000'));
}

function exampleFingerprint(deck, card, pair) {
  const resolved = resolvePairDescriptor(pair, card || deck);
  const pairTag = (resolved.l1 === 'es' && resolved.l2 === 'en') ? '' : `${resolved.l1}->${resolved.l2}`;
  return contentHash([
    ...(pairTag ? [pairTag] : []),
    deck?.title ?? '', deck?.description ?? '',
    card.l1_text ?? card.prompt_l1 ?? card.spanish_text ?? '',
    card.l2_text ?? card.answer_l2 ?? card.english_text ?? '',
    ...examplePairs(card).flatMap((p) => [p?.l1 ?? p?.es ?? '', p?.l2 ?? p?.en ?? '']),
  ].join('\u0000'));
}

function clozeFingerprint(card, pair) {
  const resolved = resolvePairDescriptor(pair, card);
  const pairTag = (resolved.l1 === 'es' && resolved.l2 === 'en') ? '' : `${resolved.l1}->${resolved.l2}`;
  const rawDistractors = card.l2_cloze_distractors ?? card.cloze_distractors_en;
  const opts = (Array.isArray(rawDistractors) ? rawDistractors : [])
    .map((o) => normalizeAnswer(String(o))).sort();
  return contentHash([
    ...(pairTag ? [pairTag] : []),
    card.l2_text ?? card.answer_l2 ?? card.english_text ?? '',
    ...examplePairs(card).map((p) => p?.l2 ?? p?.en ?? ''),
    ...opts,
  ].join('\u0000'));
}

function auditFresh(card, key, fingerprint, pair) {
  const a = card._audits && card._audits[key];
  const versions = getAuditVersions(pair || card);
  return !!a && a.status === 'pass' && a.version === versions[key] && a.fingerprint === fingerprint;
}

function setAudit(card, key, fingerprint, pair) {
  const versions = getAuditVersions(pair || card);
  card._audits = { ...(card._audits || {}) };
  card._audits[key] = {
    version: versions[key],
    fingerprint,
    status: 'pass',
    checked_at: new Date().toISOString(),
  };
}

function clearAudit(card, key) {
  if (card._audits && card._audits[key]) {
    card._audits = { ...card._audits };
    delete card._audits[key];
  }
}

// ---------------------------------------------------------------------------
// response appliers (lenient in, strict out — validateCard re-checks after)
// ---------------------------------------------------------------------------
function applyLexical(card, resp) {
  card.part_of_speech = optText(resp?.part_of_speech);
  const def = optText(resp?.l2_definition ?? resp?.definition_en);
  card.l2_definition = def;
  card.definition_en = def;
}

function applyEquivalents(card, resp) {
  const translations = normList(resp?.l1_translations ?? resp?.main_translations_es).slice(0, 3);
  card.l1_translations = translations;
  card.main_translations_es = translations;
  card.collocations = normList(resp?.collocations).slice(0, 4);
}

function applySynonyms(card, resp) {
  const syns = normList(resp?.l2_synonyms ?? resp?.synonyms_en).slice(0, 3);
  card.l2_synonyms = syns;
  card.synonyms_en = syns;
}

// The legacy example_es/example_en/example_sentence columns always mirror pair
// 0 — they are what pre-0019 consumers and the 0017 sync hash read.
function mirrorLegacyExample(card) {
  const first = examplePairs(card)[0] || null;
  const l1 = first ? (first.l1 ?? first.es) : null;
  const l2 = first ? (first.l2 ?? first.en) : null;
  card.example_l1 = l1;
  card.example_l2 = l2;
  card.example_es = l1;
  card.example_en = l2;
  card.example_sentence = l2;
}

function normPair(p) {
  if (!p || typeof p !== 'object') return null;
  const l1 = optText(p.l1 ?? p.example_l1 ?? p.es ?? p.example_es);
  const l2 = optText(p.l2 ?? p.example_l2 ?? p.en ?? p.example_en);
  if (!l1 || !l2) return null;
  const out = { l1, l2 };
  Object.defineProperty(out, 'es', { get() { return this.l1; }, configurable: true, enumerable: false });
  Object.defineProperty(out, 'en', { get() { return this.l2; }, configurable: true, enumerable: false });
  return out;
}

// Full-set response ({ examples: [{example_l1, example_l2}] }).
function applyExamples(card, resp) {
  const seen = new Set();
  const pairs = [];
  for (const raw of Array.isArray(resp?.examples) ? resp.examples : []) {
    const p = normPair(raw);
    if (!p) continue;
    const k = normalizeAnswer(p.l2);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    pairs.push(p);
    if (pairs.length >= EXAMPLES_MAX) break;
  }
  card.examples = pairs;
  mirrorLegacyExample(card);
}

// Single-pair rewrite response ({ example_l1, example_l2 }) for pair `index`.
function applyExampleRewrite(card, index, resp) {
  const p = normPair(resp);
  if (!p) return; // validator/audit will flag and retry
  const pairs = [...examplePairs(card)];
  if (index < 0 || index >= pairs.length) return;
  pairs[index] = p;
  card.examples = pairs;
  mirrorLegacyExample(card);
}

// Distractor candidates are pre-filtered here (answer/synonym restatements,
// words already in any sentence, oversized items) so one bad candidate out of
// five doesn't fail the whole set.
function applyClozeDistractors(card, resp) {
  const answer = card.l2_text ?? card.english_text;
  const syns = Array.isArray(card.l2_synonyms ?? card.synonyms_en) ? (card.l2_synonyms ?? card.synonyms_en) : [];
  const answerForms = new Set(
    [answer, ...syns]
      .map((s) => normalizeAnswer(String(s ?? ''))).filter(Boolean),
  );
  const sentences = examplePairs(card).map((p) => p?.l2 ?? p?.en ?? '').filter(Boolean);
  const rawList = normList(resp?.l2_cloze_distractors ?? resp?.cloze_distractors_en);
  const filtered = rawList
    .filter((o) => !answerForms.has(normalizeAnswer(o)))
    .filter((o) => o.length <= 60)
    .filter((o) => sentences.every((en) => locateAnswerInExample(en, o) === null))
    .slice(0, CLOZE_DISTRACTORS_MAX);
  card.l2_cloze_distractors = filtered;
  card.cloze_distractors_en = filtered;
}

// ---------------------------------------------------------------------------
// audit verdict interpretation
// ---------------------------------------------------------------------------
function passes(v) {
  return v === true || String(v ?? '').trim().toLowerCase() === 'pass';
}

function interpretFieldVerdict(resp) {
  const pairCorrect = passes(resp?.pair_correct);
  const rawPairIssues = normList(resp?.pair_issues);

  const mismatchType = resp?.mismatch_type
    ? String(resp.mismatch_type).trim().toLowerCase()
    : null;

  const rawFixes = Array.isArray(resp?.proposed_fixes) ? resp.proposed_fixes : [];
  const proposedFixes = rawFixes
    .map((f) => {
      const l1 = String(f?.l1_text ?? f?.spanish_text ?? '').trim();
      const l2 = String(f?.l2_text ?? f?.english_text ?? '').trim();
      return {
        target: f?.target ? String(f.target).trim().toLowerCase() : 'repair',
        l1_text: l1,
        l2_text: l2,
        spanish_text: l1,
        english_text: l2,
        reason: String(f?.reason ?? '').trim(),
      };
    })
    .filter((f) => f.l1_text && f.l2_text);

  const lexicalPass = passes(resp?.lexical?.verdict ?? resp?.lexical);
  const equivalentsPass = passes(resp?.equivalents?.verdict ?? resp?.equivalents);
  const synonymsPass = passes(resp?.synonyms?.verdict ?? resp?.synonyms);

  const lexicalIssues = normList(resp?.lexical?.issues ?? resp?.lexical_issues);
  const equivalentsIssues = normList(resp?.equivalents?.issues ?? resp?.equivalents_issues);
  const synonymsIssues = normList(resp?.synonyms?.issues ?? resp?.synonyms_issues);

  const failingGroups = [];
  if (!lexicalPass || lexicalIssues.length > 0) {
    failingGroups.push('lexical');
    if (!lexicalIssues.length) {
      lexicalIssues.push('part_of_speech or l2_definition is inaccurate or not in target language');
    }
  }
  if (!equivalentsPass || equivalentsIssues.length > 0) {
    failingGroups.push('equivalents');
    if (!equivalentsIssues.length) {
      equivalentsIssues.push('translations or collocations are inaccurate or inconsistent');
    }
  }
  if (!synonymsPass || synonymsIssues.length > 0) {
    failingGroups.push('synonyms');
    if (!synonymsIssues.length) {
      synonymsIssues.push('synonyms are not accurate synonyms in this sense');
    }
  }

  const pairIssues = rawPairIssues.length
    ? rawPairIssues
    : (!pairCorrect ? ['Prompt and answer pair may not be correct translations of each other'] : []);

  return {
    pairCorrect,
    pairIssues,
    mismatchType,
    proposedFixes,
    lexicalPass: !failingGroups.includes('lexical'),
    lexicalIssues,
    equivalentsPass: !failingGroups.includes('equivalents'),
    equivalentsIssues,
    synonymsPass: !failingGroups.includes('synonyms'),
    synonymsIssues,
    failingGroups,
  };
}

async function enrichCandidateCard(draft, { deck, pair, runPrompt, wantCloze = true, signal }) {
  const p = resolvePairDescriptor(pair, deck || draft);
  const c = {
    l1_text: draft.l1_text ?? draft.prompt_l1 ?? draft.spanish_text,
    l2_text: draft.l2_text ?? draft.answer_l2 ?? draft.english_text,
    spanish_text: draft.l1_text ?? draft.prompt_l1 ?? draft.spanish_text,
    english_text: draft.l2_text ?? draft.answer_l2 ?? draft.english_text,
    section_name: draft.section_name ?? null,
    part_of_speech: null,
    l2_definition: null,
    definition_en: null,
    l1_translations: [],
    main_translations_es: [],
    collocations: [],
    l2_synonyms: [],
    synonyms_en: [],
    examples: [],
    example_l1: null,
    example_l2: null,
    example_es: null,
    example_en: null,
    example_sentence: null,
    mnemonic_en: null,
    l2_cloze_distractors: [],
    cloze_distractors_en: [],
  };

  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Aborted');
  };

  try {
    throwIfAborted();
    const lexRes = await runPrompt(lexicalPrompt(c, undefined, p));
    applyLexical(c, lexRes);
  } catch (err) {
    if (err?.message === 'Aborted' || err?.name === 'AbortError') throw err;
  }

  try {
    throwIfAborted();
    const eqRes = await runPrompt(equivalentsPrompt(c, undefined, p));
    applyEquivalents(c, eqRes);
  } catch (err) {
    if (err?.message === 'Aborted' || err?.name === 'AbortError') throw err;
  }

  try {
    throwIfAborted();
    const synRes = await runPrompt(synonymsPrompt(c, undefined, p));
    applySynonyms(c, synRes);
  } catch (err) {
    if (err?.message === 'Aborted' || err?.name === 'AbortError') throw err;
  }

  try {
    throwIfAborted();
    const exRes = await runPrompt(examplesPrompt(c, undefined, deck, p));
    applyExamples(c, exRes);
  } catch (err) {
    if (err?.message === 'Aborted' || err?.name === 'AbortError') throw err;
  }

  if (wantCloze && examplePairs(c).length > 0) {
    try {
      throwIfAborted();
      const clozeRes = await runPrompt(clozeDistractorsPrompt(c, deck, undefined, p));
      applyClozeDistractors(c, clozeRes);
    } catch (err) {
      if (err?.message === 'Aborted' || err?.name === 'AbortError') throw err;
    }
  }

  return c;
}

// -> [] when the example pair passed; otherwise rewrite instructions for
// exampleRewritePrompt.
function interpretExampleVerdict(resp, pair) {
  const resolved = resolvePairDescriptor(pair);
  const l2Lang = getLanguage(resolved.l2) || { name: 'English' };
  const l2Name = l2Lang.name;

  const problems = [];
  const listed = normList(resp && resp.issues);
  if (!passes(resp && resp.theme_fit)) {
    problems.push('the example pair must fit the deck topic/theme');
  }
  if (!passes(resp && resp.blank_inferable)) {
    problems.push(
      l2Name === 'English'
        ? 'the English sentence must give enough context that the blanked answer is inferable — write a concrete, specific scene instead of a generic frame'
        : `the ${l2Name} sentence must give enough context that the blanked answer is inferable — write a concrete, specific scene instead of a generic frame`
    );
  }
  if (problems.length === 0) return [];
  return [...problems, ...listed].slice(0, 6);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Blind solve of ONE sentence: the examiner sees answer + distractors shuffled,
// without knowing which is correct.
async function solveSentence(card, sentenceL2, runPrompt, pair) {
  const answer = card.l2_text ?? card.english_text;
  const distractors = card.l2_cloze_distractors ?? card.cloze_distractors_en ?? [];
  const options = shuffle([answer, ...distractors]);
  const blanked = blankedExample(sentenceL2, answer);
  const resp = await runPrompt(clozeSolvePrompt(blanked, options, pair));
  const fitting = new Set(normList(resp && resp.fitting_options).map((o) => normalizeAnswer(o)));
  return {
    answerFits: fitting.has(normalizeAnswer(answer)),
    offenders: distractors.filter((d) => fitting.has(normalizeAnswer(d))),
  };
}

// ---------------------------------------------------------------------------
// status (no LLM calls): deterministic issues + stale-audit report
// ---------------------------------------------------------------------------
// Same shape as validateCard() plus an `audits` group, so hasIssues()/flatten()
// work on it. This is the single "does this card meet the current feature
// set?" question that update_cards.cjs / enrich --only-missing / review ask.
function cardStatus(card, deck, opts = {}) {
  const { auditFields = true, auditExamples = true, auditCloze = true, wantCloze = true } = opts;
  const pair = resolvePairDescriptor(opts.pair || deck || card);
  const issues = validateCard(card);
  if (!wantCloze) issues.clozeDistractors = [];
  const audits = [];
  if (!issues.card.length) {
    if (auditFields && !issues.lexical.length && !issues.equivalents.length && !issues.synonyms.length &&
        !auditFresh(card, 'field_quality', fieldFingerprint(deck, card, pair), pair)) {
      audits.push('field quality audit (lexical, equivalents, synonyms) has not passed for the current content');
    }
    if (!issues.examples.length) {
      if (auditExamples && !auditFresh(card, 'example_quality', exampleFingerprint(deck, card, pair), pair)) {
        audits.push('example audit (theme fit + blank inferability) has not passed for the current content');
      }
      if (auditCloze && wantCloze && !issues.clozeDistractors.length &&
          !auditFresh(card, 'cloze_options', clozeFingerprint(card, pair), pair)) {
        audits.push('cloze audit (only the answer fits the blank) has not passed for the current content');
      }
    }
  }
  return { ...issues, audits };
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isGroupAllowed(group, onlySet) {
  if (!onlySet) return true;
  if (onlySet.has(group)) return true;
  if (group === 'clozeDistractors' && (onlySet.has('cloze-options') || onlySet.has('cloze_distractors'))) return true;
  if ((group === 'lexical' || group === 'equivalents' || group === 'synonyms') && onlySet.has('fields')) return true;
  return false;
}

function isGroupProtected(group, protectSet) {
  if (!protectSet) return false;
  if (protectSet.has(group)) return true;
  if (group === 'clozeDistractors' && (protectSet.has('cloze-options') || protectSet.has('cloze_distractors'))) return true;
  if ((group === 'lexical' || group === 'equivalents' || group === 'synonyms') && protectSet.has('fields')) return true;
  return false;
}

function isGroupNonEmpty(group, card) {
  if (!card) return false;
  if (group === 'lexical') {
    return !isBlank(card.part_of_speech) || !isBlank(card.l2_definition ?? card.definition_en);
  }
  if (group === 'equivalents') {
    const rawTrans = card.l1_translations ?? card.main_translations_es;
    const t = Array.isArray(rawTrans) ? rawTrans.filter((x) => !isBlank(x)) : [];
    const c = Array.isArray(card.collocations) ? card.collocations.filter((x) => !isBlank(x)) : [];
    return t.length > 0 || c.length > 0;
  }
  if (group === 'synonyms') {
    const rawSyns = card.l2_synonyms ?? card.synonyms_en;
    const s = Array.isArray(rawSyns) ? rawSyns.filter((x) => !isBlank(x)) : [];
    return s.length > 0;
  }
  if (group === 'examples') {
    const pairs = Array.isArray(card.examples)
      ? card.examples.filter((p) => p && !isBlank(p.l1 ?? p.es) && !isBlank(p.l2 ?? p.en))
      : [];
    return pairs.length > 0 || (!isBlank(card.example_l1 ?? card.example_es) && !isBlank(card.example_l2 ?? card.example_en));
  }
  if (group === 'clozeDistractors' || group === 'cloze-options' || group === 'cloze_distractors') {
    const rawOpts = card.l2_cloze_distractors ?? card.cloze_distractors_en;
    const opts = Array.isArray(rawOpts) ? rawOpts.filter((x) => !isBlank(x)) : [];
    return opts.length > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
// Brings one card up to the current feature set. Options:
//   deck          deck context { slug, title, description, ... } for the
//                 theme-aware prompts (required for good results).
//   maxRepairs    per-audit rewrite budget (default 2), mirrors the CLI flag.
//   runPrompt     prompt runner (tests inject a stub; defaults to Ollama).
//   auditExamples / auditCloze / wantCloze
//                 feature gates used by update_cards.cjs --features.
//   only          optional Set of feature groups allowed to be written.
//   protect       optional Set of feature groups whose non-empty values must not be overwritten.
//   log           progress logger (msg) => void.
// Returns { card, issues } where issues = cardStatus() of the final card —
// empty groups mean the card fully meets the feature set.
async function processCard(draft, opts = {}) {
  const {
    deck = {},
    maxRepairs = 2,
    runPrompt = defaultRunPrompt,
    auditFields = true,
    auditExamples = true,
    auditCloze = true,
    wantCloze = true,
    only = null,
    protect = null,
    log = () => {},
    signal = null,
  } = opts;

  const pair = resolvePairDescriptor(opts.pair || deck || draft);
  const l2Lang = getLanguage(pair.l2) || { name: 'English' };
  const l2Name = l2Lang.name;

  const onlySet = only ? new Set(Array.isArray(only) ? only : Array.from(only)) : null;
  const protectSet = protect ? new Set(Array.isArray(protect) ? protect : Array.from(protect)) : null;

  const card = { ...draft };
  let lexicalHints = [];          // feedback for the next lexicalPrompt run
  let equivalentsHints = [];      // feedback for the next equivalentsPrompt run
  let synonymsHints = [];         // feedback for the next synonymsPrompt run
  let setHints = [];              // full-set feedback for the next examplesPrompt run
  let pairHints = new Map();      // pair index -> issues, for targeted rewrites
  let clozeHints = [];            // feedback for the next clozeDistractorsPrompt run
  let fieldAuditFails = 0;
  let exampleAuditFails = 0;
  let clozeAuditFails = 0;
  // Every audit failure costs one rewrite round + one re-audit round; the cap
  // only exists so a stubborn model can't loop forever.
  const maxRounds = 4 + (maxRepairs + 1) * 4;

  for (let round = 0; round < maxRounds; round++) {
    let acted = false;
    let det = validateCard(card);
    if (det.card.length) break; // spanish/english problems can't be fixed by enrichment

    // Filter det based on only and protect options
    if (onlySet) {
      if (!isGroupAllowed('lexical', onlySet)) det.lexical = [];
      if (!isGroupAllowed('equivalents', onlySet)) det.equivalents = [];
      if (!isGroupAllowed('examples', onlySet)) det.examples = [];
      if (!isGroupAllowed('synonyms', onlySet)) det.synonyms = [];
      if (!isGroupAllowed('clozeDistractors', onlySet)) det.clozeDistractors = [];
    }

    if (protectSet) {
      if (isGroupProtected('lexical', protectSet) && isGroupNonEmpty('lexical', card)) det.lexical = [];
      if (isGroupProtected('equivalents', protectSet) && isGroupNonEmpty('equivalents', card)) det.equivalents = [];
      if (isGroupProtected('synonyms', protectSet) && isGroupNonEmpty('synonyms', card)) det.synonyms = [];
      if (isGroupProtected('clozeDistractors', protectSet) && isGroupNonEmpty('clozeDistractors', card)) det.clozeDistractors = [];
      if (isGroupProtected('examples', protectSet) && examplePairs(card).length >= 3) det.examples = [];
    }

    // Pass validator/audit feedback from the second attempt on (a fresh first
    // attempt needs no "fix these issues" preamble).
    const hints = (detIssues, auditIssues) => {
      const merged = [...(round > 0 ? detIssues : []), ...auditIssues];
      return merged.length ? merged : undefined;
    };

    // --- deterministic gap-fill + audit repairs ---
    if (det.lexical.length || lexicalHints.length) {
      applyLexical(card, await runPrompt(lexicalPrompt(card, hints(det.lexical, lexicalHints), pair)));
      clearAudit(card, 'field_quality');
      card._fieldReasons = card._fieldReasons || {};
      if (lexicalHints.length) {
        card._fieldReasons.part_of_speech = lexicalHints[0];
        card._fieldReasons.l2_definition = lexicalHints[0];
        card._fieldReasons.definition_en = lexicalHints[0];
      }
      lexicalHints = [];
      acted = true;
    }
    if (det.equivalents.length || equivalentsHints.length) {
      applyEquivalents(card, await runPrompt(equivalentsPrompt(card, hints(det.equivalents, equivalentsHints), pair)));
      clearAudit(card, 'field_quality');
      card._fieldReasons = card._fieldReasons || {};
      if (equivalentsHints.length) {
        card._fieldReasons.l1_translations = equivalentsHints[0];
        card._fieldReasons.main_translations_es = equivalentsHints[0];
        card._fieldReasons.collocations = equivalentsHints[0];
      }
      equivalentsHints = [];
      acted = true;
    }
    if (det.examples.length || setHints.length) {
      const prevPairs = examplePairs(card);
      const isProtectedExamples = isGroupProtected('examples', protectSet);
      // Structural problems (missing pairs, non-blankable sentences, ...):
      // regenerate the full set. The prompt sees the current pairs and keeps
      // the rule-compliant ones.
      applyExamples(card, await runPrompt(examplesPrompt(card, hints(det.examples, setHints), deck, pair)));

      if (isProtectedExamples && prevPairs.length > 0) {
        // Under protect, deterministically restore any previous pairs missing from the new set,
        // keeping previous pairs first and filling up to EXAMPLES_MAX with generated ones.
        const seen = new Set();
        const merged = [];
        for (const p of prevPairs) {
          const key = normalizeAnswer(p.l2 ?? p.en);
          if (key && !seen.has(key)) {
            seen.add(key);
            merged.push(p);
          }
        }
        for (const p of examplePairs(card)) {
          const key = normalizeAnswer(p.l2 ?? p.en);
          if (key && !seen.has(key)) {
            seen.add(key);
            merged.push(p);
            if (merged.length >= EXAMPLES_MAX) break;
          }
        }
        applyExamples(card, { examples: merged });
      }

      // Check if existing pairs survived under protect
      const survivingPairs = prevPairs.filter((prev) =>
        examplePairs(card).some((curr) => (curr.l2 ?? curr.en) === (prev.l2 ?? prev.en) && (curr.l1 ?? curr.es) === (prev.l1 ?? prev.es))
      );
      const existingSurvived = prevPairs.length > 0 && survivingPairs.length === prevPairs.length;

      if (isProtectedExamples && existingSurvived) {
        // Under protect when existing pairs survive, do NOT clear distractors or void audits
      } else {
        // The sentence set changed: stored distractors and audit passes are void.
        card.l2_cloze_distractors = [];
        card.cloze_distractors_en = [];
        clearAudit(card, 'example_quality');
        clearAudit(card, 'cloze_options');
      }
      setHints = [];
      pairHints = new Map();
      acted = true;
    } else if (pairHints.size) {
      // Audit-rejected pairs: rewrite each one in place, keeping the others.
      for (const [index, problems] of [...pairHints.entries()]) {
        const pItem = examplePairs(card)[index];
        if (!pItem) continue;
        const others = examplePairs(card).filter((_, i) => i !== index);
        applyExampleRewrite(card, index, await runPrompt(exampleRewritePrompt(card, deck, pItem, problems, others, pair)));
      }
      clearAudit(card, 'example_quality');
      clearAudit(card, 'cloze_options');
      pairHints = new Map();
      acted = true;
    }
    if (det.synonyms.length || synonymsHints.length) {
      applySynonyms(card, await runPrompt(synonymsPrompt(card, hints(det.synonyms, synonymsHints), pair)));
      clearAudit(card, 'field_quality');
      card._fieldReasons = card._fieldReasons || {};
      if (synonymsHints.length) {
        card._fieldReasons.l2_synonyms = synonymsHints[0];
        card._fieldReasons.synonyms_en = synonymsHints[0];
      }
      synonymsHints = [];
      acted = true;
    }

    // Distractors need a valid, fully blankable example set — recheck first.
    det = validateCard(card);
    if (onlySet && !isGroupAllowed('clozeDistractors', onlySet)) det.clozeDistractors = [];
    if (protectSet && isGroupProtected('clozeDistractors', protectSet) && isGroupNonEmpty('clozeDistractors', card)) det.clozeDistractors = [];
    if (wantCloze && !det.examples.length && (det.clozeDistractors.length || clozeHints.length)) {
      applyClozeDistractors(card, await runPrompt(clozeDistractorsPrompt(card, deck, hints(det.clozeDistractors, clozeHints), pair)));
      clearAudit(card, 'cloze_options');
      clozeHints = [];
      acted = true;
      det = validateCard(card);
    }

    // --- audits (only over deterministically clean fields) ---
    if (auditFields && !det.lexical.length && !det.equivalents.length && !det.synonyms.length &&
        fieldAuditFails <= maxRepairs) {
      const fp = fieldFingerprint(deck, card, pair);
      if (!auditFresh(card, 'field_quality', fp, pair)) {
        const verdict = interpretFieldVerdict(await runPrompt(fieldAuditPrompt(card, deck, pair)));
        if (!verdict.pairCorrect) {
          card._pair_correct = false;
          card._pair_issues = verdict.pairIssues;

          const fixes = [];
          const isTranslationMismatch = verdict.mismatchType === 'translation_mismatch' || verdict.proposedFixes.length >= 2;

          for (let i = 0; i < verdict.proposedFixes.length; i += 1) {
            const fix = verdict.proposedFixes[i];
            const fixDraft = {
              l1_text: fix.l1_text,
              l2_text: fix.l2_text,
              spanish_text: fix.l1_text,
              english_text: fix.l2_text,
              section_name: card.section_name ?? null,
            };
            const enriched = await enrichCandidateCard(fixDraft, {
              deck,
              pair,
              runPrompt,
              wantCloze,
              signal,
            });
            enriched._target = fix.target || (isTranslationMismatch ? (i === 0 ? 'target_language' : 'source_language') : 'repair');
            enriched._reason = fix.reason || '';
            fixes.push(enriched);
          }

          if (fixes.length > 0) {
            card._pair_mismatch = {
              type: isTranslationMismatch ? 'translation_mismatch' : 'totally_incorrect',
              explanation: verdict.pairIssues.join('. '),
              fixes: fixes.map((fixCard, idx) => {
                const isTargetLang = fixCard._target === 'target_language' || (isTranslationMismatch && idx === 0);
                const isRepair = fixCard._target === 'repair' || !isTranslationMismatch;
                const isDefaultSelected = isTargetLang || isRepair;
                const pL1 = fixCard.l1_text ?? fixCard.spanish_text;
                const aL2 = fixCard.l2_text ?? fixCard.english_text;

                return {
                  id: fixCard._target || (isRepair ? 'repair' : idx === 0 ? 'target_language' : 'source_language'),
                  target: fixCard._target || (isRepair ? 'repair' : idx === 0 ? 'target_language' : 'source_language'),
                  label: isRepair
                    ? `Repaired Card (“${pL1}” ➔ “${aL2}”)`
                    : isTargetLang
                      ? `Preserve ${l2Name} Answer / Target Language (“${pL1}” ➔ “${aL2}”)`
                      : `Preserve Source Prompt / Source Language (“${pL1}” ➔ “${aL2}”)`,
                  l1_text: pL1,
                  l2_text: aL2,
                  spanish_text: pL1,
                  english_text: aL2,
                  part_of_speech: fixCard.part_of_speech ?? null,
                  l2_definition: fixCard.l2_definition ?? fixCard.definition_en ?? null,
                  definition_en: fixCard.l2_definition ?? fixCard.definition_en ?? null,
                  l1_translations: fixCard.l1_translations ?? fixCard.main_translations_es ?? [],
                  main_translations_es: fixCard.l1_translations ?? fixCard.main_translations_es ?? [],
                  collocations: fixCard.collocations ?? [],
                  l2_synonyms: fixCard.l2_synonyms ?? fixCard.synonyms_en ?? [],
                  synonyms_en: fixCard.l2_synonyms ?? fixCard.synonyms_en ?? [],
                  examples: fixCard.examples ?? [],
                  example_l1: fixCard.example_l1 ?? fixCard.example_es ?? null,
                  example_l2: fixCard.example_l2 ?? fixCard.example_en ?? null,
                  example_es: fixCard.example_l1 ?? fixCard.example_es ?? null,
                  example_en: fixCard.example_l2 ?? fixCard.example_en ?? null,
                  example_sentence: fixCard.example_l2 ?? fixCard.example_sentence ?? null,
                  mnemonic_en: fixCard.mnemonic_en ?? null,
                  l2_cloze_distractors: fixCard.l2_cloze_distractors ?? fixCard.cloze_distractors_en ?? [],
                  cloze_distractors_en: fixCard.l2_cloze_distractors ?? fixCard.cloze_distractors_en ?? [],
                  _selected: isDefaultSelected,
                };
              }),
            };

            const defaultPrimaryFix = card._pair_mismatch.fixes.find((f) => f._selected);
            if (defaultPrimaryFix) {
              card.l1_text = defaultPrimaryFix.l1_text;
              card.l2_text = defaultPrimaryFix.l2_text;
              card.spanish_text = defaultPrimaryFix.spanish_text;
              card.english_text = defaultPrimaryFix.english_text;
              card.part_of_speech = defaultPrimaryFix.part_of_speech;
              card.l2_definition = defaultPrimaryFix.l2_definition;
              card.definition_en = defaultPrimaryFix.definition_en;
              card.l1_translations = defaultPrimaryFix.l1_translations;
              card.main_translations_es = defaultPrimaryFix.main_translations_es;
              card.collocations = defaultPrimaryFix.collocations;
              card.l2_synonyms = defaultPrimaryFix.l2_synonyms;
              card.synonyms_en = defaultPrimaryFix.synonyms_en;
              card.examples = defaultPrimaryFix.examples;
              card.example_l1 = defaultPrimaryFix.example_l1;
              card.example_l2 = defaultPrimaryFix.example_l2;
              card.example_es = defaultPrimaryFix.example_es;
              card.example_en = defaultPrimaryFix.example_en;
              card.example_sentence = defaultPrimaryFix.example_sentence;
              card.l2_cloze_distractors = defaultPrimaryFix.l2_cloze_distractors;
              card.cloze_distractors_en = defaultPrimaryFix.cloze_distractors_en;
            }
          }
        }
        if (verdict.failingGroups.length > 0) {
          fieldAuditFails++;
          log(`    audit: field quality audit rejected (${verdict.failingGroups.join(', ')})`);
          if (fieldAuditFails <= maxRepairs) {
            let queuedRepair = false;
            if (verdict.lexicalIssues.length && isGroupAllowed('lexical', onlySet) && !isGroupProtected('lexical', protectSet)) {
              lexicalHints = verdict.lexicalIssues;
              queuedRepair = true;
            }
            if (verdict.equivalentsIssues.length && isGroupAllowed('equivalents', onlySet) && !isGroupProtected('equivalents', protectSet)) {
              equivalentsHints = verdict.equivalentsIssues;
              queuedRepair = true;
            }
            if (verdict.synonymsIssues.length && isGroupAllowed('synonyms', onlySet) && !isGroupProtected('synonyms', protectSet)) {
              synonymsHints = verdict.synonymsIssues;
              queuedRepair = true;
            }
            if (queuedRepair) {
              acted = true;
              continue;
            }
          }
        } else {
          setAudit(card, 'field_quality', fp, pair);
          acted = true;
        }
      }
    }

    if (auditExamples && !det.examples.length && exampleAuditFails <= maxRepairs) {
      const fp = exampleFingerprint(deck, card, pair);
      if (!auditFresh(card, 'example_quality', fp, pair)) {
        const failing = new Map();
        for (const [index, pItem] of examplePairs(card).entries()) {
          const problems = interpretExampleVerdict(await runPrompt(exampleAuditPrompt(card, deck, pItem, pair)), pair);
          if (problems.length) failing.set(index, problems);
        }
        if (failing.size) {
          exampleAuditFails++;
          log(`    audit: ${failing.size} example pair(s) rejected (${[...failing.values()][0][0]})`);
          if (exampleAuditFails <= maxRepairs) {
            pairHints = failing;
            acted = true;
            continue;
          }
        } else {
          setAudit(card, 'example_quality', fp, pair);
          acted = true;
        }
      }
    }

    if (auditCloze && wantCloze && !det.examples.length && !det.clozeDistractors.length &&
        clozeAuditFails <= maxRepairs) {
      const fp = clozeFingerprint(card, pair);
      if (!auditFresh(card, 'cloze_options', fp, pair)) {
        // Blind-solve EVERY sentence: one option set serves them all, so an
        // option accepted anywhere is an offender, and the real answer must be
        // accepted everywhere.
        const offenderSet = new Set();
        const badPairs = new Map();
        for (const [index, pItem] of examplePairs(card).entries()) {
          const sentL2 = pItem.l2 ?? pItem.en;
          const { answerFits, offenders } = await solveSentence(card, sentL2, runPrompt, pair);
          if (!answerFits) {
            badPairs.set(index, [`when the ${l2Name} answer is blanked out, the rest of the sentence must clearly accept the answer as the natural fill`]);
          }
          for (const o of offenders) offenderSet.add(o);
        }
        if (badPairs.size) {
          // The examiner rejected the real answer for its own sentence — an
          // example problem, not a distractor problem.
          clozeAuditFails++;
          log(`    audit: examiner did not accept the answer in ${badPairs.size} sentence(s) — rewriting`);
          if (clozeAuditFails <= maxRepairs) {
            pairHints = badPairs;
            acted = true;
            continue;
          }
        } else if (offenderSet.size) {
          const offenders = [...offenderSet];
          const norm = new Set(offenders.map((o) => normalizeAnswer(o)));
          const filtered = (card.l2_cloze_distractors ?? card.cloze_distractors_en).filter((d) => !norm.has(normalizeAnswer(d)));
          card.l2_cloze_distractors = filtered;
          card.cloze_distractors_en = filtered;
          if (card.cloze_distractors_en.length >= CLOZE_DISTRACTORS_MIN) {
            // Survivors were judged non-fitting in every sentence of the same sweep.
            setAudit(card, 'cloze_options', clozeFingerprint(card, pair), pair);
            log(`    audit: dropped ${offenders.length} distractor(s) that also fit; ${card.cloze_distractors_en.length} remain`);
          } else {
            clozeAuditFails++;
            log(`    audit: ${offenders.length} distractor(s) also fit a blank — regenerating`);
            if (clozeAuditFails <= maxRepairs) {
              clozeHints = offenders.map((o) => `"${o}" also fits one of the sentences — replace it with an option that is clearly wrong in every sentence`);
            }
          }
          acted = true;
          continue;
        } else {
          setAudit(card, 'cloze_options', fp, pair);
          acted = true;
        }
      }
    }

    if (!acted) break;
  }

  return { card, issues: cardStatus(card, deck, { auditFields, auditExamples, auditCloze, wantCloze, pair }) };
}

module.exports = {
  processCard,
  cardStatus,
  AUDIT_VERSIONS,
  getAuditVersions,
  fieldFingerprint,
  exampleFingerprint,
  clozeFingerprint,
};
