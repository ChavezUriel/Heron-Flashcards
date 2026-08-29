import { useNavigate } from 'react-router-dom';
import { DECK_ORIGIN_CONFIG, DeckOriginIcon, getDeckOriginType } from './DeckOriginBadge';

function percentage(value) {
  return Math.round(value * 100);
}

function renderTitleWithOriginIcon(title, originType, tooltip) {
  if (!title) return null;
  const words = title.trim().split(/\s+/);
  if (words.length <= 1) {
    return (
      <span className="h-deck-card__title-end">
        {title}
        <span
          className={`h-deck-card__origin-icon h-deck-card__origin-icon--${originType}`}
          title={tooltip}
          aria-label={tooltip}
        >
          <DeckOriginIcon type={originType} size={13} />
        </span>
      </span>
    );
  }

  const leading = words.slice(0, -1).join(' ');
  const lastWord = words[words.length - 1];

  return (
    <>
      <span>{leading} </span>
      <span className="h-deck-card__title-end">
        {lastWord}
        <span
          className={`h-deck-card__origin-icon h-deck-card__origin-icon--${originType}`}
          title={tooltip}
          aria-label={tooltip}
        >
          <DeckOriginIcon type={originType} size={13} />
        </span>
      </span>
    </>
  );
}

function DeckCard({
  deck,
  variant = 'home',
  isPending = false,
  onToggleSmartPractice,
  onToggleHome,
  onOpenSync,
  onClaim,
  searchMatchReasons = [],
  isSearchDimmed = false,
}) {
  const navigate = useNavigate();
  const isPracticeEnabled = Boolean(deck.is_enabled_in_smart_practice);
  const isOnHome = Boolean(deck.is_selected_on_home);
  const originType = getDeckOriginType(deck);
  const originConfig = DECK_ORIGIN_CONFIG[originType] || DECK_ORIGIN_CONFIG.personal;

  function handleOpenDeck() {
    navigate(`/decks/${deck.id}/words`, { state: { from: variant } });
  }

  function handleTogglePractice(event) {
    if (event) {
      event.stopPropagation();
    }
    if (variant !== 'home') return;
    onToggleSmartPractice?.(deck.id, !isPracticeEnabled);
  }

  function handleCardKeyDown(event) {
    if (variant !== 'home') return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpenDeck();
    }
  }

  /* ── Home variant (Heron design) ────────────────────────────── */
  if (variant === 'home') {
    const pct = percentage(deck.completion_ratio);

    return (
      <article
        className={[
          'h-deck-card',
          !isPracticeEnabled ? 'h-deck-card--inactive' : '',
          isSearchDimmed ? 'deck-card--search-dimmed' : '',
          isPending ? 'h-deck-card--pending' : '',
        ].filter(Boolean).join(' ')}
        role="button"
        tabIndex={0}
        aria-label={`Open ${deck.title} deck explorer`}
        aria-busy={isPending}
        onClick={handleOpenDeck}
        onKeyDown={handleCardKeyDown}
      >
        <div className="h-deck-card__top">
          <div className="h-deck-card__title">
            {renderTitleWithOriginIcon(deck.title, originType, originConfig.tooltip)}
          </div>
          <div className="h-deck-card__top-actions">
            <button
              className={`deck-card__check-button ${isPracticeEnabled ? 'deck-card__check-button--checked' : ''}`}
              type="button"
              role="checkbox"
              aria-checked={isPracticeEnabled}
              aria-label={isPracticeEnabled ? `Exclude ${deck.title} from practice session` : `Include ${deck.title} in practice session`}
              title={isPracticeEnabled ? 'Active in practice — click to pause' : 'Paused — click to include in practice'}
              disabled={isPending}
              onClick={handleTogglePractice}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  handleTogglePractice(e);
                }
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M20 6.5L9 17.5l-5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {searchMatchReasons.length > 0 && (
          <div className="deck-card__match-reasons" aria-label={`Search matches for ${deck.title}`}>
            {searchMatchReasons.map((reason) => (
              <span key={reason} className="deck-card__match-badge">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <span>{reason}</span>
              </span>
            ))}
          </div>
        )}

        {(deck.updates_available ?? 0) > 0 && onOpenSync ? (
          <button
            className="h-deck-card__updates"
            type="button"
            aria-label={`Review ${deck.updates_available} market update${deck.updates_available === 1 ? '' : 's'} for ${deck.title}`}
            title="This deck's market source changed — review and pull the updates"
            onClick={(e) => { e.stopPropagation(); onOpenSync(deck.id); }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 4v12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="m7 11 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 20h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {deck.updates_available} market update{deck.updates_available === 1 ? '' : 's'}
          </button>
        ) : null}

        <div className="h-deck-card__bottom">
          <div className="h-deck-card__stats">
            <span>{deck.total_cards} cards</span>
            <span className="h-deck-card__pct">{pct}%</span>
          </div>
          <div className="h-progress-track" aria-hidden="true">
            <div className="h-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </article>
    );
  }

  /* ── Market variant (Heron design) ──────────────────────────── */
  const marketPct = percentage(deck.completion_ratio);

  return (
    <article
      className={`h-market-card ${isSearchDimmed ? 'h-market-card--search-dimmed' : ''}`}
    >
      <button
        className="h-market-card__explore"
        type="button"
        aria-label={`Open ${deck.title} deck explorer`}
        title="Open deck explorer"
        onClick={(e) => { e.stopPropagation(); handleOpenDeck(); }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <svg fill="currentColor" viewBox="0 0 36 36" aria-hidden="true">
          <path d="M15,17H4a2,2,0,0,1-2-2V8A2,2,0,0,1,4,6H15a2,2,0,0,1,2,2v7A2,2,0,0,1,15,17ZM4,8v7H15V8Z" />
          <path d="M32,17H21a2,2,0,0,1-2-2V8a2,2,0,0,1,2-2H32a2,2,0,0,1,2,2v7A2,2,0,0,1,32,17ZM21,8v7H32V8Z" />
          <path d="M15,30H4a2,2,0,0,1-2-2V21a2,2,0,0,1,2-2H15a2,2,0,0,1,2,2v7A2,2,0,0,1,15,30ZM4,21v7H15V21Z" />
          <path d="M32,30H21a2,2,0,0,1-2-2V21a2,2,0,0,1,2-2H32a2,2,0,0,1,2,2v7A2,2,0,0,1,32,30ZM21,21v7H32V21Z" />
        </svg>
      </button>

      <div className="h-market-card__top">
        <div>
          <div className="h-market-card__title">
            {renderTitleWithOriginIcon(
              deck.title,
              deck.is_owner ? 'managing' : 'public',
              deck.is_owner ? 'Deck you manage (maintainer)' : 'Public community deck'
            )}
          </div>
          <div className="h-market-card__meta">{deck.total_cards} CARDS</div>
        </div>
      </div>

      {searchMatchReasons.length > 0 && (
        <div className="deck-card__match-reasons" aria-label={`Search matches for ${deck.title}`}>
          {searchMatchReasons.map((reason) => (
            <span key={reason} className="deck-card__match-badge">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>{reason}</span>
            </span>
          ))}
        </div>
      )}

      <p className="h-market-card__desc">{deck.description}</p>

      {deck.owner_id !== undefined ? (
        <div className="h-market-card__maintainer">
          {deck.is_owner ? (
            <>
              <span className="sync-chip sync-chip--owner">You maintain this deck</span>
              {deck.open_proposals > 0 ? (
                <button
                  type="button"
                  className="h-decks__text-action"
                  onClick={(e) => { e.stopPropagation(); navigate('/market/proposals'); }}
                >
                  {deck.open_proposals} proposal{deck.open_proposals === 1 ? '' : 's'} to review →
                </button>
              ) : null}
            </>
          ) : deck.owner_id ? (
            <span className="h-market-card__maintainer-name">
              Maintained by <strong>{deck.owner_name}</strong>
              {deck.my_open_proposals > 0 ? ` · ${deck.my_open_proposals} proposal${deck.my_open_proposals === 1 ? '' : 's'} pending` : ''}
            </span>
          ) : (
            <>
              <span className="h-market-card__maintainer-name">Unmaintained</span>
              {onClaim ? (
                <button
                  type="button"
                  className="h-decks__text-action"
                  disabled={isPending}
                  onClick={(e) => { e.stopPropagation(); onClaim(deck.id); }}
                >
                  Become maintainer
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="h-market-card__progress" aria-label={`Progress for ${deck.title}`}>
        <div className="h-market-card__progress-meta">
          <span>{deck.reviewed_cards} of {deck.total_cards} seen</span>
          <span className="h-market-card__progress-pct">{marketPct}%</span>
        </div>
        <div className="h-progress-track" aria-hidden="true">
          <div className="h-progress-fill" style={{ width: `${marketPct}%` }} />
        </div>
      </div>

      <button
        className={`h-market-card__add ${isOnHome ? 'h-market-card__add--on' : ''}`}
        type="button"
        disabled={isPending}
        aria-pressed={isOnHome}
        onClick={(e) => { e.stopPropagation(); onToggleHome?.(deck.id, !isOnHome); }}
      >
        {isOnHome ? (
          <>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            On home
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            Add to home
          </>
        )}
      </button>
    </article>
  );
}

export default DeckCard;
