// Explicit .js extension is required by run_browser_pipeline_tests.mjs (Node ESM resolver)
import { getLanguage } from './languages.js';

// Frequency dosing & interstitial selection for minigames.
// See docs/minigames.md §6.3 (dosing), §7.1 (settings), §9 Phase 3.
//
// `settings.minigames.frequency` ('off' | 'light' | 'balanced' | 'heavy') is the
// single dial for how much the classic flashcard is replaced or wrapped by games.
// It drives two independent levers:
//
//   perCard    — for a card that is *already eligible* for a Phase 1/2 game
//                (type_translation / multiple_choice), does this presentation
//                actually use the game, or fall back to the classic swipe?
//   placements — which queue-external interstitials (warm-up / block boundary /
//                cool-down) are allowed to fire.
//
// 'off' collapses both levers to nothing, so the app is the pure classic flow
// (§7.3). 'balanced' is the default and keeps `perCard: 'all'`, so the Phase 0–2
// typing/MC behavior is exactly as shipped (every eligible card still switches
// modality). Higher tiers only *add* interstitials and never make the graded
// per-card games fire on cards that weren't already eligible, so the FSRS
// guardrails in selectModality stay intact.

// Queue-external games (never count toward FSRS). They only ever run as
// interstitials, never as a per-card modality (docs/minigames.md §4 #7–#10, §5.2).
// memory_grid / speed_round are pool-based; scramble / hangman are single-card
// cool-down puzzles (off by default); synonym_match is the Phase 6 depth game
// (§11) — it feeds a separate depth stat, still never touching due_at.
export const BOUNDARY_GAMES = ['memory_grid', 'speed_round', 'scramble', 'hangman', 'synonym_match'];

// The Synonym-match depth round needs an anchor word carrying at least this many
// distinct synonyms (the correct picks) and this many other pool answers to draw
// distractors from. Below either bound the game is skipped (§9 Phase 6).
const DEPTH_MIN_SYNONYMS = 2;
const DEPTH_MIN_DISTRACTORS = 3;

const FREQUENCY_POLICY = {
  off: { perCard: 'none', placements: [] },
  light: { perCard: 'half', placements: ['cooldown'] },
  balanced: { perCard: 'all', placements: ['boundary', 'cooldown'] },
  heavy: { perCard: 'all', placements: ['warmup', 'boundary', 'cooldown'] },
};

export function frequencyPolicy(frequency) {
  return FREQUENCY_POLICY[frequency] ?? FREQUENCY_POLICY.balanced;
}

// Stable pseudo-random hash for one card presentation. Deterministic in
// (card_id, times_presented) so any choice derived from it never flips between
// renders, and so the dose doesn't stack a second randomizer on top of
// the session's auto-chosen shape (§6.3) — the same card+pass always resolves the same way.
function presentationHash(card) {
  const id = Number(card?.card_id) || 0;
  const pass = Number(card?.times_presented) || 0;
  let x = (id * 2654435761 + pass * 40503) | 0;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return Math.abs(x);
}

function presentationBit(card) {
  return presentationHash(card) % 2;
}

// A stable index in [0, n) for one card presentation — used to pick among several
// eligible per-card games (Phase 5) without adding a second randomizer. Same
// (card, pass) always maps to the same index, so the modality can't flicker.
export function presentationIndex(card, n) {
  if (!n || n <= 1) {
    return 0;
  }
  return presentationHash(card) % n;
}

// A second stable index in [0, n), decorrelated from presentationIndex by a
// salted pass component — used to pick WHICH example sentence a cloze game
// blanks this presentation (cards carry several pairs since migration 0019),
// independent of which game was picked. Same (card, pass) always maps to the
// same sentence, so the blank can't flicker between renders; the next pass
// rotates naturally.
export function sentenceIndex(card, n) {
  if (!n || n <= 1) {
    return 0;
  }
  const id = Number(card?.card_id) || 0;
  const pass = Number(card?.times_presented) || 0;
  let x = (id * 2654435761 + (pass + 101) * 48271) | 0;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return Math.abs(x) % n;
}

// Should an *eligible* card actually use its Phase 1/2 minigame this presentation?
// Callers only ask once the card matches a game's own gate; this is the frequency
// dose layered on top. 'none' -> never, 'all' -> always (Phase 0–2 behavior),
// 'half' -> a deterministic ~50%, the rest fall back to the classic swipe.
export function shouldPlayPerCardGame(card, frequency) {
  const { perCard } = frequencyPolicy(frequency);
  if (perCard === 'none') {
    return false;
  }
  if (perCard === 'all') {
    return true;
  }
  return presentationBit(card) === 0;
}

export function isInterstitialPlacementEnabled(frequency, placement) {
  return frequencyPolicy(frequency).placements.includes(placement);
}

// --- Interstitial game selection & card pool -------------------------------

function normalizeKey(value) {
  return (value ?? '').toString().trim().toLowerCase();
}

// A card is usable in a boundary game only when it has both faces to show. We
// also de-dupe by answer and by prompt so a matching grid has unambiguous pairs
// and a speed round's distractors are all distinct.
export function usableBoundaryCards(cards) {
  const out = [];
  const seenAnswers = new Set();
  const seenPrompts = new Set();
  for (const card of cards ?? []) {
    const prompt = (card?.prompt_l1 ?? '').trim();
    const answer = (card?.answer_l2 ?? '').trim();
    if (!prompt || !answer) {
      continue;
    }
    const answerKey = normalizeKey(answer);
    const promptKey = normalizeKey(prompt);
    if (seenAnswers.has(answerKey) || seenPrompts.has(promptKey)) {
      continue;
    }
    seenAnswers.add(answerKey);
    seenPrompts.add(promptKey);
    out.push({
      card_id: card.card_id,
      prompt_l1: prompt,
      answer_l2: answer,
      section_name: card.section_name ?? null,
    });
  }
  return out;
}

