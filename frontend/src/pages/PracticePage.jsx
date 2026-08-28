import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMinigameDistractors,
  hideSmartPracticeCard,
  logMinigamePlay,
  skipSmartPracticeCard,
  startSmartPracticeSession,
  submitSmartPracticeReview,
  undoSmartPracticeReview,
  updateCard,
} from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import MinigameHost, { recognitionSide, resolveModality, selectModality } from '../components/MinigameHost';
import InterstitialHost from '../components/InterstitialHost';
import { loadPracticeSettings } from '../practiceSettings';
import { chooseInterstitialGame, isInterstitialPlacementEnabled } from '../minigameFrequency';
import { loadRecentCards, mergeRecentCards, saveRecentCards } from '../recentCards';
import { loadDepthStat } from '../depthStat';

const FIRST_IDLE_HINT_DELAY_MS = 10000;

// Distractor cache key. A card can back an English recognition round (multiple
// choice: 'en'), a curated cloze round (word-bank cloze: 'cloze', migration 0018)
// or a Spanish one (reverse MC: 'es'), so its distractors are cached per
// (card, side) — never mixing the flavors. See docs/minigames.md §8.3.
function distractorKey(cardId, side) {
  return `${cardId}:${side}`;
}

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M9 5 4 10l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 10h9a6 6 0 0 1 6 6v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function modeLabel(mode) {
  if (mode === 'new_material') return 'New Material';
  if (mode === 'mixed') return 'Mixed Practice';
  return 'Review Stack';
}

// The auto-chosen shape of a mixed session (see the Auto ruleset in
// start_smart_practice_session); null for single-kind sessions.
function sessionShapeLabel(shape) {
  if (shape === 'front_loaded') return 'warm-up';
  if (shape === 'spread') return 'spread';
  if (shape === 'interleaved') return 'interleaved';
  return null;
}

// Kept to ~31 characters so the pill stays on one line at phone widths — see
// .practice-feedback-slot, which reserves exactly one line of height.
function feedbackMessage(feedback) {
  if (!feedback) {
    return '';
  }

  if (feedback.repeats_in_session) {
    return feedback.result === 'known' ? 'Almost there — one more pass.' : 'No problem — it comes back soon.';
  }

  const days = feedback.interval_days;
  if (!days || days < 1) {
    return 'Scheduled for review soon.';
  }
  if (days === 1) {
    return 'Next review tomorrow.';
  }
  if (days >= 60) {
    return `Locked in — review in ${Math.round(days / 30)} months.`;
  }
  return `Next review in ${days} days.`;
}

