import { supabase } from '../supabaseClient';
import { applyCardAiPatches } from '../api';
import { CARD_STATUS } from './generator';

const PATCH_CHUNK = 50;
const INSERT_CHUNK = 100;

function toCardRow(card, deckId) {
  const first = card.examples?.[0] ?? null;
  const prompt = card.l1_text ?? card.prompt_l1;
  const answer = card.l2_text ?? card.answer_l2;
  return {
    deck_id: deckId,
    l1_text: prompt,
    l2_text: answer,
    is_enabled: true,
    generation_phase: 'refined',
    generation_metadata: {},
    section_name: card.section_name ?? null,
    part_of_speech: card.part_of_speech ?? null,
    l2_definition: card.l2_definition ?? null,
    l1_translations: card.l1_translations ?? [],
    collocations: card.collocations ?? [],
    l2_synonyms: card.l2_synonyms ?? [],
    example_sentence: card.example_sentence ?? (first?.l2 ?? null),
    example_l1: card.example_l1 ?? (first?.l1 ?? null),
    example_l2: card.example_l2 ?? (first?.l2 ?? null),
    l2_mnemonic: card.l2_mnemonic ?? null,
    l2_cloze_distractors: card.l2_cloze_distractors ?? [],
    examples: (card.examples ?? []).map((p) => ({
      l1: p.l1 ?? p.example_l1,
      l2: p.l2 ?? p.example_l2,
    })),
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
