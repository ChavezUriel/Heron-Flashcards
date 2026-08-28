// Deck-level gap auditing and run estimation — NO LLM CALLS.
//
// This is the browser sibling of `supabase/scripts/update_cards.cjs --dry-run`:
// it inspects existing cards in memory, maps which fields are missing or
// invalid, and provides exact model-call estimates for repair/fill runs.
//
// The core invariant: auditing is free, instant, and runs entirely in-browser
// using deterministic validators (validateCard) and cache-key checks (cardStatus).
// No provider key is needed to scan a deck.

import { validateCard, EXAMPLES_MIN, CLOZE_DISTRACTORS_MIN } from './validate';
import { cardStatus } from './enrich';
import { normCard } from './cards';

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// ---------------------------------------------------------------------------
// Field presence classifier: 'empty' | 'partial' | 'present' per group.
//
// validateCard() flags non-compliant values (e.g. 4 synonyms when 1-3 allowed)
// but conflates "field is missing" with "field has an invalid value".
// Fill-blanks mode needs to know whether any user-provided content exists so it
// never overwrites hand-written values under `protect`.
// ---------------------------------------------------------------------------
export function fieldPresence(card) {
  if (!card || typeof card !== 'object') {
    return {
      lexical: 'empty',
      equivalents: 'empty',
      synonyms: 'empty',
      examples: 'empty',
      clozeDistractors: 'empty',
      'cloze-options': 'empty',
    };
  }

  // --- lexical (part_of_speech + definition_en) ---
  const hasPos = !isBlank(card.part_of_speech);
  const hasDef = !isBlank(card.definition_en);
  let lexical = 'empty';
  if (hasPos && hasDef) {
    lexical = 'present';
  } else if (hasPos || hasDef) {
    lexical = 'partial';
  }

  // --- equivalents (main_translations_es + collocations) ---
  const translations = Array.isArray(card.main_translations_es)
    ? card.main_translations_es.filter((t) => !isBlank(t))
    : [];
  const collocations = Array.isArray(card.collocations)
    ? card.collocations.filter((c) => !isBlank(c))
    : [];
  let equivalents = 'empty';
  if (translations.length > 0 && collocations.length > 0) {
    equivalents = 'present';
  } else if (translations.length > 0 || collocations.length > 0) {
    equivalents = 'partial';
  }

  // --- synonyms (synonyms_en) ---
  const synonyms = Array.isArray(card.synonyms_en)
    ? card.synonyms_en.filter((s) => !isBlank(s))
    : [];
  const synonymsPresence = synonyms.length > 0 ? 'present' : 'empty';

  // --- examples (examples: [{es, en}] + legacy mirror) ---
  const pairs = Array.isArray(card.examples)
    ? card.examples.filter((p) => p && !isBlank(p.es) && !isBlank(p.en))
    : [];
  const hasLegacy = !isBlank(card.example_es) && !isBlank(card.example_en);
  const exampleCount = pairs.length || (hasLegacy ? 1 : 0);
  let examplesPresence = 'empty';
  if (exampleCount >= EXAMPLES_MIN) {
    examplesPresence = 'present';
  } else if (exampleCount > 0) {
    examplesPresence = 'partial';
  }

  // --- cloze distractors (cloze_distractors_en, migration 0018) ---
  const options = Array.isArray(card.cloze_distractors_en)
    ? card.cloze_distractors_en.filter((o) => !isBlank(o))
    : [];
  let clozeDistractors = 'empty';
  if (options.length >= CLOZE_DISTRACTORS_MIN) {
    clozeDistractors = 'present';
  } else if (options.length > 0) {
    clozeDistractors = 'partial';
  }

  return {
    lexical,
    equivalents,
    synonyms: synonymsPresence,
    examples: examplesPresence,
    clozeDistractors,
    // Alias matching the feature ID 'cloze-options'
    'cloze-options': clozeDistractors,
  };
}

// ---------------------------------------------------------------------------
// Feature registry — port of FEATURES from supabase/scripts/update_cards.cjs.
// Each group defines a deterministic or audit-freshness check returning reason
// strings (empty array = clean).
// ---------------------------------------------------------------------------
export const FEATURE_GROUPS = [
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
      cardStatus(card, deckCtx, { auditExamples: true, auditCloze: false, wantCloze: false }).audits,
  },
  {
    id: 'cloze-audit',
    title: 'LLM audit: only the real answer fits the blank among the options',
    reasons: (card, deckCtx) =>
      cardStatus(card, deckCtx, { auditExamples: false, auditCloze: true, wantCloze: true }).audits,
  },
];

