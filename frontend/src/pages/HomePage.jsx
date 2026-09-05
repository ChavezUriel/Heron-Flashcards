import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
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

// Short label for the session Auto will build, shown read-only on the Auto
// card so the ruleset's choice stays visible. Label only: the meta line above
// it already says how many cards of each kind are coming.
function describeRecommendedSession(plan, t) {
  if (!plan) return null;
  switch (plan.shape) {
    case 'front_loaded':
      return t('home.auto_card_warmup_tag');
    case 'spread':
      return t('home.auto_card_spread_tag');
    case 'interleaved':
      return t('home.auto_card_interleaved_tag');
    default:
      break;
  }
  switch (plan.mode) {
    case 'review':
      return t('home.auto_card_review_tag');
    case 'new_material':
      return t('home.auto_card_new_tag');
    default:
      return t('home.auto_card_tag');
  }
}

// Honest, mode-aware "N new · M review · ~T min" line for the Smart session
// card. Counts mirror what the builder actually queues: up to new_block_size
// new cards and up to review_batch_size mastered cards, capped by what's
// available. Returns null until the due summary has loaded.
function recommendedSessionMeta(plan, dueSummary, settings, t) {
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
    return t('home.session_nothing_due');
  }

  const parts = [];
  if (newCount > 0) parts.push(t('home.session_new_count', { count: newCount }));
  if (reviewCount > 0) parts.push(t('home.session_review_count', { count: reviewCount }));
  parts.push(t('home.session_min_estimate', { minutes: Math.max(1, Math.ceil(totalCards / 2)) }));
  return parts.join(' · ');
}

function formatNextDue(nextDueAt, t) {
  if (!nextDueAt) {
    return null;
  }

  const dueDate = new Date(nextDueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return null;
  }

  const hoursAway = (dueDate.getTime() - Date.now()) / 3_600_000;
  if (hoursAway <= 0) {
    return t('home.next_due_now');
  }
  if (hoursAway < 1) {
    return t('home.next_due_under_hour');
  }
  if (hoursAway < 24) {
    return t('home.next_due_hours', { count: Math.round(hoursAway) });
  }
  return t('home.next_due_days', { count: Math.round(hoursAway / 24) });
}

function uniqueDeckIds(deckIds) {
  return [...new Set(deckIds)];
}

function sortDecksBySmartPractice(decks, localeCompare) {
  return [...decks].sort((leftDeck, rightDeck) => {
    if (leftDeck.is_enabled_in_smart_practice !== rightDeck.is_enabled_in_smart_practice) {
      return leftDeck.is_enabled_in_smart_practice ? -1 : 1;
    }
    if (leftDeck.completion_ratio !== rightDeck.completion_ratio) {
      return rightDeck.completion_ratio - leftDeck.completion_ratio;
    }
    return localeCompare ? localeCompare(leftDeck.title, rightDeck.title) : leftDeck.title.localeCompare(rightDeck.title);
  });
}

function buildDeckWordIndex(preview) {
  return (preview.cards || [])
    .flatMap((card) => [
      card.answer_l2, card.prompt_l1,
      card.answer_en, card.prompt_es,
      card.section_name,
      card.l2_definition, card.definition_en,
      ...(card.l1_translations || []),
      ...(card.main_translations_es || []),
      ...(card.collocations || []),
      ...(card.l2_synonyms || []),
      ...(card.synonyms_en || []),
      card.example_sentence,
      card.example_l1, card.example_l2,
      card.example_en, card.example_es,
    ])
    .filter(Boolean)
    .join(' ');
}

function buildSearchMatchReasons(titleScore, descriptionScore, wordsScore, t) {
  const reasons = [];
  if (titleScore > 0) reasons.push(t('home.match_title'));
  if (descriptionScore > 0) reasons.push(t('home.match_description'));
  if (wordsScore > 0) reasons.push(t('home.match_words'));
  if (reasons.length === 0) return [];
  if (reasons.length === 1) return [t('home.match_single', { field: reasons[0] })];
  if (reasons.length === 2) return [t('home.match_double', { field1: reasons[0], field2: reasons[1] })];
  return [t('home.match_multiple', { fields: reasons.slice(0, -1).join(', '), last: reasons[reasons.length - 1] })];
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

function rankDeckSearchResults(decks, query, deckWordIndexById, t) {
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
        searchMatchReasons: buildSearchMatchReasons(titleScore, descriptionScore, wordsScore, t),
      };
    })
    .sort((l, r) => {
      if (l.searchDidMatch !== r.searchDidMatch) return l.searchDidMatch ? -1 : 1;
      if (l.searchScore !== r.searchScore) return r.searchScore - l.searchScore;
      return l.index - r.index;
    });
}

