import { supabase } from '../supabaseClient';
import { applyCardAiPatches } from '../api';
import { CARD_STATUS } from './generator';

const PATCH_CHUNK = 50;
const INSERT_CHUNK = 100;

function toCardRow(card, deckId) {
  const first = card.examples?.[0] ?? null;
  return {
    deck_id: deckId,
    spanish_text: card.spanish_text,
    english_text: card.english_text,
    is_enabled: true,
    generation_phase: 'refined',
    generation_metadata: {},
    section_name: card.section_name ?? null,
    part_of_speech: card.part_of_speech ?? null,
    definition_en: card.definition_en ?? null,
    main_translations_es: card.main_translations_es ?? [],
    collocations: card.collocations ?? [],
    synonyms_en: card.synonyms_en ?? [],
    example_sentence: card.example_sentence ?? (first?.en ?? null),
    example_es: card.example_es ?? (first?.es ?? null),
    example_en: card.example_en ?? (first?.en ?? null),
    mnemonic_en: card.mnemonic_en ?? null,
    cloze_distractors_en: card.cloze_distractors_en ?? [],
    examples: card.examples ?? [],
  };
}

export async function applyFillJob(job, { selectedIds = null } = {}) {
  if (!job || !Array.isArray(job.cards)) {
    throw new Error('No cards to apply.');
  }

  const targetDeckId = job.targetDeck?.id;

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
  const newCardRows = [];

  for (const card of cards) {
    const cardId = card.card_id ?? card._before?.card_id ?? card.id;
    if (!cardId) continue;

    // Check if multiple mismatch fixes were selected
    if (targetDeckId && card._pair_mismatch?.fixes?.length > 1) {
      const selectedFixes = card._pair_mismatch.fixes.filter((f) => f._selected !== false);
      if (selectedFixes.length >= 2) {
        // Fix 0 updates existing card, Fix 1 (and any subsequent) is added as a new card
        for (let i = 1; i < selectedFixes.length; i += 1) {
          newCardRows.push(toCardRow(selectedFixes[i], targetDeckId));
        }
      }
    }

    let patch = card._patch || {};
    if (card._rejectedFields && card._rejectedFields.length > 0) {
      const rejected = new Set(card._rejectedFields);
      patch = Object.fromEntries(
        Object.entries(patch).filter(([key]) => !rejected.has(key))
      );
    }
    if (Object.keys(patch).length > 0) {
      patchItems.push({ card_id: Number(cardId), patch });
    }
  }

  let applied = 0;
  if (patchItems.length > 0) {
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
  }

  let insertedCount = 0;
  if (newCardRows.length > 0) {
    for (let index = 0; index < newCardRows.length; index += INSERT_CHUNK) {
      const chunk = newCardRows.slice(index, index + INSERT_CHUNK);
      const { error } = await supabase.from('cards').insert(chunk);
      if (error) {
        console.error('Failed to insert new candidate card rows:', error);
      } else {
        insertedCount += chunk.length;
      }
    }
  }

  return { appliedCount: applied, insertedCount, totalCards: cards.length };
}
