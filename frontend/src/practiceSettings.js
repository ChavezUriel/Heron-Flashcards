export const DEFAULT_PRACTICE_SETTINGS = {
  new_block_size: 7,
  review_batch_size: 30,
  focus_mode: 'auto',
  minigames: {
    enabled: true,
    // How often games replace/wrap the classic swipe: 'off' | 'light' | 'balanced' | 'heavy'.
    frequency: 'balanced',
    // One entry per game, added as each rollout phase ships one. An empty map
    // means every card falls back to the classic flashcard (today's behavior).
    games: {
      // --- Tier A (counts toward scheduling) — free recall, grades like a swipe ---
      // Phase 1: type the English for a Spanish prompt. §4 (#1), §9 Phase 1.
      type_translation: true,
      // Phase 5: type the English for its definition. §4 (#2), §9 Phase 5.
      recall_from_definition: true,
      // Phase 5: type the word blanked out of the English example. §4 (#3), §9 Phase 5.
      cloze_free: true,
      // --- Tier B (practice only) — recognition; a win never grades, a clean
      // wrong pick records a lapse, so it never inflates the schedule (§3.1–3.2) ---
      // Phase 2: pick the English translation from a few options. On by default per
      // the plan's example (docs/minigames.md §7.1, §11.4); §4 (#4), §9 Phase 2.
      multiple_choice: true,
      // Phase 5: pick the missing word from a bank of English tiles. §4 (#6).
      word_bank_cloze: true,
      // Pick the Spanish prompt for an English answer. ON by default as of Phase 6:
      // its Spanish-distractor backend (migration 0014) is live, so it works
      // end-to-end and degrades cleanly when a card lacks distractors. §4 (#5), §9 Phase 6.
      reverse_mc: true,
      // Phase 3: queue-external speed round of MC questions between blocks. §4 (#7).
      speed_round: true,
      // --- Tier C / depth (practice only) — never counts toward FSRS ---
      // Phase 3: matching grid warm-up / cool-down. §4 (#8), §9 Phase 3.
      memory_grid: true,
      // Phase 6 depth game: match a word to its synonyms as a cool-down. Feeds a
      // separate "depth" stat, never due_at. §11, §4 enrichment aside, §9 Phase 6.
      synonym_match: true,
      // Phase 5: single-card cool-down puzzles. OFF by default. §4 (#9–#10).
      scramble: false,
      hangman: false,
      // Phase 4: encoding aid on a NEW card's very first exposure, before any graded
      // rep. It never grades — it advances via skip, deferring the first graded rep
      // to a later cycle. §4 (#11), §9 Phase 4.
      listening: true,
    },
  },
};

const STORAGE_KEY = 'heron.smartPracticeSettings';

// Overlay a stored blob onto the defaults. Top-level keys are a shallow merge,
// but `minigames` (and its nested `games` map) is merged one level deeper so a
// blob written by an older app version still inherits games added since — see
// docs/minigames.md §7.1. Games absent from the defaults are dropped, so a blob
// written before a game was removed doesn't resurrect its toggle.
function mergePracticeSettings(overrides) {
  const storedMinigames =
    overrides && typeof overrides.minigames === 'object' && overrides.minigames ? overrides.minigames : {};
  const storedGames = storedMinigames.games ?? {};

  const games = {};
  for (const [game, defaultOn] of Object.entries(DEFAULT_PRACTICE_SETTINGS.minigames.games)) {
    games[game] = typeof storedGames[game] === 'boolean' ? storedGames[game] : defaultOn;
  }

  return {
    ...DEFAULT_PRACTICE_SETTINGS,
    ...overrides,
    minigames: {
      ...DEFAULT_PRACTICE_SETTINGS.minigames,
      ...storedMinigames,
      games,
    },
  };
}

export function loadPracticeSettings() {
  if (typeof window === 'undefined') {
    return DEFAULT_PRACTICE_SETTINGS;
  }

  const rawValue = window.localStorage.getItem(STORAGE_KEY);
  if (!rawValue) {
    return DEFAULT_PRACTICE_SETTINGS;
  }

  try {
    const parsedValue = JSON.parse(rawValue);
    return mergePracticeSettings(parsedValue);
  } catch {
    return DEFAULT_PRACTICE_SETTINGS;
  }
}

export function savePracticeSettings(settings) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}