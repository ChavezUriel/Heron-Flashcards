import { supabase } from './supabaseClient';

// ---------------------------------------------------------------------------
// Internal helper: call a Postgres RPC and unwrap the result / error.
// Every endpoint of the old FastAPI backend is now a SECURITY DEFINER RPC that
// returns the same JSON shape the frontend already consumed.
// ---------------------------------------------------------------------------
async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    throw new Error(error.message || 'Request failed');
  }
  return data;
}

// ===========================================================================
// Auth (Supabase Auth)
// ===========================================================================
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function register(email, fullName, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) throw new Error(error.message);
  return data; // { user, session } — session is null when email confirmation is required
}

export async function loginWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) throw new Error(error.message);
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function fetchMe() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const user = data.user;
  if (!user) throw new Error('Not authenticated');
  let ui_locale = null;
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('ui_locale')
      .eq('id', user.id)
      .maybeSingle();
    if (profile) {
      ui_locale = profile.ui_locale ?? null;
    }
  } catch (_e) {
    // Ignore profile fetch error if table is inaccessible
  }

  return {
    id: user.id,
    email: user.email,
    full_name: user.user_metadata?.full_name || 'User',
    created_at: user.created_at,
    ui_locale: ui_locale,
  };
}

export async function updateUiLocale(uiLocale) {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const userId = data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ ui_locale: uiLocale })
    .eq('id', userId);
  if (profileError) throw new Error(profileError.message);
  return uiLocale;
}

export async function updateNickname(nickname) {
  const { data, error } = await supabase.auth.updateUser({ data: { full_name: nickname } });
  if (error) throw new Error(error.message);
  // Keep the profiles row (used by the DB side) in sync with auth metadata
  // (used by the app). RLS allows updating your own row.
  const userId = data.user?.id;
  if (userId) {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ full_name: nickname })
      .eq('id', userId);
    if (profileError) throw new Error(profileError.message);
  }
  return data.user;
}

export async function fetchUserIdentities() {
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error) throw new Error(error.message);
  return data?.identities ?? [];
}