// ---------------------------------------------------------------------------
// scanDeck(cards, deckCtx, quality): full deck audit report
// ---------------------------------------------------------------------------
// Inspects every card in the deck and produces:
//   - perCard: itemized presence, deterministic issues, and audit status
//   - perFeature: count of cards failing each feature group
//   - totals: aggregate summary numbers for badges and reports
export function scanDeck(rawCards = [], deckCtx = {}, quality = true) {
  const cards = (Array.isArray(rawCards) ? rawCards : []).map((c) =>
    normCard(c, deckCtx?.title || '') || c,
  );

  const featureCounts = {
    fields: 0,
    examples: 0,
    'cloze-options': 0,
    'example-audit': 0,
    'cloze-audit': 0,
  };

  let missingExamples = 0;
  let missingClozeDistractors = 0;
  let neverAudited = 0;
  let invalidFields = 0;
  let emptyFields = 0;
  let cardsNeedingWork = 0;

  const perCard = cards.map((card, index) => {
    const raw = rawCards[index] || {};
    const presence = fieldPresence(card);
    const issues = validateCard(card);
    const status = cardStatus(card, deckCtx, {
      auditExamples: quality,
      auditCloze: quality,
      wantCloze: true,
    });

    const reasons = {};
    const failingFeatures = [];

    for (const feature of FEATURE_GROUPS) {
      if (!quality && (feature.id === 'example-audit' || feature.id === 'cloze-audit')) {
        reasons[feature.id] = [];
        continue;
      }
      const featureReasons = feature.reasons(card, deckCtx);
      reasons[feature.id] = featureReasons;
      if (featureReasons.length > 0) {
        featureCounts[feature.id] = (featureCounts[feature.id] || 0) + 1;
        failingFeatures.push(feature.id);
      }
    }

    const needsWork = failingFeatures.length > 0;
    if (needsWork) {
      cardsNeedingWork += 1;
    }

    if (presence.examples === 'empty') {
      missingExamples += 1;
    }
    if (presence.clozeDistractors === 'empty') {
      missingClozeDistractors += 1;
    }

    const hasDeterministicIssues =
      issues.lexical.length > 0 ||
      issues.equivalents.length > 0 ||
      issues.synonyms.length > 0 ||
      issues.examples.length > 0 ||
      issues.clozeDistractors.length > 0 ||
      issues.card.length > 0;

    const isCoreEmpty =
      presence.lexical === 'empty' &&
      presence.equivalents === 'empty' &&
      presence.synonyms === 'empty';

    if (isCoreEmpty) {
      emptyFields += 1;
    }

    if (hasDeterministicIssues && !isCoreEmpty) {
      invalidFields += 1;
    }

    if (status.audits && status.audits.length > 0) {
      neverAudited += 1;
    }

    return {
      card,
      raw,
      index,
      presence,
      issues,
      audits: status.audits || [],
      reasons,
      failingFeatures,
      needsWork,
    };
  });

  const perFeature = FEATURE_GROUPS.map((f) => ({
    id: f.id,
    title: f.title,
    count: featureCounts[f.id] || 0,
  }));

  const totals = {
    totalCards: cards.length,
    cardsNeedingWork,
    completeCards: cards.length - cardsNeedingWork,
    missingExamples,
    missingClozeDistractors,
    neverAudited,
    invalidFields,
    emptyFields,
  };

  return {
    perFeature,
    perCard,
    totals,
  };
}

// ---------------------------------------------------------------------------
// estimateFillRun(scan, mode, groups, concurrency): exact LLM call estimation
// ---------------------------------------------------------------------------
// Rather than assuming a flat CALLS_PER_CARD = 15, calculate the exact number
// of sub-prompts needed based on the scan results.
//
// In 'fill' mode:
//   - Only blank groups run (1 call per empty group per card).
//   - Audits are OFF; already-populated fields are protected.
//
// In 'audit' mode:
//   - Evaluates existing values: ~1 field audit + ~3-4 example audits + ~3-4 cloze
//     solves per card (~8-10 calls before repairs), plus deterministic repairs.
// ---------------------------------------------------------------------------
const SECONDS_PER_CALL = 3.5;

