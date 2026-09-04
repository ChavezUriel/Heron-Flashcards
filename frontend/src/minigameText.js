// Explicit .js extension is required by run_browser_pipeline_tests.mjs (Node ESM resolver)
import { sentenceIndex } from './minigameFrequency.js';

// Shared text helpers for the answer-matching minigames. Kept in one module so the
// Tier-A free-type games (Type the translation, Recall from definition, Cloze) all
// normalize and grade answers identically (classifyGuess: correct / almost / wrong),
// and so the cloze games locate the blank the same way. See docs/minigames.md §4
// (#1–#3, #6 + near-miss aside), Phase 1 & Phase 5.

// Normalize an answer for comparison: trim + lowercase + strip diacritics, and
// unify the Unicode hyphens/dashes and curly apostrophes that show up in real card
// data, collapsing internal whitespace. So a plain keyboard answer still matches a
// seeded synonym (e.g. "hold‑up" vs typed "hold-up").
export function normalizeAnswer(value) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[‐-―−]/g, '-') // hyphens/dashes/minus -> ASCII hyphen
    .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes -> ASCII '
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Damerau-Levenshtein (optimal string alignment) distance, so a transposition
// ("recieve" for "receive") costs 1 like any single typo. Answers are short, so a
// full matrix is fine.
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    d[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    d[0][j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// How many typos still count as "almost" for an expected answer of this length
// (normalized, spaces included). Short words get none — one edit away from "cat"
// is usually a different word, not a typo.
function typoBudget(length) {
  if (length <= 3) {
    return 0;
  }
  if (length <= 7) {
    return 1;
  }
  return 2;
}

// Function words a learner plausibly drops or adds without missing the word itself:
// articles, the infinitive "to", and the prepositions/particles that ride along with
// phrasal answers ("listen to", "give up"). Answers are English, so a fixed set works.
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
  'up', 'out', 'off', 'into', 'onto', 'over', 'under', 'down', 'away', 'back',
  'about', 'around', 'through',
]);

// True when one side equals the other with exactly one function word removed —
// "listen" for "listen to", "to give up" for "give up". Content words must all
// match exactly; anything looser is a different answer, not a near miss.
function oneFunctionWordApart(a, b) {
  const aTokens = a.split(' ');
  const bTokens = b.split(' ');
  const [longer, shorter] = aTokens.length >= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (longer.length !== shorter.length + 1 || shorter.length === 0) {
    return false;
  }
  for (let i = 0; i < longer.length; i += 1) {
    if (!FUNCTION_WORDS.has(longer[i])) {
      continue;
    }
    const spliced = longer.slice(0, i).concat(longer.slice(i + 1));
    if (spliced.every((token, k) => token === shorter[k])) {
      return true;
    }
  }
  return false;
}

// Grade a free-typed guess against the primary answer and every listed English
// synonym: 'correct' on an exact normalized match, 'almost' on a near miss, else
// 'wrong'. A near miss — within the typo budget of a candidate, or one dropped/added
// function word ("listen" for "listen to") — is close enough that grading it as a
// lapse would be unfair, but not exact enough to count as known. The typing games
// resolve it as NEUTRAL: amber feedback + the exact answer, advancing via the skip
// RPC so FSRS is never touched and the card recycles for a clean rep (§4 near-miss
// aside, §5.3).
export function classifyGuess(guess, card) {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) {
    return 'wrong';
  }

  const answer = card.answer_l2 ?? card.answer_en;
  const synonyms = card.l2_synonyms ?? card.synonyms_en ?? [];
  const candidates = [answer, ...synonyms]
    .map(normalizeAnswer)
    .filter(Boolean);

  if (candidates.some((candidate) => candidate === normalizedGuess)) {
    return 'correct';
  }

  for (const candidate of candidates) {
    const budget = typoBudget(candidate.length);
    if (
      budget > 0 &&
      Math.abs(candidate.length - normalizedGuess.length) <= budget &&
      editDistance(normalizedGuess, candidate) <= budget
    ) {
      return 'almost';
    }
    if (oneFunctionWordApart(normalizedGuess, candidate)) {
      return 'almost';
    }
  }
  return 'wrong';
}

