// Explicit .js extension is required by run_browser_pipeline_tests.mjs (Node ESM resolver)
import { sentenceIndex } from './minigameFrequency.js';
import { getLanguage, getPair, LANGUAGES, standardTypoBudget } from './languages.js';

// Shared text helpers for the answer-matching minigames. Kept in one module so the
// Tier-A free-type games (Type the translation, Recall from definition, Cloze) all
// normalize and grade answers identically (classifyGuess: correct / almost / wrong),
// and so the cloze games locate the blank the same way. See docs/minigames.md §4
// (#1–#3, #6 + near-miss aside), Phase 1 & Phase 5.

// Resolve whether diacritics are phonemic/significant for this evaluation.
// Supports boolean flag, language tag string ('en', 'pl', 'tr', 'vi'), or
// an object carrying { diacriticsSignificant, language_to, l2, tag }.
function resolveDiacriticsOption(options) {
  if (typeof options === 'boolean') {
    return options;
  }
  if (typeof options === 'string') {
    const lang = getLanguage(options);
    return lang?.diacriticsSignificant ?? false;
  }
  if (options && typeof options === 'object') {
    if (typeof options.diacriticsSignificant === 'boolean') {
      return options.diacriticsSignificant;
    }
    const tag = options.language_to ?? options.l2 ?? options.tag;
    if (tag) {
      const lang = getLanguage(tag);
      return lang?.diacriticsSignificant ?? false;
    }
  }
  return false;
}

