// Node mirror of the cloze-locating helpers in frontend/src/minigameText.js.
// The generator pipeline validates that a card's English answer can be blanked
// out of example_l2 (legacy example_en) with EXACTLY the same rule the app uses to gate the cloze
// minigames (locateAnswerInExample), so "cloze-eligible" means the same thing
// on both sides. Keep normalizeAnswer/locateAnswerInExample in sync with the
// frontend module; only the pieces the pipeline needs are mirrored here.

// Normalize an answer for comparison: trim + lowercase + strip diacritics, and
// unify the Unicode hyphens/dashes and curly apostrophes that show up in real
// card data, collapsing internal whitespace.
function normalizeAnswer(value) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[‐-―−]/g, '-') // hyphens/dashes/minus -> ASCII hyphen
    .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes -> ASCII '
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// A word token: a Unicode letter run, allowing internal apostrophes/hyphens so
// "don't" and "hold-up" stay single tokens.
const WORD_RE = /\p{L}[\p{L}\p{M}'’-]*/gu;

// Find `answer` as a whole word (or whole multi-word run) inside `example`,
// matching case/diacritic-insensitively at word boundaries, and return the
// { start, end } span into the RAW example string. Returns null when the
// answer can't be located (inflected form, multi-word split, or absent).
function locateAnswerInExample(example, answer) {
  const text = typeof example === 'string' ? example : '';
  const target = normalizeAnswer(answer);
  if (!text || !target) {
    return null;
  }

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

// The blanked English example ("I need to renew my ____ before traveling.") —
// what the word-bank cloze shows, and what the audit/distractor prompts reason
// about. Returns null when the answer isn't locatable.
function blankedExample(example, answer) {
  const span = locateAnswerInExample(example, answer);
  if (!span) return null;
  return example.slice(0, span.start) + '____' + example.slice(span.end);
}

// Small, stable, non-cryptographic content hash (FNV-1a). Kept identical to
// frontend/src/ai/cardText.js so CLI and browser compute identical audit fingerprints.
function contentHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

module.exports = { normalizeAnswer, locateAnswerInExample, blankedExample, contentHash };