// A word token: a Unicode letter run, allowing internal apostrophes/hyphens so
// "don't" and "hold-up" stay single tokens.
const WORD_RE = /\p{L}[\p{L}\p{M}'’-]*/gu;

// Extract all valid example sentence pairs ({ l1, l2 } with legacy { es, en }) from a card.
// Falls back to legacy example_l1/example_l2/example_sentence when examples is empty.
export function getCardExamplePairs(card) {
  const pairs = [
    ...(Array.isArray(card?.examples)
      ? card.examples.map((p) => ({
          l2: p?.l2 ?? p?.en ?? p?.example_l2 ?? p?.example_en ?? '',
          l1: p?.l1 ?? p?.es ?? p?.example_l1 ?? p?.example_es ?? '',
          en: p?.l2 ?? p?.en ?? p?.example_l2 ?? p?.example_en ?? '',
          es: p?.l1 ?? p?.es ?? p?.example_l1 ?? p?.example_es ?? '',
        }))
      : []),
    {
      l2: card?.example_l2 ?? card?.example_en ?? card?.example_sentence ?? '',
      l1: card?.example_l1 ?? card?.example_es ?? '',
      en: card?.example_l2 ?? card?.example_en ?? card?.example_sentence ?? '',
      es: card?.example_l1 ?? card?.example_es ?? '',
    },
  ];

  const out = [];
  const seen = new Set();
  for (const pair of pairs) {
    const l2 = typeof pair.l2 === 'string' ? pair.l2.trim() : '';
    const l1 = typeof pair.l1 === 'string' ? pair.l1.trim() : '';
    if (!l2 && !l1) {
      continue;
    }
    const key = `${normalizeAnswer(l1)}|${normalizeAnswer(l2)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      l2: l2 || null,
      l1: l1 || null,
      en: l2 || null,
      es: l1 || null,
    });
  }
  return out;
}

// Deterministically pick which example sentence pair this presentation displays
// (for Flashcard, Listening, TypeTranslation, etc.), rotating across repeat passes.
export function pickCardExample(card) {
  const pairs = getCardExamplePairs(card);
  if (pairs.length === 0) {
    const l1 = card?.example_l1 ?? card?.example_es ?? null;
    const l2 = card?.example_l2 ?? card?.example_en ?? card?.example_sentence ?? null;
    return {
      l1,
      l2,
      es: l1,
      en: l2,
    };
  }
  const idx = sentenceIndex(card, pairs.length);
  return pairs[idx] ?? pairs[0];
}

// Every sentence a card offers the cloze games: the primary example_l2 plus
// the additional `examples` pairs (migration 0019 / 0034), deduped by normalized
// L2 text and filtered to the ones where the answer is actually
// blankable. Each candidate carries its located span so callers never
// re-derive it against a different sentence. Cards that predate 0019 simply
// yield [primary] — exactly the old behavior.
export function clozeCandidates(card) {
  const pairs = [
    {
      l2: card?.example_l2 ?? card?.example_en,
      l1: card?.example_l1 ?? card?.example_es,
    },
    ...(Array.isArray(card?.examples)
      ? card.examples.map((p) => ({
          l2: p?.l2 ?? p?.en ?? p?.example_l2 ?? p?.example_en,
          l1: p?.l1 ?? p?.es ?? p?.example_l1 ?? p?.example_es,
        }))
      : []),
  ];
  const out = [];
  const seen = new Set();
  const answer = card?.answer_l2 ?? card?.answer_en;
  for (const pair of pairs) {
    const l2 = typeof pair.l2 === 'string' ? pair.l2 : '';
    if (!l2) {
      continue;
    }
    const key = normalizeAnswer(l2);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const span = locateAnswerInExample(l2, answer);
    if (!span) {
      continue;
    }
    const l1 = typeof pair.l1 === 'string' ? pair.l1 : null;
    out.push({
      l2,
      l1,
      en: l2,
      es: l1,
      span,
    });
  }
  return out;
}

// Find `answer` as a whole word (or whole multi-word run) inside `example`, matching
// case/diacritic-insensitively at word boundaries, and return the { start, end } span
// into the RAW example string so a cloze game can blank exactly that slice.
//
// Returns null when the answer can't be located (inflected form, multi-word split,
// or simply absent) — the caller then drops the cloze modality rather than render a
// broken blank (docs/minigames.md §4 #3, Phase 5 cloze-robustness decision).
export function locateAnswerInExample(example, answer) {
  const text = typeof example === 'string' ? example : '';
  const target = normalizeAnswer(answer);
  if (!text || !target) {
    return null;
  }

  // Tokenize the example into words, remembering each token's raw span and its
  // normalized form.
  const tokens = [];
  for (const match of text.matchAll(WORD_RE)) {
    tokens.push({
      norm: normalizeAnswer(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  if (tokens.length === 0) {
    return null;
  }

  // Tokenize the target the same way as the example, so punctuation in the
  // answer ("Where is the station?") never blocks the match — the word
  // sequence is what has to appear.
  const targetWords = target.match(WORD_RE) ?? [];
  if (targetWords.length === 0) {
    return null;
  }
  const span = targetWords.length;

  // Slide a window the width of the answer across the tokens; the first run whose
  // normalized tokens all match wins. This handles multi-word answers ("give up").
  for (let i = 0; i + span <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < span; j += 1) {
      if (tokens[i + j].norm !== targetWords[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start: tokens[i].start, end: tokens[i + span - 1].end };
    }
  }
  return null;
}