// Normalize an answer for comparison: trim + lowercase, and unify Unicode hyphens/dashes
// and curly apostrophes that show up in real card data, collapsing internal whitespace.
// Diacritic stripping is parameterised by language (P5): languages where diacritics are
// phonemic (e.g. Polish, Turkish, Vietnamese) preserve them via NFC; Tier 1 languages
// (English, Spanish, French) strip them unconditionally via NFD combining-mark removal
// to preserve baseline grading behavior by construction.
export function normalizeAnswer(value, options) {
  const diacriticsSignificant = resolveDiacriticsOption(options);
  if (diacriticsSignificant) {
    return (value ?? '')
      .normalize('NFC')
      .replace(/[‐-―−]/g, '-') // hyphens/dashes/minus -> ASCII hyphen
      .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes -> ASCII '
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }
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

// Typo budget profile: re-exported from the registry for backwards compatibility.
export { standardTypoBudget as typoBudget };

// Default English function words from the registry (backwards compatibility).
export const FUNCTION_WORDS = new Set(LANGUAGES.en.functionWords);

// True when one side equals the other with exactly one function word removed —
// "listen" for "listen to", "to give up" for "give up". Content words must all
// match exactly; anything looser is a different answer, not a near miss.
// Parameterized by language function-word set (P5).
function oneFunctionWordApart(a, b, functionWords = FUNCTION_WORDS) {
  const aTokens = a.split(' ');
  const bTokens = b.split(' ');
  const [longer, shorter] = aTokens.length >= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (longer.length !== shorter.length + 1 || shorter.length === 0) {
    return false;
  }
  for (let i = 0; i < longer.length; i += 1) {
    if (!functionWords.has(longer[i])) {
      continue;
    }
    const spliced = longer.slice(0, i).concat(longer.slice(i + 1));
    if (spliced.every((token, k) => token === shorter[k])) {
      return true;
    }
  }
  return false;
}

// Grade a free-typed guess against the primary answer and every listed synonym:
// 'correct' on an exact normalized match, 'almost' on a near miss, else 'wrong'.
// A near miss — within the typo budget of a candidate, or one dropped/added
// function word ("listen" for "listen to") — is close enough that grading it as a
// lapse would be unfair, but not exact enough to count as known. The typing games
// resolve it as NEUTRAL: amber feedback + the exact answer, advancing via the skip
// RPC so FSRS is never touched and the card recycles for a clean rep (§4 near-miss
// aside, §5.3).
//
// Parameterized by L2 via the registry (P5):
//   - diacriticsSignificant from L2 metadata (phonemic diacritics preserved)
//   - typoBudget profile from L2/script
//   - functionWords from L2 registry list
export function classifyGuess(guess, card, options) {
  const langTag = options?.language_to ?? options?.l2 ?? card?.language_to ?? card?.l2 ?? 'en';
  const lang = getLanguage(langTag) || LANGUAGES.en;
  const diacritics = lang.diacriticsSignificant ?? false;
  const budgetFn = lang.typoBudget ?? standardTypoBudget;
  const functionWords = new Set(lang.functionWords ?? []);

  const normalizedGuess = normalizeAnswer(guess, diacritics);
  if (!normalizedGuess) {
    return 'wrong';
  }

  const answer = card?.answer_l2 ?? card?.answer_en;
  const synonyms = card?.l2_synonyms ?? card?.synonyms_en ?? [];
  const candidates = [answer, ...synonyms]
    .map((c) => normalizeAnswer(c, diacritics))
    .filter(Boolean);

  if (candidates.some((candidate) => candidate === normalizedGuess)) {
    return 'correct';
  }

  for (const candidate of candidates) {
    const budget = budgetFn(candidate.length);
    if (
      budget > 0 &&
      Math.abs(candidate.length - normalizedGuess.length) <= budget &&
      editDistance(normalizedGuess, candidate) <= budget
    ) {
      return 'almost';
    }
    if (oneFunctionWordApart(normalizedGuess, candidate, functionWords)) {
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
      l2: card?.example_l2,
      l1: card?.example_l1,
    },
    ...(Array.isArray(card?.examples)
      ? card.examples.map((p) => ({
          l2: p?.l2 ?? p?.example_l2,
          l1: p?.l1 ?? p?.example_l1,
        }))
      : []),
  ];
  const out = [];
  const seen = new Set();
  const answer = card?.answer_l2;
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
    const span = locateAnswerInExample(l2, answer, card);
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

// Resolve the cloze strategy identifier ('verbatim' | 'lemma' | 'segmenter')
// from options, a pair descriptor, a card payload, or a language tag.
export function resolveClozeStrategy(options) {
  if (typeof options === 'string') {
    if (options === 'verbatim' || options === 'lemma' || options === 'segmenter') {
      return options;
    }
    const lang = getLanguage(options);
    if (lang) {
      if (lang.tierL2 === '3b' || lang.tier === '3b' || lang.script === 'Jpan' || lang.script === 'Hans' || lang.script === 'Kore') {
        return 'segmenter';
      }
      if (lang.tierL2 === 2 || lang.tier === 2) {
        return 'lemma';
      }
    }
    return 'verbatim';
  }
  if (options && typeof options === 'object') {
    if (options.strategy) return options.strategy;
    if (options.clozeStrategy) return options.clozeStrategy;
    if (options.pair?.clozeStrategy) return options.pair.clozeStrategy;
    const l1 = options.l1 ?? options.language_from;
    const l2 = options.l2 ?? options.language_to;
    if (l1 && l2) {
      const pair = getPair(l1, l2);
      if (pair?.clozeStrategy) return pair.clozeStrategy;
    }
    if (l2) {
      const lang = getLanguage(l2);
      if (lang) {
        if (lang.tierL2 === '3b' || lang.tier === '3b' || lang.script === 'Jpan' || lang.script === 'Hans' || lang.script === 'Kore') {
          return 'segmenter';
        }
        if (lang.tierL2 === 2 || lang.tier === 2) {
          return 'lemma';
        }
      }
    }
  }
  return 'verbatim';
}

// Tier 1 strategy: verbatim whole-word (or multi-word run) match inside example,
// matching case-insensitively (and diacritic-insensitively for Tier 1 languages).
// Returns { start, end } raw string slice or null.
export function locateAnswerVerbatim(example, answer, options) {
  const diacritics = resolveDiacriticsOption(options);
  const text = typeof example === 'string' ? example : '';
  const target = normalizeAnswer(answer, diacritics);
  if (!text || !target) {
    return null;
  }

  // Tokenize the example into words, remembering each token's raw span and its
  // normalized form.
  const tokens = [];
  for (const match of text.matchAll(WORD_RE)) {
    tokens.push({
      norm: normalizeAnswer(match[0], diacritics),
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

// Seam for Tier 2 lemma-aware blank locator (pt, it, de, nl).
// Deferred to Tier 2: requires morphological analysis / lemmatization
// (e.g. German separable verbs like "anrufen" -> "Ich rufe dich an").
export function locateAnswerLemma(_example, _answer, _options) {
  return null;
}

// Seam for Tier 3b segmenter blank locator (ja, zh, ko).
// Deferred to Tier 3b: requires script-aware word segmentation
// for non-space-delimited scripts (e.g. Intl.Segmenter / CJK boundary analysis).
export function locateAnswerSegmenter(_example, _answer, _options) {
  return null;
}

// Cloze blank locator strategy dispatch map (P5).
export const CLOZE_STRATEGIES = {
  verbatim: locateAnswerVerbatim,
  lemma: locateAnswerLemma,
  segmenter: locateAnswerSegmenter,
};

// Find `answer` inside `example` according to the active cloze strategy:
// 'verbatim' for Tier 1, with seams for 'lemma' (Tier 2) and 'segmenter' (Tier 3b).
//
// Returns the { start, end } span into the RAW example string so a cloze game can
// blank exactly that slice. Returns null when the answer cannot be located.
export function locateAnswerInExample(example, answer, options) {
  const strategyKey = resolveClozeStrategy(options);
  const strategy = CLOZE_STRATEGIES[strategyKey] || CLOZE_STRATEGIES.verbatim;
  return strategy(example, answer, options);
}