function HomePage() {
  const { t } = useTranslation();
  const { localeCompare } = useLocale();
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

  // Stated positively — on = mini-games — so the switch reads the same way
  // round as its label. Simplified mode is what "off" means, not a second
  // setting to reason about.
  const areMinigamesEnabled = settings?.minigames?.enabled ?? true;

  function handleToggleMinigames(event) {
    event.stopPropagation();
    updateSettings({
      minigames: {
        ...(settings?.minigames || DEFAULT_PRACTICE_SETTINGS.minigames),
        enabled: !areMinigamesEnabled,
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
        if (!cancelled) { setDecks(sortDecksBySmartPractice(nextDecks, localeCompare)); setStatus('ready'); }
      } catch (loadError) {
        if (!cancelled) { setError(loadError.message); setStatus('error'); }
      }
    }
    loadDecks();
    return () => { cancelled = true; };
  }, [deckRefreshToken, localeCompare]);

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
    () => rankDeckSearchResults(decks, normalizedSearchQuery, deckWordIndexById, t),
    [deckWordIndexById, decks, normalizedSearchQuery, t]
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
            : t('home.action_error_partial')
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
    return <p className="h-empty-state">{t('home.loading_decks')}</p>;
  }

  if (status === 'error') {
    return <p className="h-empty-state h-empty-state--error">{t('home.load_error', { error })}</p>;
  }

  if (decks.length === 0) {
    return (
      <div className="h-empty-panel panel">
        <h2>{t('home.no_decks_title')}</h2>
        <p>{t('home.no_decks_desc')}</p>
        <div className="action-row">
          <Link className="button button--primary" to="/market">{t('home.open_market_action')}</Link>
          <Link className="button button--secondary" to="/decks/new">{t('home.build_with_ai_action')}</Link>
        </div>
      </div>
    );
  }

  const dueNow = dueSummary?.due_now ?? 0;
  const nextDueLabel = dueNow === 0 && dueSummary?.next_due_at ? formatNextDue(dueSummary.next_due_at, t) : null;
  const recommendedPlan = planRecommendedSession(dueSummary);
  const recommendedSession = describeRecommendedSession(recommendedPlan, t);
  const recommendedMeta = recommendedSessionMeta(recommendedPlan, dueSummary, settings, t);

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
              <span className="h-action-kicker">{t('home.recommended_kicker')}</span>
              <span className="h-action-arrow">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">{t('home.smart_session_title')}</div>
              <div className="h-mode-card__meta">
                {recommendedMeta ?? t('home.smart_session_fallback_meta')}
              </div>
            </div>
          </Link>
          <div className="h-mode-card__setting h-mode-card__setting--inline">
            {recommendedSession ? <span className="h-plan__tag">{recommendedSession}</span> : null}
            <label
              className="h-games-toggle"
              title={areMinigamesEnabled ? t('home.minigames_on_tooltip') : t('home.minigames_off_tooltip')}
            >
              <span className="h-games-toggle__label">{t('home.minigames_toggle_label')}</span>
              <span className="h-toggle-switch">
                <input
                  type="checkbox"
                  checked={areMinigamesEnabled}
                  onChange={handleToggleMinigames}
                  aria-label={t('home.minigames_toggle_aria')}
                />
                <span className="h-toggle-switch__track" aria-hidden="true">
                  <span className="h-toggle-switch__thumb" />
                </span>
              </span>
            </label>
          </div>
        </article>

        <article className="h-mode-card">
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'new_material' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker h-action-kicker--muted">{t('home.session_kicker')}</span>
              <span className="h-action-arrow h-action-arrow--muted">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">{t('home.new_material_title')}</div>
              <div className="h-mode-card__meta">{t('home.auto_card_new_blurb')}</div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">{t('home.cards_per_session')}</span>
            <ModeStepper
              value={settings.new_block_size}
              range={NEW_BLOCK_SIZE_RANGE}
              onStep={(delta) => stepSetting('new_block_size', delta, NEW_BLOCK_SIZE_RANGE)}
              decrementLabel={t('home.fewer_new_cards_aria')}
              incrementLabel={t('home.more_new_cards_aria')}
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
              <span className="h-action-kicker h-action-kicker--muted">{t('home.session_kicker')}</span>
              <span className="h-action-arrow h-action-arrow--muted">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">{t('home.review_title')}</div>
              <div className="h-mode-card__meta">
                {dueNow > 0
                  ? t('home.cards_due_now', { count: dueNow })
                  : nextDueLabel
                    ? t('home.nothing_due_next', { next: nextDueLabel })
                    : t('home.settle_cards_blurb')}
              </div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">{t('home.cards_per_session')}</span>
            <ModeStepper
              value={settings.review_batch_size}
              range={REVIEW_BATCH_SIZE_RANGE}
              onStep={(delta) => stepSetting('review_batch_size', delta, REVIEW_BATCH_SIZE_RANGE)}
              decrementLabel={t('home.fewer_review_cards_aria')}
              incrementLabel={t('home.more_review_cards_aria')}
            />
          </div>
        </article>
      </div>

      {/* ── Home decks ────────────────────────────────────────────── */}
      <section className="h-decks">
        <div className="h-decks__header">
          <div className="h-decks__header-left">
            <h2 className="h-decks__title">{t('home.home_decks_title')}</h2>
            <div className="h-decks__meta">
              <span>{t('home.decks_in_rotation', { enabled: enabledDeckCount, total: decks.length })}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="h-decks__text-action"
                onClick={handleToggleAllDecks}
                disabled={hasPendingDeckUpdates || decks.length === 0}
              >
                {areAllDecksEnabledInSmartPractice ? t('home.pause_all') : t('home.enable_all')}
              </button>
              <span aria-hidden="true">·</span>
              <Link to="/market" className="h-decks__text-action">{t('home.open_market_action')}</Link>
              <span aria-hidden="true">·</span>
              <Link to="/decks/new" className="h-decks__text-action">{t('home.create_with_ai_action')}</Link>
            </div>
          </div>

          <label className="h-deck-search" aria-label={t('home.search_home_decks_aria')}>
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }}>
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('home.search_home_decks_placeholder')}
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
