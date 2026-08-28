import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDeckPreview, fetchDueSummary, fetchHomeDecks, updateDeckSmartPracticeInclusion } from '../api';
import DeckCard from '../components/DeckCard';
import DeckSyncModal from '../components/DeckSyncModal';
import { maybeNotifyDueCards } from '../notifications';
import { DEFAULT_PRACTICE_SETTINGS, loadPracticeSettings, savePracticeSettings } from '../practiceSettings';
import { normalizeSearchText, scoreFieldMatch } from '../textSearch';

const NEW_BLOCK_SIZE_RANGE = { min: 5, max: 12, step: 1 };
const REVIEW_BATCH_SIZE_RANGE = { min: 10, max: 50, step: 5 };

// Mastered cards below this count = a "novice base": Auto front-loads new
// material as a block before reviews instead of interleaving, because early
// interleaving overloads learners without an established base (cognitive-load /
// "undesirable difficulty" research). Keep in sync with the backend ruleset in
// supabase/migrations/0021_smart_session_shape.sql.
const LEARNED_BASE_THRESHOLD = 30;

// Mirror of the backend Auto ruleset (start_smart_practice_session): decide,
// from the learner's card status, what session Auto will build and how it will
// be shaped. Returns null while the due summary is still loading.
function planRecommendedSession(dueSummary) {
  if (!dueSummary) {
    return null;
  }
  const newAvailable = dueSummary.new_available ?? 0;
  const dueNow = dueSummary.due_now ?? 0;
  const learnedTotal = dueSummary.learned_total ?? 0;

  let mode;
  if (newAvailable > 0 && dueNow > 0) mode = 'mixed';
  else if (dueNow > 0) mode = 'review';
  else if (newAvailable > 0) mode = 'new_material';
  else if (learnedTotal > 0) mode = 'review';
  else mode = 'empty';

  let shape = null;
  if (mode === 'mixed') {
    if (learnedTotal < LEARNED_BASE_THRESHOLD) shape = 'front_loaded';
    else if (dueNow > newAvailable * 2) shape = 'spread';
    else shape = 'interleaved';
  }
  return { mode, shape };
}

// Human-readable label + one-line rationale for the recommended session, shown
// read-only on the Auto card so the ruleset's choice is visible.
function describeRecommendedSession(plan) {
  if (!plan) return null;
  switch (plan.shape) {
    case 'front_loaded':
      return { tag: 'Warm-up', blurb: 'New cards in a block first, then reviews — gentler while your base is still small.' };
    case 'spread':
      return { tag: 'Spread', blurb: 'New cards woven evenly through a heavier review load.' };
    case 'interleaved':
      return { tag: 'Interleaved', blurb: 'New cards and reviews fully mixed to sharpen recall.' };
    default:
      break;
  }
  switch (plan.mode) {
    case 'review':
      return { tag: 'Review', blurb: 'Clearing the cards due back today.' };
    case 'new_material':
      return { tag: 'New', blurb: "Fresh cards you haven't met yet." };
    default:
      return { tag: 'Auto', blurb: 'Add or study cards to build a session.' };
  }
}

// Honest, mode-aware "N new · M review · ~T min" line for the Smart session
// card. Counts mirror what the builder actually queues: up to new_block_size
// new cards and up to review_batch_size mastered cards, capped by what's
// available. Returns null until the due summary has loaded.
function recommendedSessionMeta(plan, dueSummary, settings) {
  if (!plan || !dueSummary) {
    return null;
  }
  const newAvailable = dueSummary.new_available ?? 0;
  const learnedTotal = dueSummary.learned_total ?? 0;
  const modeHasNew = plan.mode === 'mixed' || plan.mode === 'new_material';
  const modeHasReview = plan.mode === 'mixed' || plan.mode === 'review';
  const newCount = modeHasNew ? Math.min(newAvailable, settings.new_block_size) : 0;
  const reviewCount = modeHasReview ? Math.min(learnedTotal, settings.review_batch_size) : 0;
  const totalCards = newCount + reviewCount;
  if (totalCards === 0) {
    return 'Nothing to practice right now';
  }

  const parts = [];
  if (newCount > 0) parts.push(`${newCount} new`);
  if (reviewCount > 0) parts.push(`${reviewCount} review`);
  parts.push(`~${Math.max(1, Math.ceil(totalCards / 2))} min`);
  return parts.join(' · ');
}

function formatNextDue(nextDueAt) {
  if (!nextDueAt) {
    return null;
  }

  const dueDate = new Date(nextDueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return null;
  }

  const hoursAway = (dueDate.getTime() - Date.now()) / 3_600_000;
  if (hoursAway <= 0) {
    return 'now';
  }
  if (hoursAway < 1) {
    return 'in less than an hour';
  }
  if (hoursAway < 24) {
    return `in ${Math.round(hoursAway)} h`;
  }
  return `in ${Math.round(hoursAway / 24)} d`;
}

