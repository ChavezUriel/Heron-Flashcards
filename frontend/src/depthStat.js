// A tiny client-side "vocabulary depth" stat, persisted to localStorage. It counts
// how many related words the learner has matched in the Synonym-match depth game
// (docs/minigames.md §11, §4 enrichment aside, §9 Phase 6).
//
// This stat is deliberately SEPARATE from the FSRS schedule: depth games test a
// *different fact* (knowing a word's synonyms), so they never touch due_at or the
// graduation streak. Keeping the stat purely client-side (same pattern as
// practiceSettings / recentCards) means the depth feature needs no backend beyond
// the additive telemetry log. See docs/minigames.md §11.
const STORAGE_KEY = 'heron.depthStat';

const EMPTY = { plays: 0, rounds: 0, matched: 0, total: 0 };

function coerceCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Normalize any stored/partial blob into the full shape, so an older or corrupt
// value can never break a read.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY };
  }
  return {
    plays: coerceCount(raw.plays),
    rounds: coerceCount(raw.rounds),
    matched: coerceCount(raw.matched),
    total: coerceCount(raw.total),
  };
}

export function loadDepthStat() {
  if (typeof window === 'undefined') {
    return { ...EMPTY };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...EMPTY };
  }
}

// Fold one completed depth round into the lifetime totals and persist it. `matched`
// is how many of the round's `total` synonyms the learner correctly picked; `plays`
// tracks rounds where at least one word was matched (a light engagement signal).
// Returns the updated stat so a caller can render it without a second read.
export function recordDepthResult({ matched = 0, total = 0 } = {}) {
  const current = loadDepthStat();
  const roundMatched = coerceCount(matched);
  const roundTotal = coerceCount(total);
  const next = {
    plays: current.plays + (roundMatched > 0 ? 1 : 0),
    rounds: current.rounds + 1,
    matched: current.matched + roundMatched,
    total: current.total + roundTotal,
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage full or unavailable — the depth stat is best-effort */
    }
  }
  return next;
}

export function resetDepthStat() {
  if (typeof window === 'undefined') {
    return { ...EMPTY };
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return { ...EMPTY };
}