export function estimateFillRun(scan, mode = 'fill', groups = null, concurrency = 3) {
  if (!scan || !scan.perCard) {
    return { cards: 0, calls: 0, minutes: 0, label: '0 minutes', mode };
  }

  const activeGroupSet = groups
    ? new Set(Array.isArray(groups) ? groups : Array.from(groups))
    : null;

  const isGroupActive = (groupId) => {
    if (!activeGroupSet) return true;
    if (activeGroupSet.has(groupId)) return true;
    // Map 'fields' alias to individual lexical/equivalents/synonyms
    if (activeGroupSet.has('fields') && (groupId === 'lexical' || groupId === 'equivalents' || groupId === 'synonyms')) {
      return true;
    }
    if ((groupId === 'cloze-options' || groupId === 'clozeDistractors') &&
        (activeGroupSet.has('cloze-options') || activeGroupSet.has('clozeDistractors') || activeGroupSet.has('cloze_distractors'))) {
      return true;
    }
    return false;
  };

  let totalCalls = 0;
  let affectedCards = 0;

  for (const item of scan.perCard) {
    const { presence, issues, audits, card } = item;
    let cardCalls = 0;

    if (mode === 'fill') {
      // Fill-blanks mode: only run sub-prompts for groups that are completely 'empty'
      if (isGroupActive('lexical') && presence.lexical === 'empty') {
        cardCalls += 1;
      }
      if (isGroupActive('equivalents') && presence.equivalents === 'empty') {
        cardCalls += 1;
      }
      if (isGroupActive('synonyms') && presence.synonyms === 'empty') {
        cardCalls += 1;
      }
      if (isGroupActive('examples') && presence.examples === 'empty') {
        cardCalls += 1;
      }
      if ((isGroupActive('cloze-options') || isGroupActive('clozeDistractors')) &&
          presence.clozeDistractors === 'empty') {
        cardCalls += 1;
      }
    } else {
      // Audit and improve mode:
      // Field audit call
      if (isGroupActive('fields') || isGroupActive('lexical') || isGroupActive('equivalents') || isGroupActive('synonyms')) {
        cardCalls += 1;
      }

      // Examples: 1 generation call if empty, else 1 audit per existing pair
      if (isGroupActive('examples')) {
        if (presence.examples === 'empty') {
          cardCalls += 1;
        } else {
          const pairCount = Array.isArray(card.examples) && card.examples.length > 0 ? card.examples.length : 3;
          cardCalls += pairCount;
        }
      }

      // Cloze options: 1 generation call if empty (or if examples are empty), else 1 solve audit per pair
      if (isGroupActive('cloze-options') || isGroupActive('clozeDistractors')) {
        if (presence.examples === 'empty' || presence.clozeDistractors === 'empty') {
          cardCalls += 1;
        } else {
          const pairCount = Array.isArray(card.examples) && card.examples.length > 0 ? card.examples.length : 3;
          cardCalls += pairCount;
        }
      }

      // Add deterministic repair calls for any existing structural issues (when not already generated from scratch)
      if (isGroupActive('lexical') && issues.lexical.length > 0 && presence.lexical !== 'empty') cardCalls += 1;
      if (isGroupActive('equivalents') && issues.equivalents.length > 0 && presence.equivalents !== 'empty') cardCalls += 1;
      if (isGroupActive('synonyms') && issues.synonyms.length > 0 && presence.synonyms !== 'empty') cardCalls += 1;
      if (isGroupActive('examples') && issues.examples.length > 0 && presence.examples !== 'empty') cardCalls += 1;
      if ((isGroupActive('cloze-options') || isGroupActive('clozeDistractors')) &&
          issues.clozeDistractors.length > 0 &&
          presence.clozeDistractors !== 'empty' &&
          presence.examples !== 'empty') cardCalls += 1;
    }

    if (cardCalls > 0) {
      affectedCards += 1;
      totalCalls += cardCalls;
    }
  }

  const effectiveConcurrency = Math.max(1, concurrency || 3);
  const totalSeconds = (totalCalls * SECONDS_PER_CALL) / effectiveConcurrency;
  const minutes = totalSeconds / 60;

  let label;
  if (totalCalls === 0) {
    label = 'no calls needed';
  } else if (minutes < 1.5) {
    label = 'about a minute';
  } else {
    label = `about ${Math.round(minutes)}–${Math.round(minutes * 1.5)} minutes`;
  }

  return {
    cards: affectedCards,
    calls: totalCalls,
    minutes,
    label,
    mode,
  };
}
