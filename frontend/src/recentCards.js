// A small rolling pool of recently *seen* practice cards, persisted to
// localStorage. The session snapshot only ever exposes one `current_card` at a
// time, so a warm-up interstitial — which runs *before* the first card of a
// session (docs/minigames.md §6.1) — has no in-session pool to draw from. Keeping
// the last few words the user studied lets the warm-up genuinely "re-activate
// prior words" across sessions. Only the fields a boundary game needs are stored,
// and the list is capped, so the blob stays tiny. See the Phase 3 open decision on
// the card pool (no backend change).
const STORAGE_KEY = 'duocards.recentPracticeCards';
const CAP = 24;
// Keep only a handful of synonyms per card so the blob stays small; the depth game
// (Synonym match, §9 Phase 6) needs just a couple to build a round.
const SYNONYM_CAP = 6;

// Trim a card's English synonyms to a small, clean array of non-empty strings.
// Older stored blobs predate this field and simply yield [] (those cards then just
// aren't eligible as a Synonym-match anchor).
function slimSynonyms(synonyms) {
  if (!Array.isArray(synonyms)) {
    return [];
  }
  const out = [];
  for (const raw of synonyms) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) {
      out.push(text);
    }
    if (out.length >= SYNONYM_CAP) {
      break;
    }
  }
  return out;
}

function slimCard(card) {
  if (!card || card.card_id == null) {
    return null;
  }
  const prompt = (card.prompt_l1 ?? card.prompt_es ?? '').trim();
  const answer = (card.answer_l2 ?? card.answer_en ?? '').trim();
  if (!prompt || !answer) {
    return null;
  }
  const synonyms = slimSynonyms(card.l2_synonyms ?? card.synonyms_en);
  return {
    card_id: card.card_id,
    prompt_l1: prompt,
    answer_l2: answer,
    prompt_es: prompt,
    answer_en: answer,
    section_name: card.section_name ?? null,
    // Carried for the depth game only; boundary games ignore it. See §9 Phase 6.
    l2_synonyms: synonyms,
    synonyms_en: synonyms,
  };
}

export function loadRecentCards() {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(slimCard).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Newest-first, de-duped by card_id, capped. An incoming card supersedes any
// older copy of the same card, keeping its position fresh.
export function mergeRecentCards(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const card of [...(incoming ?? []), ...(existing ?? [])]) {
    const slim = slimCard(card);
    if (!slim || seen.has(slim.card_id)) {
      continue;
    }
    seen.add(slim.card_id);
    merged.push(slim);
    if (merged.length >= CAP) {
      break;
    }
  }
  return merged;
}

export function saveRecentCards(cards) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify((cards ?? []).slice(0, CAP)));
  } catch {
    /* storage full or unavailable — the warm-up pool is best-effort */
  }
}