function uniqueDeckIds(deckIds) {
  return [...new Set(deckIds)];
}

function sortDecksBySmartPractice(decks) {
  return [...decks].sort((leftDeck, rightDeck) => {
    if (leftDeck.is_enabled_in_smart_practice !== rightDeck.is_enabled_in_smart_practice) {
      return leftDeck.is_enabled_in_smart_practice ? -1 : 1;
    }
    if (leftDeck.completion_ratio !== rightDeck.completion_ratio) {
      return rightDeck.completion_ratio - leftDeck.completion_ratio;
    }
    return leftDeck.title.localeCompare(rightDeck.title);
  });
}

function buildDeckWordIndex(preview) {
  return preview.cards
    .flatMap((card) => [
      card.answer_en, card.prompt_es, card.section_name, card.definition_en,
      ...(card.main_translations_es || []), ...(card.collocations || []),
      ...(card.synonyms_en || []),
      card.example_sentence, card.example_en, card.example_es,
    ])
    .filter(Boolean)
    .join(' ');
}

function buildSearchMatchReasons(titleScore, descriptionScore, wordsScore) {
  const reasons = [];
  if (titleScore > 0) reasons.push('Title');
  if (descriptionScore > 0) reasons.push('Description');
  if (wordsScore > 0) reasons.push('Deck words');
  if (reasons.length === 0) return [];
  if (reasons.length === 1) return [`${reasons[0]} match`];
  if (reasons.length === 2) return [`${reasons[0]} & ${reasons[1]} match`];
  return [`${reasons.slice(0, -1).join(', ')} & ${reasons[reasons.length - 1]} match`];
}

function ModeStepper({ value, range, onStep, decrementLabel, incrementLabel }) {
  return (
    <div className="h-stepper">
      <button
        type="button"
        className="h-stepper__btn"
        onClick={() => onStep(-range.step)}
        disabled={value <= range.min}
        aria-label={decrementLabel}
      >
        −
      </button>
      <output className="h-stepper__value">{value}</output>
      <button
        type="button"
        className="h-stepper__btn"
        onClick={() => onStep(range.step)}
        disabled={value >= range.max}
        aria-label={incrementLabel}
      >
        +
      </button>
    </div>
  );
}

function rankDeckSearchResults(decks, query, deckWordIndexById) {
  if (!query) {
    return decks.map((deck) => ({ deck, searchScore: 0, searchDidMatch: false, searchMatchReasons: [] }));
  }
  return decks
    .map((deck, index) => {
      const titleScore = scoreFieldMatch(deck.title, query);
      const descriptionScore = scoreFieldMatch(deck.description, query);
      const wordsScore = scoreFieldMatch(deckWordIndexById[deck.id], query);
      const score = (titleScore * 1_000_000) + (descriptionScore * 1_000) + wordsScore;
      return {
        deck, index, score,
        searchScore: score,
        searchDidMatch: score > 0,
        searchMatchReasons: buildSearchMatchReasons(titleScore, descriptionScore, wordsScore),
      };
    })
    .sort((l, r) => {
      if (l.searchDidMatch !== r.searchDidMatch) return l.searchDidMatch ? -1 : 1;
      if (l.searchScore !== r.searchScore) return r.searchScore - l.searchScore;
      return l.index - r.index;
    });
}

