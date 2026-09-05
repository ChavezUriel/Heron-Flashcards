// Writing a finished run into the learner's own decks.
//
// No new RPC is needed: `decks_insert_own` / `cards_insert_own` (migration
// 0002) already let an authenticated user create decks they own and cards in
// them, and get_home_decks() picks up any deck with user_id = auth.uid() and
// is_selected_on_home. The generated deck therefore behaves exactly like a
// market deck the user added — smart practice, minigames and FSRS included.

import { supabase } from '../supabaseClient';
import { slugify } from './deckSpec';
import { usableCards } from './generator';

const CARD_INSERT_CHUNK = 100;

// `_audits` is pipeline bookkeeping (which quality gates passed for which
// content) — it has no column, and the CLI keeps it out of the database too.
function toCardRow(card, deckId) {
  const prompt = card.l1_text ?? card.prompt_l1;
  const answer = card.l2_text ?? card.answer_l2;
  const first = card.examples?.[0] ?? null;
  return {
    deck_id: deckId,
    l1_text: prompt,
    l2_text: answer,
    is_enabled: true,
    // 'refined' is what get_home_decks/get_review_card count; a 'draft' card
    // would be invisible everywhere in the app.
    generation_phase: 'refined',
    generation_metadata: {},
    section_name: card.section_name,
    part_of_speech: card.part_of_speech,
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

// decks.slug is globally unique, so a personal deck gets a random suffix rather
// than competing with the starter decks (and with the user's own re-runs of the
// same topic).
function candidateSlug(title) {
  const base = slugify(title) || 'ai-deck';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// -> { deck, cardCount }. Throws with a readable message on failure; the caller
// shows it and can retry (nothing partial is left behind except a deck row,
// which is reused on retry via the returned id).
export async function saveJobAsDeck(job, { title, description, existingDeckId = null } = {}) {
  const cards = usableCards(job);
  if (!cards.length) {
    throw new Error('This run has no finished cards to save yet.');
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const userId = userData?.user?.id;
  if (!userId) throw new Error('You must be signed in to save a deck.');

  const deckTitle = (title ?? job.spec.title).trim();
  const deckDescription = (description ?? job.spec.description).trim();

  let deck;
  if (existingDeckId) {
    const { data, error } = await supabase
      .from('decks').select('*').eq('id', existingDeckId).single();
    if (error) throw new Error(error.message);
    deck = data;
  } else {
    // Two attempts: the suffix makes a collision very unlikely, but a retry is
    // cheaper than surfacing a unique-violation to the user.
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !deck; attempt += 1) {
      const { data, error } = await supabase
        .from('decks')
        .insert({
          slug: candidateSlug(deckTitle),
          title: deckTitle,
          description: deckDescription,
          language_from: job.spec.language_from,
          language_to: job.spec.language_to,
          user_id: userId,
          is_selected_on_home: true,
          is_enabled_in_smart_practice: true,
        })
        .select()
        .single();
      if (error) lastError = error;
      else deck = data;
    }
    if (!deck) throw new Error(lastError?.message ?? 'Could not create the deck.');
  }

  // Retrying into a deck that already has some of the cards (a chunk failed
  // halfway last time) must not duplicate them.
  let pendingCards = cards;
  if (existingDeckId) {
    const { data: existing, error } = await supabase
      .from('cards')
      .select('l1_text, l2_text')
      .eq('deck_id', deck.id)
      .eq('is_deleted', false);
    if (error) throw new Error(error.message);
    const seen = new Set(
      (existing ?? []).map((row) => `${(row.l1_text ?? '').toLowerCase()} ${(row.l2_text ?? '').toLowerCase()}`),
    );
    pendingCards = cards.filter(
      (card) => !seen.has(`${(card.l1_text ?? card.prompt_l1 ?? '').toLowerCase()} ${(card.l2_text ?? card.answer_l2 ?? '').toLowerCase()}`),
    );
  }

  let inserted = 0;
  for (let index = 0; index < pendingCards.length; index += CARD_INSERT_CHUNK) {
    const chunk = pendingCards.slice(index, index + CARD_INSERT_CHUNK).map((card) => toCardRow(card, deck.id));
    const { error } = await supabase.from('cards').insert(chunk);
    if (error) {
      const saved = { deck, cardCount: inserted };
      const failure = new Error(
        `Saved the deck but only ${inserted} of ${pendingCards.length} cards: ${error.message}`,
      );
      failure.partial = saved;
      throw failure;
    }
    inserted += chunk.length;
  }

  return { deck, cardCount: inserted };
}
