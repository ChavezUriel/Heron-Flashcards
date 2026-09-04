// Shared accent-insensitive text search used by the home deck search and the
// deck explorer table. All matching happens on normalized text: lowercase,
// diacritics stripped, punctuation collapsed to single spaces.

export function normalizeSearchText(value) {
  if (value == null) return '';
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Score how well a single field matches an already-normalized query.
// 120 exact · 90 prefix · 70 substring · 50 all terms · 20+n some terms.
export function scoreFieldMatch(fieldValue, query) {
  if (!fieldValue) return 0;
  const normalizedField = normalizeSearchText(fieldValue);
  if (!normalizedField) return 0;
  if (normalizedField === query) return 120;
  if (normalizedField.startsWith(query)) return 90;
  if (normalizedField.includes(query)) return 70;
  const queryTerms = query.split(' ');
  const matchedTerms = queryTerms.filter((term) => normalizedField.includes(term)).length;
  return matchedTerms === queryTerms.length ? 50 : matchedTerms > 0 ? 20 + matchedTerms : 0;
}

// Normalize one original string the same way normalizeSearchText does, but
// character by character so every normalized index maps back to the index of
// the original character it came from. Whitespace is NOT collapsed here —
// that would break the index map — so multi-term queries are matched term by
// term instead of as a whole phrase.
function normalizeWithIndexMap(text) {
  const lower = (text ?? '').toLowerCase();
  const chars = [];
  const map = [];
  for (let index = 0; index < lower.length; index += 1) {
    const decomposed = lower[index].normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const char of decomposed) {
      chars.push(/[\p{L}\p{N}]/u.test(char) ? char : ' ');
      map.push(Math.min(index, (text ?? '').length - 1));
    }
  }
  return { normalized: chars.join(''), map };
}

// Split `text` into { text, isMatch } segments marking every occurrence of
// every term of the normalized query, for <mark>-style highlighting. Returns
// a single non-match segment when nothing matches.
export function buildHighlightSegments(text, normalizedQuery) {
  if (!text || !normalizedQuery) {
    return [{ text: text ?? '', isMatch: false }];
  }

  const { normalized, map } = normalizeWithIndexMap(text);
  const terms = normalizedQuery.split(' ').filter(Boolean);
  const isMarked = new Array(text.length).fill(false);
  let foundAny = false;

  for (const term of terms) {
    let searchFrom = 0;
    for (;;) {
      const at = normalized.indexOf(term, searchFrom);
      if (at === -1) break;
      foundAny = true;
      for (let i = at; i < at + term.length; i += 1) {
        isMarked[map[i]] = true;
      }
      searchFrom = at + term.length;
    }
  }

  if (!foundAny) {
    return [{ text, isMatch: false }];
  }

  const segments = [];
  let segmentStart = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || isMarked[i] !== isMarked[segmentStart]) {
      segments.push({ text: text.slice(segmentStart, i), isMatch: isMarked[segmentStart] });
      segmentStart = i;
    }
  }
  return segments;
}