function HomePage() {
  const [decks, setDecks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(() => loadPracticeSettings());
  const [pendingDeckIds, setPendingDeckIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [deckWordIndexById, setDeckWordIndexById] = useState({});
  const [dueSummary, setDueSummary] = useState(null);
  const [syncDeckId, setSyncDeckId] = useState(null);
  const [deckRefreshToken, setDeckRefreshToken] = useState(0);

  const areAllDecksEnabledInSmartPractice = decks.length > 0 && decks.every((d) => d.is_enabled_in_smart_practice);
  const enabledDeckCount = decks.filter((d) => d.is_enabled_in_smart_practice).length;
  const hasPendingDeckUpdates = pendingDeckIds.length > 0;

  function updateSettings(partialSettings) {
    setSettings((current) => {
      const nextSettings = { ...current, ...partialSettings };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  const isSimplifiedMode = !(settings?.minigames?.enabled ?? true);

  function handleToggleSimplifiedMode(event) {
    event.stopPropagation();
    const nextSimplified = !isSimplifiedMode;
    updateSettings({
      minigames: {
        ...(settings?.minigames || DEFAULT_PRACTICE_SETTINGS.minigames),
        enabled: !nextSimplified,
      },
    });
  }

  function stepSetting(key, delta, range) {
    setSettings((current) => {
      const nextValue = Math.min(range.max, Math.max(range.min, current[key] + delta));
      if (nextValue === current[key]) {
        return current;
      }
      const nextSettings = { ...current, [key]: nextValue };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function loadDecks() {
      try {
        const nextDecks = await fetchHomeDecks();
        if (!cancelled) { setDecks(sortDecksBySmartPractice(nextDecks)); setStatus('ready'); }
      } catch (loadError) {
        if (!cancelled) { setError(loadError.message); setStatus('error'); }
      }
    }
    loadDecks();
    return () => { cancelled = true; };
  }, [deckRefreshToken]);

  useEffect(() => {
    let cancelled = false;
    async function loadDueSummary() {
      try {
        const summary = await fetchDueSummary();
        if (!cancelled) {
          setDueSummary(summary);
          maybeNotifyDueCards(summary);
        }
      } catch {
        // The due strip is progressive enhancement; the page works without it.
      }
    }
    loadDueSummary();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadDeckWordIndexes() {
      if (decks.length === 0) return;
      const results = await Promise.allSettled(
        decks.map(async (deck) => {
          const preview = await fetchDeckPreview(deck.id);
          return [deck.id, buildDeckWordIndex(preview)];
        })
      );
      if (cancelled) return;
      const nextIndex = {};
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [deckId, wordIndex] = result.value;
          nextIndex[deckId] = wordIndex;
        }
      }
      setDeckWordIndexById(nextIndex);
    }
    loadDeckWordIndexes();
    return () => { cancelled = true; };
  }, [decks]);

  const normalizedSearchQuery = normalizeSearchText(searchQuery);
  const visibleDeckEntries = useMemo(
    () => rankDeckSearchResults(decks, normalizedSearchQuery, deckWordIndexById),
    [deckWordIndexById, decks, normalizedSearchQuery]
  );

  async function updateSmartPracticeInclusion(deckIds, isEnabled) {
    if (deckIds.length === 0) return;
    setActionError('');
    setPendingDeckIds((current) => uniqueDeckIds([...current, ...deckIds]));
    try {
      const results = await Promise.allSettled(
        deckIds.map((id) => updateDeckSmartPracticeInclusion(id, isEnabled))
      );
      const successIds = deckIds.filter((_, i) => results[i].status === 'fulfilled');
      const failedResults = results.filter((r) => r.status === 'rejected');
      if (successIds.length > 0) {
        setDecks((current) => current.map((deck) =>
          successIds.includes(deck.id) ? { ...deck, is_enabled_in_smart_practice: isEnabled } : deck
        ));
      }
      if (failedResults.length > 0) {
        const firstError = failedResults[0].reason;
        setActionError(
          failedResults.length === deckIds.length
            ? firstError.message
            : 'Some decks could not be updated. Please try again.'
        );
      }
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setPendingDeckIds((current) => current.filter((id) => !deckIds.includes(id)));
    }
  }

  async function handleToggleSmartPractice(deckId, isEnabled) {
    await updateSmartPracticeInclusion([deckId], isEnabled);
  }

  async function handleToggleAllDecks() {
    const nextState = !areAllDecksEnabledInSmartPractice;
    const targetIds = decks
      .filter((d) => d.is_enabled_in_smart_practice !== nextState)
      .map((d) => d.id);
    await updateSmartPracticeInclusion(targetIds, nextState);
  }

  if (status === 'loading') {
    return <p className="h-empty-state">Loading your home decks…</p>;
  }

  if (status === 'error') {
    return <p className="h-empty-state h-empty-state--error">Unable to load decks: {error}</p>;
  }

  if (decks.length === 0) {
    return (
      <div className="h-empty-panel panel">
        <h2>No decks on home</h2>
        <p>Add a deck from the market, or have AI build one around exactly what you need to learn.</p>
        <div className="action-row">
          <Link className="button button--primary" to="/market">Open market</Link>
          <Link className="button button--secondary" to="/decks/new">Build one with AI</Link>
        </div>
      </div>
    );
  }

  const dueNow = dueSummary?.due_now ?? 0;
  const nextDueLabel = dueNow === 0 && dueSummary?.next_due_at ? formatNextDue(dueSummary.next_due_at) : null;
  const recommendedPlan = planRecommendedSession(dueSummary);
  const recommendedSession = describeRecommendedSession(recommendedPlan);
  const recommendedMeta = recommendedSessionMeta(recommendedPlan, dueSummary, settings);

  return (
    <>
      {/* ── Practice modes ────────────────────────────────────────── */}
      <div className="h-mode-grid">
        <article className="h-mode-card h-mode-card--primary">
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'auto' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker">RECOMMENDED</span>
              <span className="h-action-arrow">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">Smart session</div>
              <div className="h-mode-card__meta">
                {recommendedMeta ?? 'Your recommended mix'}
              </div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <div className="h-mode-card__toggle-row">
              <div className="h-mode-card__toggle-info">
                <span className="h-mode-card__setting-label">Simplified mode</span>
                <span className="h-mode-card__toggle-hint">
                  {isSimplifiedMode ? 'Turning flashcards only' : 'Flashcards & mini-games'}
                </span>
              </div>
              <label
                className="h-toggle-switch"
                title={isSimplifiedMode ? 'Simplified mode active: turning flashcards only' : 'Simplified mode inactive: mini-games enabled'}
              >
                <input
                  type="checkbox"
                  checked={isSimplifiedMode}
                  onChange={handleToggleSimplifiedMode}
                  aria-label="Simplified mode (turning flashcards only)"
                />
                <span className="h-toggle-switch__track" aria-hidden="true">
                  <span className="h-toggle-switch__thumb" />
                </span>
              </label>
            </div>
            {recommendedSession ? (
              <div className="h-plan">
                <span className="h-plan__tag">{recommendedSession.tag}</span>
                <span className="h-plan__blurb">{recommendedSession.blurb}</span>
              </div>
            ) : null}
          </div>
        </article>

        <article className="h-mode-card">
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'new_material' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker h-action-kicker--muted">SESSION</span>
              <span className="h-action-arrow h-action-arrow--muted">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">New material</div>
              <div className="h-mode-card__meta">Fresh cards you haven't met yet.</div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">Cards per session</span>
            <ModeStepper
              value={settings.new_block_size}
              range={NEW_BLOCK_SIZE_RANGE}
              onStep={(delta) => stepSetting('new_block_size', delta, NEW_BLOCK_SIZE_RANGE)}
              decrementLabel="Fewer new cards per session"
              incrementLabel="More new cards per session"
            />
          </div>
        </article>

        <article className={`h-mode-card${dueNow > 0 ? ' h-mode-card--due' : ''}`}>
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'review' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker h-action-kicker--muted">SESSION</span>
              <span className="h-action-arrow h-action-arrow--muted">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">Review</div>
              <div className="h-mode-card__meta">
                {dueNow > 0
                  ? `${dueNow} card${dueNow === 1 ? '' : 's'} due now`
                  : nextDueLabel
                    ? `Nothing due · next ${nextDueLabel}`
                    : 'Settle the cards due back today.'}
              </div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">Cards per session</span>
            <ModeStepper
              value={settings.review_batch_size}
              range={REVIEW_BATCH_SIZE_RANGE}
              onStep={(delta) => stepSetting('review_batch_size', delta, REVIEW_BATCH_SIZE_RANGE)}
              decrementLabel="Fewer review cards per session"
              incrementLabel="More review cards per session"
            />
          </div>
        </article>
      </div>

      {/* ── Home decks ────────────────────────────────────────────── */}
      <section className="h-decks">
        <div className="h-decks__header">
          <div className="h-decks__header-left">
            <h2 className="h-decks__title">Home decks</h2>
            <div className="h-decks__meta">
              <span>{enabledDeckCount} of {decks.length} in rotation</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="h-decks__text-action"
                onClick={handleToggleAllDecks}
                disabled={hasPendingDeckUpdates || decks.length === 0}
              >
                {areAllDecksEnabledInSmartPractice ? 'Pause all' : 'Enable all'}
              </button>
              <span aria-hidden="true">·</span>
              <Link to="/market" className="h-decks__text-action">Open market</Link>
              <span aria-hidden="true">·</span>
              <Link to="/decks/new" className="h-decks__text-action">Create with AI</Link>
            </div>
          </div>

          <label className="h-deck-search" aria-label="Search home decks">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }}>
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search home decks"
            />
          </label>
        </div>

        {actionError ? <p className="deck-grid__status deck-grid__status--error">{actionError}</p> : null}

        <div className="h-deck-grid">
          {visibleDeckEntries.map(({ deck, searchDidMatch, searchMatchReasons }) => (
            <DeckCard
              key={deck.id}
              deck={deck}
              isPending={pendingDeckIds.includes(deck.id)}
              variant="home"
              onToggleSmartPractice={handleToggleSmartPractice}
              onOpenSync={(deckId) => setSyncDeckId(deckId)}
              isSearchDimmed={Boolean(normalizedSearchQuery) && !searchDidMatch}
              searchMatchReasons={searchMatchReasons}
            />
          ))}
        </div>
      </section>

      {syncDeckId !== null ? (
        <DeckSyncModal
          deckId={syncDeckId}
          onClose={() => setSyncDeckId(null)}
          onApplied={() => setDeckRefreshToken((token) => token + 1)}
        />
      ) : null}
    </>
  );
}

export default HomePage;