function PracticePage() {
  const [session, setSession] = useState(null);
  // Read once at mount, same as the session start below; MinigameHost uses these
  // to decide each card's answer modality (Phase 0: always the classic flashcard).
  const [practiceSettings] = useState(() => loadPracticeSettings());
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [isSavingCard, setIsSavingCard] = useState(false);
  const [isIdleHintVisible, setIsIdleHintVisible] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState(null);
  const idleHintTimeoutRef = useRef(null);
  const hasShownIdleHintRef = useRef(false);
  const feedbackTimeoutRef = useRef(null);
  const flashcardActionsRef = useRef(null);
  // Per-session cache of minigame distractors, keyed by (card_id, side). Cards cycle
  // through the queue repeatedly, so caching a card's distractors on first fetch
  // makes every later presentation instant (docs/minigames.md §8.3, §12 latency).
  // The counter just forces a re-render when an async fetch settles.
  const distractorCacheRef = useRef(new Map());
  const [, setDistractorVersion] = useState(0);
  // Queue-external interstitial currently overlaying the card slot, or null. When
  // set it fully replaces the card / complete panel and drives its own keyboard,
  // so the classic handlers below stay inert (docs/minigames.md §6.1, §8.4).
  const [activeInterstitial, setActiveInterstitial] = useState(null);
  // Rolling pool of words seen this session, seeded from prior sessions so a
  // warm-up (which runs before the first card) has material to draw from. Boundary
  // games sample from here; nothing here reaches the FSRS schedule.
  const seenCardsRef = useRef(loadRecentCards());
  // One interstitial per placement per session: warm-up considered once at start,
  // one break at the new→review boundary, one cool-down on completion (§6.3).
  const warmupConsideredRef = useRef(false);
  const boundaryShownRef = useRef(false);
  const cooldownConsideredRef = useRef(false);

  // Master switch off => byte-for-byte the classic app (§7.3): force the effective
  // frequency to 'off' so NO queue-external interstitial (warm-up / boundary /
  // cool-down) can fire either. selectModality already returns 'classic' per card
  // when disabled, but the interstitials key off frequency alone — and the Settings
  // UI leaves the stored frequency dial untouched when you flip minigames off, so
  // reading it directly would still surface interstitials (and a synonym-match
  // cool-down would even log a play). Gating here keeps the always-safe default whole.
  const minigamesEnabled = practiceSettings?.minigames?.enabled ?? false;
  const minigameFrequency = minigamesEnabled
    ? (practiceSettings?.minigames?.frequency ?? 'balanced')
    : 'off';
  const isInterstitialActive = activeInterstitial !== null;

  useEffect(() => () => {
    if (feedbackTimeoutRef.current) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
  }, []);

  // The classic flashcard is the only arrow-driven modality. Other modalities
  // (typing, multiple choice) own their own input and keyboard handling, so the
  // global reveal/swipe shortcuts and the idle swipe hint stay inert for them.
  // Reads through the distractor cache (distractorVersion re-triggers this on
  // fetch), so a multiple-choice card that falls back to classic for want of
  // distractors correctly re-enables the arrow handlers. See docs/minigames.md §8.4.
  const currentCard = session?.current_card ?? null;
  // Derive the provisional modality first so we can look up the right distractor side
  // ('en' vs 'es'); resolveModality re-derives the same pick and confirms the entry.
  const currentSide = currentCard ? recognitionSide(selectModality(currentCard, practiceSettings)) : null;
  const currentDistractorEntry = currentCard && currentSide
    ? distractorCacheRef.current.get(distractorKey(currentCard.card_id, currentSide))
    : undefined;
  const currentModality = currentCard
    ? resolveModality(currentCard, practiceSettings, currentDistractorEntry)
    : 'classic';
  const isClassicModality = currentModality === 'classic';

  // Build an interstitial for a placement, or null when the frequency doesn't
  // allow it here or the seen-cards pool can't fill any enabled boundary game.
  // Pre-samples the pool so the choice is stable for the life of the overlay.
  function planInterstitial(placement) {
    if (!isInterstitialPlacementEnabled(minigameFrequency, placement)) {
      return null;
    }
    // Cool-down alternates its game by how many cards were completed, so a run of
    // sessions doesn't always end on the same one (§6.3, deterministic — not a
    // second randomizer). Warm-up / boundary key off the placement alone.
    const seed = placement === 'cooldown' ? (session?.summary?.completed_cards ?? 0) : 0;
    const choice = chooseInterstitialGame(placement, seenCardsRef.current, practiceSettings, seed);
    return choice ? { placement, game: choice.game, cards: choice.cards } : null;
  }

  // Show a one-off break when a mixed session crosses from its new block into
  // reviews (remaining_new hits 0 while reviews remain), ~1 per transition (§6.3).
  // Both graded and skipped advances can trip the boundary, so this runs from
  // resolveCard with the summary captured before the queue moved.
  // Returns true when it takes over the screen, so the caller can suppress the
  // scheduling toast that would otherwise sit on top of the interstitial.
  function maybeShowBoundaryInterstitial(previousSummary, nextSession) {
    if (boundaryShownRef.current) {
      return false;
    }
    const next = nextSession?.summary;
    // Completion is the cool-down's job, not the boundary's.
    if (!next || !nextSession?.current_card || next.mode !== 'mixed') {
      return false;
    }
    const crossedNewToReview =
      (previousSummary?.remaining_new ?? 0) > 0 && next.remaining_new === 0 && (next.remaining_review ?? 0) > 0;
    if (!crossedNewToReview) {
      return false;
    }
    const plan = planInterstitial('boundary');
    if (!plan) {
      return false;
    }
    boundaryShownRef.current = true;
    setActiveInterstitial(plan);
    return true;
  }

  function handleInterstitialDone() {
    setActiveInterstitial(null);
  }

  function clearIdleHintTimer() {
    if (idleHintTimeoutRef.current) {
      window.clearTimeout(idleHintTimeoutRef.current);
      idleHintTimeoutRef.current = null;
    }
  }

  function scheduleIdleHint() {
    clearIdleHintTimer();

    if (typeof window === 'undefined') {
      return;
    }

    const delay = FIRST_IDLE_HINT_DELAY_MS;
    idleHintTimeoutRef.current = window.setTimeout(() => {
      setIsIdleHintVisible(true);
      hasShownIdleHintRef.current = true;
      idleHintTimeoutRef.current = null;
    }, delay);
  }

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const nextSession = await startSmartPracticeSession(loadPracticeSettings());
        if (!cancelled) {
          setSession(nextSession);
          setIsAnswerVisible(false);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the current card's multiple-choice distractors as soon as it arrives,
  // so the tiles are ready by the time the learner has read the prompt. Results
  // are cached per session (see distractorCacheRef), so a re-queued card reuses
  // them instantly. Only fires when the card is provisionally MC-eligible; a
  // failed/empty fetch is cached too, and resolveModality then falls back to
  // classic. See docs/minigames.md §8.3.
  useEffect(() => {
    const card = session?.current_card;
    if (!card) {
      return;
    }
    // Only recognition games need distractors; fetch the side the selected game wants
    // ('en' for multiple choice, 'cloze' for word-bank cloze, 'es' for reverse MC).
    // Non-recognition modalities need no fetch.
    const side = recognitionSide(selectModality(card, practiceSettings));
    if (!side) {
      return;
    }

    const key = distractorKey(card.card_id, side);
    const cache = distractorCacheRef.current;
    if (cache.has(key)) {
      return;
    }

    cache.set(key, { status: 'loading', distractors: [] });
    setDistractorVersion((version) => version + 1);

    getMinigameDistractors(card.card_id, 3, side)
      .then((list) => {
        cache.set(key, { status: 'ready', distractors: Array.isArray(list) ? list : [] });
      })
      .catch(() => {
        cache.set(key, { status: 'error', distractors: [] });
      })
      .finally(() => setDistractorVersion((version) => version + 1));
  }, [session?.current_card?.card_id, practiceSettings]);

  // Accumulate each card the session surfaces into the rolling pool (newest-first,
  // capped) and persist it, so boundary games have material and a future session's
  // warm-up can re-activate these words. Purely local — never read by the scheduler.
  useEffect(() => {
    const card = session?.current_card;
    if (!card) {
      return;
    }
    seenCardsRef.current = mergeRecentCards(seenCardsRef.current, [card]);
    saveRecentCards(seenCardsRef.current);
  }, [session?.current_card?.card_id]);

  // Warm-up: considered once, as soon as the session is ready. Only fires at
  // frequencies that enable it (heavy) and only when prior words already exist —
  // a brand-new user's empty pool simply skips it (§6.1 open decision).
  useEffect(() => {
    if (status !== 'ready' || warmupConsideredRef.current) {
      return;
    }
    warmupConsideredRef.current = true;
    if (!session?.current_card) {
      return;
    }
    const plan = planInterstitial('warmup');
    if (plan) {
      setActiveInterstitial(plan);
    }
    // planInterstitial closes over the latest settings/pool; run once when ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Cool-down: considered once when the queue empties (complete screen). The
  // interstitial overlays the complete panel; dismissing it reveals the panel.
  useEffect(() => {
    if (status !== 'ready' || session?.current_card || cooldownConsideredRef.current) {
      return;
    }
    cooldownConsideredRef.current = true;
    const plan = planInterstitial('cooldown');
    if (plan) {
      setActiveInterstitial(plan);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session?.current_card]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (status !== 'ready' || !session?.current_card || isSubmitting || isDetailsVisible) {
        return;
      }

      // An interstitial owns the whole screen and its own keys (§8.4); classic
      // shortcuts must not fire underneath it. Non-classic modalities likewise
      // drive themselves (e.g. the typing input owns Enter).
      if (isInterstitialActive || !isClassicModality) {
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIsAnswerVisible((current) => !current);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIsAnswerVisible(true);
        return;
      }

      if (!isAnswerVisible) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        flashcardActionsRef.current?.triggerReview('left');
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        flashcardActionsRef.current?.triggerReview('right');
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAnswerVisible, isClassicModality, isDetailsVisible, isInterstitialActive, isSubmitting, session, status]);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [isAnswerVisible, session?.current_card?.card_id]);

  useEffect(() => {
    // The idle hint only teaches the classic tap-to-reveal / swipe gestures, so
    // skip it entirely for other modalities and while an interstitial is up (also
    // avoids re-rendering on every keystroke into the typing input).
    if (
      status !== 'ready' ||
      !session?.current_card ||
      isSubmitting ||
      isDetailsVisible ||
      !isClassicModality ||
      isInterstitialActive
    ) {
      setIsIdleHintVisible(false);
      clearIdleHintTimer();
      return undefined;
    }

    setIsIdleHintVisible(false);
    scheduleIdleHint();

    function handleInteraction() {
      setIsIdleHintVisible(false);
      scheduleIdleHint();
    }

    window.addEventListener('pointerdown', handleInteraction, true);
    window.addEventListener('keydown', handleInteraction, true);

    return () => {
      clearIdleHintTimer();
      window.removeEventListener('pointerdown', handleInteraction, true);
      window.removeEventListener('keydown', handleInteraction, true);
    };
  }, [isAnswerVisible, isClassicModality, isDetailsVisible, isInterstitialActive, isSubmitting, session?.current_card?.card_id, status]);

  // Unified resolution for every answer modality (docs/minigames.md §5, §8.2):
  //   * skip (a Tier-B recognition win, a Tier-C aid, or a Tier-A near miss — the
  //     neutral 'almost' verdict) -> advance WITHOUT grading via the skip RPC.
  //   * counted result -> the graded path (classic swipe, Tier-A typing).
  //   * anything else (non-counting practice outcome) -> resolve locally, no RPC.
  async function resolveCard({ result, counts = false, skip = false }) {
    if (!session?.current_card) {
      return;
    }

    // Captured before the queue moves so we can detect a block boundary afterward.
    const previousSummary = session.summary;

    // Minigame telemetry (docs/minigames.md §10, §9 Phase 6). Log the per-card play
    // — the game, its outcome, and whether it counted toward FSRS — for every
    // modality except the classic swipe (which is not a minigame). Fire-and-forget:
    // logMinigamePlay swallows its own errors, so this can never block or break the
    // advance, and it's purely additive (never read by the scheduler).
    if (currentModality && currentModality !== 'classic') {
      // A skip usually logs as 'skip', but a Tier-A near miss skips WITH a result
      // ('almost') so telemetry can tell the two neutral paths apart.
      const outcome = skip ? (result ?? 'skip') : result;
      if (outcome) {
        logMinigamePlay(session.current_card.card_id, currentModality, outcome, Boolean(counts && result));
      }
    }

    if (skip) {
      try {
        setIsSubmitting(true);
        // Returns a bare session snapshot (not { session, review_feedback }), so
        // set it directly. No FSRS change, so there is no scheduling feedback to show.
        const response = await skipSmartPracticeCard(session.summary.session_id, session.current_card.card_id);
        setSession(response);
        setIsAnswerVisible(false);
        maybeShowBoundaryInterstitial(previousSummary, response);
      } catch (skipError) {
        setError(skipError.message);
        setStatus('error');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!counts || !result) {
      return;
    }

    try {
      setIsSubmitting(true);
      const response = await submitSmartPracticeReview(session.summary.session_id, session.current_card.card_id, result);
      setSession(response.session);
      setIsAnswerVisible(false);
      const showedBoundary = maybeShowBoundaryInterstitial(previousSummary, response.session);

      // Skip the scheduling toast when a boundary interstitial just took over.
      if (!showedBoundary && response.review_feedback) {
        setReviewFeedback(response.review_feedback);
        if (feedbackTimeoutRef.current) {
          window.clearTimeout(feedbackTimeoutRef.current);
        }
        feedbackTimeoutRef.current = window.setTimeout(() => {
          setReviewFeedback(null);
          feedbackTimeoutRef.current = null;
        }, 2200);
      }
    } catch (submitError) {
      setError(submitError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUndo() {
    if (!session?.summary?.can_undo || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      const nextSession = await undoSmartPracticeReview(session.summary.session_id);
      setSession(nextSession);
      // Bring the card back with its answer showing so the correction is one swipe away.
      setIsAnswerVisible(true);
      if (feedbackTimeoutRef.current) {
        window.clearTimeout(feedbackTimeoutRef.current);
        feedbackTimeoutRef.current = null;
      }
      setReviewFeedback(null);
    } catch (undoError) {
      setError(undoError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  // Hide the current card from the deck and advance. Reached through the "Hide
  // card" button in the details modal (the "i" overlay every modality shows once
  // the answer is revealed). The RPC drops only this card from the running session
  // and returns the next-card snapshot, so — like a skip — there is no grade,
  // feedback toast, or undo to manage; we just swap in the new session.
  async function handleHideCard() {
    if (!session?.current_card || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      const response = await hideSmartPracticeCard(session.summary.session_id, session.current_card.card_id);
      setSession(response);
      setIsAnswerVisible(false);
      setIsDetailsVisible(false);
    } catch (hideError) {
      setError(hideError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveCard(values) {
    if (!session?.current_card) {
      return null;
    }

    setIsSavingCard(true);
    setError('');

    try {
      const updatedCard = await updateCard(session.current_card.card_id, values);
      setSession((current) => {
        if (!current?.current_card || current.current_card.card_id !== updatedCard.card_id) {
          return current;
        }

        return {
          ...current,
          current_card: {
            ...current.current_card,
            ...updatedCard,
          },
        };
      });
      return updatedCard;
    } catch (saveError) {
      setError(saveError.message);
      return null;
    } finally {
      setIsSavingCard(false);
    }
  }

  if (status === 'loading') {
    return <section className="panel empty-state">Preparing your smart practice session...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading smart practice.</p>
        <p>{error}</p>
        <Link className="back-link back-link--home back-link--button" to="/">
          <HomeIcon />
          <span>Home</span>
        </Link>
      </section>
    );
  }

  const summary = session.summary;
  // Only read the depth stat on the completion screen (no current card), where the
  // cool-down Synonym-match game surfaces — avoids a localStorage read every render.
  const depthStat = session.current_card ? null : loadDepthStat();

  return (
    <section className="review-screen">
      <div className="review-stage">
        <div className="practice-session-bar">
          <div className="practice-session-bar__nav">
            <Link className="back-link back-link--home" to="/">
              <HomeIcon />
              <span>Home</span>
            </Link>

            {summary.can_undo && !isInterstitialActive ? (
              <button
                type="button"
                className="back-link back-link--home review-undo-button"
                onClick={handleUndo}
                disabled={isSubmitting}
              >
                <UndoIcon />
                <span>Undo</span>
              </button>
            ) : null}
          </div>

          <div className="practice-session-summary" aria-label="Smart practice summary">
            <span className="practice-session-summary__mode">{modeLabel(summary.mode)}</span>
            <div className="practice-session-summary__stats">
              <span>{summary.completed_cards} done</span>
              {summary.mode === 'mixed' ? (
                <>
                  <span>{summary.remaining_new} new</span>
                  <span>{summary.remaining_review} review</span>
                </>
              ) : (
                <span>{summary.remaining_cards} left</span>
              )}
              {sessionShapeLabel(summary.session_shape) ? (
                <span>{sessionShapeLabel(summary.session_shape)}</span>
              ) : null}
              {!minigamesEnabled ? (
                <span className="practice-session-summary__simplified-badge" title="Simplified mode: turning flashcards only">
                  Simplified
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Always mounted so the pill has a reserved row (never covering the
            card) and the live region exists before the message lands. */}
        <div className="practice-feedback-slot" role="status" aria-live="polite">
          {reviewFeedback ? (
            <p className={`practice-feedback-toast practice-feedback-toast--${reviewFeedback.result}`}>
              {feedbackMessage(reviewFeedback)}
            </p>
          ) : null}
        </div>

        {activeInterstitial ? (
          <InterstitialHost
            placement={activeInterstitial.placement}
            game={activeInterstitial.game}
            cards={activeInterstitial.cards}
            onDone={handleInterstitialDone}
          />
        ) : session.current_card ? (
          <MinigameHost
            card={session.current_card}
            settings={practiceSettings}
            onResolve={resolveCard}
            distractorEntry={currentDistractorEntry}
            isAnswerVisible={isAnswerVisible}
            isSubmitting={isSubmitting}
            isIdleHintVisible={isIdleHintVisible}
            actionsRef={flashcardActionsRef}
            onReveal={() => setIsAnswerVisible(true)}
            onToggleReveal={() => setIsAnswerVisible((current) => !current)}
            onOpenDetails={() => setIsDetailsVisible(true)}
          />
        ) : (
          <section className="panel empty-state practice-complete">
            <p className="eyebrow">Session complete</p>
            <h2>You cleared this smart practice round.</h2>
            <p>
              Completed {summary.completed_cards} of {summary.total_cards} cards in {modeLabel(summary.mode).toLowerCase()} mode.
            </p>
            {depthStat && depthStat.matched > 0 ? (
              <p className="practice-complete__depth">
                Vocabulary depth: {depthStat.matched} related word{depthStat.matched === 1 ? '' : 's'} matched.
              </p>
            ) : null}
            <Link className="button button--primary" to="/">
              Back to home
            </Link>
          </section>
        )}

        {!isInterstitialActive && session.current_card && isDetailsVisible ? (
          <CardDetailsModal
            // A card only reaches practice while enabled, but the snapshot omits
            // the flag (unlike the deck preview) — default it so the modal's
            // "Hide card" toggle renders.
            card={{ ...session.current_card, is_enabled: session.current_card.is_enabled ?? true }}
            isPending={isSavingCard || isSubmitting}
            onClose={() => setIsDetailsVisible(false)}
            onSave={handleSaveCard}
            onToggle={handleHideCard}
          />
        ) : null}
      </div>
    </section>
  );
}

export default PracticePage;