export async function linkGoogleIdentity() {
  // Redirects to Google and back; requires manual linking to be enabled in
  // the Supabase dashboard (Authentication → Providers → Allow manual linking).
  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/settings` },
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function unlinkUserIdentity(identity) {
  const { error } = await supabase.auth.unlinkIdentity(identity);
  if (error) throw new Error(error.message);
}

// Whether the current user has a password set. Supabase does not expose this on
// the user object, and an `email` identity is NOT created when a Google-first
// user sets a password, so we read auth.users.encrypted_password server-side.
export async function hasPassword() {
  return Boolean(await rpc('has_password'));
}

// Back-fill the `email` identity for a password-having user who lacks one. This
// is what lets GoTrue (which requires >= 2 identities) unlink Google afterwards.
// Idempotent; returns true once the email identity exists.
export async function ensureEmailIdentity() {
  return Boolean(await rpc('ensure_email_identity'));
}

// ===========================================================================
// Account management
// ===========================================================================
export function deleteAccount() {
  return rpc('delete_account');
}

// PostgREST caps a single response at 1000 rows; page until a short page.
const EXPORT_PAGE_SIZE = 1000;

async function fetchAllRows(buildQuery) {
  const rows = [];
  for (let page = 0; ; page += 1) {
    const from = page * EXPORT_PAGE_SIZE;
    const { data, error } = await buildQuery().range(from, from + EXPORT_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < EXPORT_PAGE_SIZE) {
      return rows;
    }
  }
}

export async function exportAccountData() {
  const me = await fetchMe();
  const decks = await fetchAllRows(() =>
    supabase.from('decks').select('*').eq('user_id', me.id).order('id'),
  );
  const deckIds = decks.map((deck) => deck.id);
  const cards = deckIds.length > 0
    ? await fetchAllRows(() =>
        supabase.from('cards').select('*').in('deck_id', deckIds).eq('is_deleted', false).order('id'),
      )
    : [];
  const progress = await fetchAllRows(() =>
    supabase.from('card_progress').select('*').eq('user_id', me.id).order('card_id'),
  );

  const cardsByDeckId = new Map(deckIds.map((deckId) => [deckId, []]));
  for (const card of cards) {
    cardsByDeckId.get(card.deck_id)?.push(card);
  }

  return {
    format: 'duocards-clone-export',
    version: 1,
    exported_at: new Date().toISOString(),
    account: { id: me.id, email: me.email, nickname: me.full_name },
    decks: decks.map((deck) => ({ ...deck, cards: cardsByDeckId.get(deck.id) ?? [] })),
    card_progress: progress,
  };
}

// ===========================================================================
// Decks
// ===========================================================================
export function fetchDecks() {
  return rpc('get_home_decks');
}

export function fetchHomeDecks() {
  return rpc('get_home_decks');
}

export function fetchMarketDecks() {
  return rpc('get_market_decks');
}

export function updateDeckSmartPracticeInclusion(deckId, isEnabledInSmartPractice) {
  return rpc('update_deck_smart_practice_inclusion', {
    p_deck_id: deckId,
    p_is_enabled_in_smart_practice: isEnabledInSmartPractice,
  });
}

export async function updateDeckHomeSelection(deckId, isSelectedOnHome) {
  try {
    return await rpc('update_deck_home_selection', {
      p_deck_id: deckId,
      p_is_selected_on_home: isSelectedOnHome,
    });
  } catch (rpcError) {
    // Defense-in-depth fallback
    const me = await fetchMe();
    const { error } = await supabase
      .from('decks')
      .update({ is_selected_on_home: isSelectedOnHome })
      .eq('id', deckId)
      .eq('user_id', me.id);
    if (error) throw new Error(error.message || rpcError.message);
    return { deck_id: deckId, is_selected_on_home: isSelectedOnHome };
  }
}

export function fetchReviewCard(deckId) {
  return rpc('get_review_card', { p_deck_id: deckId });
}

export function submitReview(cardId, result) {
  return rpc('submit_review', { p_card_id: cardId, p_result: result });
}

// Undo the last per-deck review. Restores the card's pre-review progress and
// returns the ReviewCard JSON so the caller can show it again.
export function undoReview() {
  return rpc('undo_review');
}

export function fetchDeckProgress(deckId) {
  return rpc('get_deck_progress', { p_deck_id: deckId });
}

export function fetchDeckPreview(deckId) {
  return rpc('get_deck_preview', { p_deck_id: deckId });
}

export function fetchDeckCardsForAi(deckId) {
  return rpc('get_deck_cards_for_ai', { p_deck_id: deckId });
}

export function applyCardAiPatch(cardId, patch) {
  return rpc('apply_card_ai_patch', { p_card_id: cardId, p_patch: patch });
}

export function applyCardAiPatches(patches) {
  return rpc('apply_card_ai_patches', { p_patches: patches });
}

// Publish a standalone personal deck to the public community Market
export function publishUserDeck(deckId, safetyAudit = {}) {
  return rpc('publish_user_deck', {
    p_deck_id: deckId,
    p_safety_audit: safetyAudit,
  });
}

// Delete a personal deck (standalone personal deck or personal copy of a market deck)
export async function deletePersonalDeck(deckId) {
  try {
    return await rpc('delete_personal_deck', { p_deck_id: deckId });
  } catch (rpcError) {
    // Defense-in-depth fallback if RPC is not yet loaded: direct delete on user-owned deck
    const me = await fetchMe();
    const { error } = await supabase
      .from('decks')
      .delete()
      .eq('id', deckId)
      .eq('user_id', me.id);
    if (error) throw new Error(error.message || rpcError.message);
    return { success: true, deck_id: deckId };
  }
}


// ===========================================================================
// Cards
// ===========================================================================
export function updateCardVisibility(cardId, isEnabled) {
  return rpc('update_card_visibility', { p_card_id: cardId, p_is_enabled: isEnabled });
}

// Flip a whole batch of cards at once, for the deck explorer's "Hide/Show all"
// menu. The caller passes the exact ids to act on — the menu scopes them to the
// rows the current search and filter leave on screen. All-or-nothing: one
// unauthorized id rejects the batch.
export function updateCardsVisibility(cardIds, isEnabled) {
  return rpc('update_cards_visibility', { p_card_ids: cardIds, p_is_enabled: isEnabled });
}

export function deleteCard(cardId) {
  return rpc('delete_card', { p_card_id: cardId });
}

export function deleteCards(cardIds) {
  return rpc('delete_cards', { p_card_ids: cardIds });
}

export function updateCard(cardId, payload) {
  return rpc('update_card', {
    p_card_id: cardId,
    p_prompt_l1: payload.prompt_l1,
    p_answer_l2: payload.answer_l2,
    p_section_name: payload.section_name ?? null,
    p_part_of_speech: payload.part_of_speech ?? null,
    p_l2_definition: payload.l2_definition ?? null,
    p_l1_translations: payload.l1_translations ?? [],
    p_collocations: payload.collocations ?? [],
    p_l2_synonyms: payload.l2_synonyms ?? [],
    p_example_sentence: payload.example_sentence ?? null,
    p_example_l1: payload.example_l1 ?? null,
    p_example_l2: payload.example_l2 ?? null,
    p_l2_mnemonic: payload.l2_mnemonic ?? null,
    p_examples: payload.examples ?? null,
  });
}

// ===========================================================================
// Market sync & change proposals (migration 0017)
// ===========================================================================

// Pending updates for MY copy of a market deck: { linked, added, changed,
// removed, deck_meta, total_updates }. Also fast-forwards no-op drift.
export function fetchDeckSyncStatus(deckId) {
  return rpc('get_deck_sync_status', { p_deck_id: deckId });
}

// Apply a selected subset of pending updates. `changes` is an array of
// {type:'add'|'update', base_card_id} | {type:'remove', card_id} | {type:'deck_meta'}.
// Returns { applied, skipped, status } with the refreshed sync status.
export function applyDeckSync(deckId, changes) {
  return rpc('apply_deck_sync', { p_deck_id: deckId, p_changes: changes });
}

// Cards I edited locally that still differ from the live market deck —
// the candidates for a change proposal.
export function fetchDeckOutgoingChanges(deckId) {
  return rpc('get_deck_outgoing_changes', { p_deck_id: deckId });
}

// Submit selected cards of my copy as a proposal ("pull request") to the
// market deck. The server derives all content from my real cards.
export function createDeckChangeProposal(marketDeckId, message, userCardIds) {
  return rpc('create_deck_change_proposal', {
    p_market_deck_id: marketDeckId,
    p_message: message ?? null,
    p_user_card_ids: userCardIds,
  });
}

// { to_review: [...], mine: [...] } — proposals on decks I maintain and
// proposals I submitted, each with per-item payload/base/current diffs.
export function listDeckProposals() {
  return rpc('list_deck_proposals');
}

// Maintainer decision. action: 'approve' | 'reject'. Approval writes the
// proposal into the market deck, which flags updates for every subscriber.
export function resolveDeckChangeProposal(proposalId, action, note) {
  return rpc('resolve_deck_change_proposal', {
    p_proposal_id: proposalId,
    p_action: action,
    p_note: note ?? null,
  });
}

export function withdrawDeckChangeProposal(proposalId) {
  return rpc('withdraw_deck_change_proposal', { p_proposal_id: proposalId });
}

// Become the maintainer of an unmaintained market deck.
export function claimMarketDeck(deckId) {
  return rpc('claim_market_deck', { p_deck_id: deckId });
}

// Hand a market deck I maintain to another registered user.
export function transferMarketDeckOwnership(deckId, email) {
  return rpc('transfer_market_deck_ownership', {
    p_deck_id: deckId,
    p_new_owner_email: email,
  });
}

// ===========================================================================
// Spaced repetition
// ===========================================================================
export function fetchDueSummary() {
  return rpc('get_due_summary');
}

// ===========================================================================
// Smart practice
// ===========================================================================
export function startSmartPracticeSession(settings = {}) {
  return rpc('start_smart_practice_session', {
    p_new_block_size: settings.new_block_size ?? 7,
    p_review_batch_size: settings.review_batch_size ?? 30,
    p_focus_mode: settings.focus_mode ?? 'auto',
  });
}

export function getSmartPracticeSession(sessionId) {
  return rpc('get_smart_practice_session', { p_session_id: sessionId });
}

export function submitSmartPracticeReview(sessionId, cardId, result) {
  return rpc('submit_smart_practice_review', {
    p_session_id: sessionId,
    p_card_id: cardId,
    p_result: result,
  });
}

// Undo the last smart-practice review. Reverses the FSRS update and the queue
// move, reactivates the session if it had just finished, and returns the
// refreshed session snapshot (with the undone card current again).
export function undoSmartPracticeReview(sessionId) {
  return rpc('undo_smart_practice_review', { p_session_id: sessionId });
}

// Plausible wrong answers for a recognition minigame. Returns an array of option
// strings; the caller shuffles them together with the real answer. `side` picks
// the flavor: 'l2' (default, sibling l2_text — multiple choice), 'l1'
// (sibling l1_text — reverse MC), or 'cloze' (word-bank cloze — the card's
// curated l2_cloze_distractors, verified so only the real answer fits the blank,
// falling back to sibling l2_text). Legacy 'en' and 'es' aliases remain supported.
export function getMinigameDistractors(cardId, n = 3, side = 'l2') {
  const args = { p_card_id: cardId, p_n: n };
  if (side && side !== 'l2' && side !== 'en') {
    args.p_side = side;
  }
  return rpc('get_minigame_distractors', args);
}

// Best-effort minigame telemetry (docs/minigames.md §10, §9 Phase 6). Records one
// play — the game id, its outcome ('known' | 'unknown' | 'skip' | a depth result),
// and whether it counted toward FSRS. Purely additive analytics, NEVER read by the
// scheduler. Deliberately swallows every error (including a missing session): a
// failed log must never disrupt a review, so callers fire-and-forget it.
export async function logMinigamePlay(cardId, game, outcome, counted = false) {
  try {
    await supabase.rpc('log_minigame_play', {
      p_card_id: cardId ?? null,
      p_game: game,
      p_outcome: outcome,
      p_counted: Boolean(counted),
    });
  } catch {
    /* telemetry is best-effort — never surface a logging failure in practice */
  }
}

// Advance the current smart-practice card WITHOUT grading it — used for a Tier-B
// recognition win, which must never touch the FSRS schedule or the graduation
// streak. Returns a fresh session snapshot (same shape as the session in
// submitSmartPracticeReview's response). See docs/minigames.md §5.3.
export function skipSmartPracticeCard(sessionId, cardId) {
  return rpc('skip_smart_practice_card', { p_session_id: sessionId, p_card_id: cardId });
}

// Hide the current smart-practice card from the deck (is_enabled = false) and drop
// only it from the running session, then advance. Unlike updateCardVisibility this
// leaves the rest of the deck's queued cards in place. Returns a fresh session
// snapshot (same shape as skipSmartPracticeCard). Backs the "Hide card" action in
// the practice card-details modal.
export function hideSmartPracticeCard(sessionId, cardId) {
  return rpc('hide_smart_practice_card', { p_session_id: sessionId, p_card_id: cardId });
}