// Fisher–Yates over a copy. Shuffling the words *inside* a game is expected; only
// the game/placement *choice* is kept deterministic (§6.3).
function sample(cards, count) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// A grid wants 4–6 pairs; a speed round needs enough distinct answers that each
// question has at least 3 distractors (so a pool of ≥4). scramble / hangman are
// single-card puzzles, so one usable card is enough (docs/minigames.md §4 #9–#10).
const GAME_POOL = {
  memory_grid: { min: 4, max: 6 },
  speed_round: { min: 4, max: 6 },
  scramble: { min: 1, max: 1 },
  hangman: { min: 1, max: 1 },
};

// Preference order per placement — deterministic (no randomizer), tying the game
// to the phase (§4 primary placements, §6.3). Cool-down rotates through every
// cool-down game by a caller seed so a run of sessions doesn't always end on the
// same one; scramble / hangman (off by default, §4 #9–#10) join the rotation when
// enabled, and chooseInterstitialGame skips any without enough material.
function preferenceFor(placement, seed) {
  if (placement === 'warmup') {
    return ['memory_grid', 'speed_round'];
  }
  if (placement === 'boundary') {
    return ['speed_round', 'memory_grid'];
  }
  const cooldownGames = ['memory_grid', 'speed_round', 'synonym_match', 'scramble', 'hangman'];
  const start = ((seed % cooldownGames.length) + cooldownGames.length) % cooldownGames.length;
  return [...cooldownGames.slice(start), ...cooldownGames.slice(0, start)];
}

// A card's distinct English synonyms, excluding any that just restate the answer —
// the correct picks for a Synonym-match round (docs/minigames.md §9 Phase 6).
function usableSynonyms(card) {
  const answerKey = normalizeKey(card?.answer_l2);
  const seen = new Set(answerKey ? [answerKey] : []);
  const out = [];
  const synonyms = Array.isArray(card?.l2_synonyms)
    ? card?.l2_synonyms
    : [];
  for (const raw of synonyms) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const norm = normalizeKey(text);
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    out.push(text);
  }
  return out;
}

// Assemble a Synonym-match round from the seen-cards pool: one anchor with enough
// synonyms plus a set of other cards to source distractor answers from. Returns
// { cards: [anchor, ...distractorCards] } (SynonymMatch reads cards[0] as the anchor
// and the rest as the distractor pool) or null when the pool can't supply a fair
// round. Uses the RAW pool (which carries l2_synonyms) rather than the slimmed
// boundary pool. See §9 Phase 6.
function chooseDepthRound(cards) {
  // One entry per distinct answer so a repeated word can't be both anchor and distractor.
  const byAnswer = [];
  const seenAnswers = new Set();
  for (const card of cards ?? []) {
    if (!card || card.card_id == null) {
      continue;
    }
    const answerKey = normalizeKey(card.answer_l2);
    if (!answerKey || seenAnswers.has(answerKey)) {
      continue;
    }
    seenAnswers.add(answerKey);
    byAnswer.push(card);
  }

  const anchors = byAnswer.filter((card) => usableSynonyms(card).length >= DEPTH_MIN_SYNONYMS);
  if (anchors.length === 0) {
    return null;
  }
  const anchor = sample(anchors, 1)[0];
  const anchorAnswerKey = normalizeKey(anchor.answer_l2);
  const anchorSynonymKeys = new Set(usableSynonyms(anchor).map(normalizeKey));

  // Distractors: other answers that are neither the anchor's answer nor a synonym.
  const distractors = byAnswer.filter((card) => {
    if (card.card_id === anchor.card_id) {
      return false;
    }
    const key = normalizeKey(card.answer_l2);
    return key !== anchorAnswerKey && !anchorSynonymKeys.has(key);
  });
  if (distractors.length < DEPTH_MIN_DISTRACTORS) {
    return null;
  }

  return { cards: [anchor, ...sample(distractors, Math.min(6, distractors.length))] };
}

// Decide which boundary game (if any) to show at a placement, and pre-sample its
// card pool. Returns { game, cards } or null when no enabled game has enough
// material — the caller then skips the interstitial entirely (falls back to the
// plain card / complete screen). Respects the per-game toggles (§7.3).
export function chooseInterstitialGame(placement, cards, settings, seed = 0) {
  const enabled = settings?.minigames?.games ?? {};
  const pool = usableBoundaryCards(cards);
  const lang = getLanguage(cards?.[0]?.language_to ?? cards?.[0]?.l2 ?? 'en');
  const allowedGames = lang?.games;
  for (const game of preferenceFor(placement, seed)) {
    if (!BOUNDARY_GAMES.includes(game) || !enabled[game]) {
      continue;
    }
    if (allowedGames && !allowedGames.has(game)) {
      continue;
    }
    // The depth game has its own material rule (an anchor with synonyms + distractor
    // answers), drawn from the raw pool rather than the synonym-stripped boundary pool.
    if (game === 'synonym_match') {
      const round = chooseDepthRound(cards);
      if (round) {
        return { game, cards: round.cards };
      }
      continue;
    }
    const bounds = GAME_POOL[game];
    if (pool.length < bounds.min) {
      continue;
    }
    return { game, cards: sample(pool, Math.min(bounds.max, pool.length)) };
  }
  return null;
}
