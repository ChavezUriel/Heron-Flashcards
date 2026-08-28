// Writing approved card fill patches back to existing cards in Postgres.
//
// The sibling of saveDeck.js: takes approved card ids, builds partial patches
// from each card's _patch, chunks through applyCardAiPatches in batches of ~50,
// and reports partial failure (error.partial) if a chunk fails midway.

import { applyCardAiPatches } from '../api';
import { CARD_STATUS } from './generator';

const PATCH_CHUNK = 50;

export async function applyFillJob(job, { selectedIds = null } = {}) {
  if (!job || !Array.isArray(job.cards)) {
    throw new Error('No cards to apply.');
  }

  const cards = job.cards.filter((card) => {
    if (card._status === CARD_STATUS.failed) return false;
    if (selectedIds) {
      return selectedIds.includes(card.card_id ?? card.id);
    }
    return card._selected !== false;
  });

  if (cards.length === 0) {
    throw new Error('No selected cards to apply.');
  }

  const patchItems = [];
  for (const card of cards) {
    const cardId = card.card_id ?? card._before?.card_id ?? card.id;
    if (!cardId) continue;
    const patch = card._patch || {};
    if (Object.keys(patch).length > 0) {
      patchItems.push({ card_id: Number(cardId), patch });
    }
  }

  if (patchItems.length === 0) {
    return { appliedCount: 0, totalCards: cards.length };
  }

  let applied = 0;
  for (let index = 0; index < patchItems.length; index += PATCH_CHUNK) {
    const chunk = patchItems.slice(index, index + PATCH_CHUNK);
    try {
      await applyCardAiPatches(chunk);
      applied += chunk.length;
    } catch (err) {
      const failure = new Error(
        `Applied ${applied} of ${patchItems.length} card patches: ${err.message}`,
      );
      failure.partial = { appliedCount: applied, totalPatches: patchItems.length };
      throw failure;
    }
  }

  return { appliedCount: applied, totalCards: cards.length };
}
