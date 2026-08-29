import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  claimMarketDeck,
  deleteCard,
  deleteCards,
  deletePersonalDeck,
  fetchDeckPreview,
  updateCard,
  updateCardsVisibility,
  updateCardVisibility,
  updateDeckHomeSelection,
} from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import DeckDeleteModal from '../components/DeckDeleteModal';
import { DeckOriginIcon, getDeckOriginType } from '../components/DeckOriginBadge';
import DeckPublishModal from '../components/DeckPublishModal';
import DeckSyncModal from '../components/DeckSyncModal';
import ProposeChangesModal from '../components/ProposeChangesModal';
import { buildHighlightSegments, normalizeSearchText, scoreFieldMatch } from '../textSearch';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'visible', label: 'Visible' },
  { value: 'hidden', label: 'Hidden' },
];

const SORT_ACCESSORS = {
  word: (card) => card.prompt_es ?? '',
  translation: (card) => card.answer_en ?? '',
  section: (card) => card.section_name ?? '',
};

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="deck-menu__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The bulk actions still obey the table's search and filter even though they now
// live in the deck menu, far from the controls that scope them. The label is the
// only thing carrying that scope, so it spells out the reach: "Hide all 120
// cards" on a clean table, "Hide 12 matching cards" once a query narrows it.
function bulkActionLabel(verb, count, isFiltered) {
  const noun = `card${count === 1 ? '' : 's'}`;
  return isFiltered ? `${verb} ${count} matching ${noun}` : `${verb} all ${count} ${noun}`;
}

// Dismiss-on-outside-click menu holding the deck-level toolbar actions. Not a
// modal: it never traps focus. Items are links or buttons, each optionally
// carrying a count chip; `hasPending` dots the trigger so a deck needing
// attention still says so while collapsed.
function OverflowMenu({ label, items, triggerText = null, hasPending = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    }

    // Escape returns focus to the trigger; an outside click leaves focus wherever
    // the pointer put it.
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // A deck with nothing to act on (a plain personal deck) gets no trigger at all
  // rather than a menu that opens onto emptiness.
  if (!items.length) {
    return null;
  }

  return (
    <div className="deck-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        className={`deck-menu__trigger${triggerText ? ' deck-menu__trigger--text' : ''}${isOpen ? ' deck-menu__trigger--open' : ''}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerText ? undefined : label}
        title={triggerText ? undefined : label}
        onClick={() => setIsOpen((open) => !open)}
      >
        {triggerText ? <span>{triggerText}</span> : <EllipsisIcon />}
        {triggerText ? <ChevronIcon /> : null}
        {hasPending ? <span className="deck-menu__dot" /> : null}
        {hasPending ? <span className="sr-only">(needs attention)</span> : null}
      </button>
      {isOpen ? (
        <div className="deck-menu__list" role="menu">
          {items.map((item) => {
            const body = (
              <>
                <span className="deck-menu__item-label">{item.label}</span>
                {item.count > 0 ? <span className="deck-menu__count">{item.count}</span> : null}
              </>
            );

            return item.to ? (
              <Link
                key={item.key}
                className={`deck-menu__item${item.isDanger ? ' deck-menu__item--danger' : ''}`}
                role="menuitem"
                to={item.to}
                state={item.state}
                onClick={() => setIsOpen(false)}
              >
                {body}
              </Link>
            ) : (
              <button
                key={item.key}
                className={`deck-menu__item${item.isDanger ? ' deck-menu__item--danger' : ''}`}
                type="button"
                role="menuitem"
                disabled={item.isDisabled}
                onClick={() => { setIsOpen(false); item.onSelect(); }}
              >
                {body}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Score one card against a normalized query. The headline word pair
// (Spanish prompt / English answer) outranks everything, alternate word forms
// (translations, synonyms) come second, and the long-form metadata fields
// only ever break ties. `matchedIn` names the field that carried the match
// when the headline pair itself did not hit.
function scoreCardMatch(card, query) {
  const wordScore = Math.max(
    scoreFieldMatch(card.prompt_es, query),
    scoreFieldMatch(card.answer_en, query),
  );

  const translationsScore = (card.main_translations_es ?? [])
    .reduce((best, value) => Math.max(best, scoreFieldMatch(value, query)), 0);
  const synonymsScore = (card.synonyms_en ?? [])
    .reduce((best, value) => Math.max(best, scoreFieldMatch(value, query)), 0);
  const altWordScore = Math.max(translationsScore, synonymsScore);

  const secondaryFields = [
    ['section', card.section_name],
    ['part of speech', card.part_of_speech],
    ['definition', card.definition_en],
    ['collocations', (card.collocations ?? []).join(' ')],
    ['examples', [card.example_sentence, card.example_es, card.example_en].filter(Boolean).join(' ')],
  ];
  let secondaryScore = 0;
  let secondaryLabel = null;
  for (const [label, value] of secondaryFields) {
    const fieldScore = scoreFieldMatch(value, query);
    if (fieldScore > secondaryScore) {
      secondaryScore = fieldScore;
      secondaryLabel = label;
    }
  }

  const score = (wordScore * 1_000_000) + (altWordScore * 1_000) + secondaryScore;

  let matchedIn = null;
  if (score > 0 && wordScore === 0) {
    matchedIn = altWordScore > 0
      ? (translationsScore >= synonymsScore ? 'translations' : 'synonyms')
      : secondaryLabel;
  }

  return { score, matchedIn };
}

function HighlightText({ text, query }) {
  if (!text) {
    return null;
  }
  if (!query) {
    return text;
  }
  return buildHighlightSegments(text, query).map((segment, index) => (
    segment.isMatch
      ? <mark key={index} className="deck-table__mark">{segment.text}</mark>
      : <span key={index}>{segment.text}</span>
  ));
}

function SortableHeader({ label, sortKey, sort, onSort, className = '' }) {
  const isActive = sort.key === sortKey;
  return (
    <th
      className={className}
      aria-sort={isActive ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      <button
        className={`deck-table__sort ${isActive ? 'deck-table__sort--active' : ''}`}
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        <span>{label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {!isActive ? (
            <>
              <path d="m8 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="m8 14 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : sort.dir === 1 ? (
            <path d="m7 14 5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </button>
    </th>
  );
}

function DeckWordsPage() {
  const { deckId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [pendingCardIds, setPendingCardIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [detailsCardId, setDetailsCardId] = useState(null);
  const [activeSyncModal, setActiveSyncModal] = useState(null); // 'sync' | 'propose' | 'publish' | null
  const [previewRefreshToken, setPreviewRefreshToken] = useState(0);
  const [isClaimPending, setIsClaimPending] = useState(false);
  const [isBulkPending, setIsBulkPending] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [isDeleteDeckModalOpen, setIsDeleteDeckModalOpen] = useState(false);
  const [isDeleteDeckPending, setIsDeleteDeckPending] = useState(false);
  const [isHomeSelectionPending, setIsHomeSelectionPending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const tableScrollRef = useRef(null);

  async function handleConfirmDeletePersonalDeck() {
    if (!preview) return;
    setIsDeleteDeckPending(true);
    setActionError('');
    try {
      await deletePersonalDeck(preview.deck_id);
      setIsDeleteDeckModalOpen(false);
      navigate('/', { replace: true });
    } catch (err) {
      setActionError(err.message || 'Failed to delete deck');
      setIsDeleteDeckPending(false);
    }
  }

  async function handleToggleHomeSelection(isSelectedOnHome) {
    if (!preview) return;
    setActionError('');
    setIsHomeSelectionPending(true);
    try {
      await updateDeckHomeSelection(preview.deck_id, isSelectedOnHome);
      setPreview((current) => {
        if (!current) return current;
        return {
          ...current,
          is_selected_on_home: isSelectedOnHome,
        };
      });
    } catch (err) {
      setActionError(err.message || (isSelectedOnHome ? 'Failed to add deck to home' : 'Failed to remove deck from home'));
    } finally {
      setIsHomeSelectionPending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadDeckPreview() {
      try {
        if (previewRefreshToken === 0) {
          setStatus('loading');
        }
        setError('');
        setActionError('');
        const nextPreview = await fetchDeckPreview(deckId);
        if (!cancelled) {
          setPreview(nextPreview);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadDeckPreview();

    return () => {
      cancelled = true;
    };
  }, [deckId, previewRefreshToken]);

  // Navigating to a different deck starts from a clean slate again.
  useEffect(() => {
    setPreviewRefreshToken(0);
    setActiveSyncModal(null);
    setSearchQuery('');
    setStatusFilter('all');
    setSort({ key: null, dir: 1 });
    setBulkDeleteConfirm(false);
  }, [deckId]);

  const normalizedQuery = normalizeSearchText(searchQuery);

  const tableRows = useMemo(() => {
    if (!preview) {
      return [];
    }

    let rows = preview.cards.map((card, index) => ({ card, index, score: 0, matchedIn: null }));

    if (normalizedQuery) {
      rows = rows
        .map((row) => ({ ...row, ...scoreCardMatch(row.card, normalizedQuery) }))
        .filter((row) => row.score > 0);
    }

    if (statusFilter !== 'all') {
      rows = rows.filter((row) => (statusFilter === 'visible' ? row.card.is_enabled : !row.card.is_enabled));
    }

    if (sort.key) {
      const accessor = SORT_ACCESSORS[sort.key];
      rows = [...rows].sort((left, right) => {
        const leftValue = accessor(left.card);
        const rightValue = accessor(right.card);
        // Cards without a value sink to the bottom in either direction.
        if (!leftValue && !rightValue) return left.index - right.index;
        if (!leftValue) return 1;
        if (!rightValue) return -1;
        const compared = leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' }) * sort.dir;
        return compared || left.index - right.index;
      });
    } else if (normalizedQuery) {
      rows = [...rows].sort((left, right) => (right.score - left.score) || (left.index - right.index));
    }

    return rows;
  }, [preview, normalizedQuery, statusFilter, sort]);

  // A new query, filter, or sort order should be read from the top.
  useEffect(() => {
    tableScrollRef.current?.scrollTo?.({ top: 0 });
  }, [normalizedQuery, statusFilter, sort]);

  if (status === 'loading') {
    return <section className="panel empty-state">Loading deck words...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading the deck words.</p>
        <p>{error}</p>
        <Link className="back-link back-link--home back-link--button" to="/">
          <HomeIcon />
          <span>Back to home</span>
        </Link>
      </section>
    );
  }

  const from = location?.state?.from;
  const backPath = from === 'market' ? '/market' : '/';
  const backLabel = from === 'market' ? 'Back to market' : 'Back home';

  // Market-sync capabilities. These fields only exist once migration 0017 is
  // live; every fallback preserves the pre-sync behavior.
  const isMarket = Boolean(preview.is_market);
  const canEdit = preview.can_edit ?? true;
  const isLinked = !isMarket && preview.base_deck_id != null && Boolean(preview.base_deck_available);
  const updatesAvailable = preview.updates_available ?? 0;
  const outgoingChanges = preview.outgoing_changes ?? 0;
  const isClaimable = isMarket && preview.owner_id === null;

  const totalCards = preview.cards.length;
  const hiddenCount = preview.cards.filter((card) => !card.is_enabled).length;
  const isFiltered = Boolean(normalizedQuery) || statusFilter !== 'all';

  // How many of the rows currently on screen each bulk action would actually
  // change — drives whether the menu item is worth offering.
  const hideableCount = tableRows.filter((row) => row.card.is_enabled).length;
  const showableCount = tableRows.length - hideableCount;

  const detailsCard = detailsCardId
    ? preview.cards.find((card) => card.card_id === detailsCardId) ?? null
    : null;

  // Deck-level actions, collapsed into one menu. Which ones exist depends on the
  // deck's relationship to the market, so the list is assembled rather than a
  // fixed set of conditionally-rendered buttons.
  const openProposals = preview.open_proposals ?? 0;
  const deckActions = [];

  if (isLinked) {
    deckActions.push({
      key: 'market-version',
      label: 'View market version',
      to: `/decks/${preview.base_deck_id}/words`,
      state: { from: 'market' },
    });
  }
  if (isMarket && preview.user_copy_deck_id) {
    deckActions.push({
      key: 'my-copy',
      label: 'View my copy',
      to: `/decks/${preview.user_copy_deck_id}/words`,
    });
  }
  if (isLinked) {
    deckActions.push({
      key: 'sync',
      label: 'Market updates',
      count: updatesAvailable,
      onSelect: () => setActiveSyncModal('sync'),
    });
  }
  if (isLinked && outgoingChanges > 0) {
    deckActions.push({
      key: 'propose',
      label: 'Propose to market',
      count: outgoingChanges,
      onSelect: () => setActiveSyncModal('propose'),
    });
  }
  if (isMarket && preview.is_owner) {
    deckActions.push({
      key: 'proposals',
      label: 'Proposals',
      count: openProposals,
      to: '/market/proposals',
    });
  }
  if (canEdit) {
    deckActions.push({
      key: 'complete-ai',
      label: 'Complete with AI',
      to: `/decks/complete?deck=${preview.deck_id}`,
    });
  }
  if (canEdit && !isMarket && !isLinked && totalCards > 0) {
    deckActions.push({
      key: 'publish',
      label: preview.publish_status === 'published' ? 'Republish to market' : 'Publish to market',
      onSelect: () => setActiveSyncModal('publish'),
    });
  }
  if (isClaimable) {
    deckActions.push({
      key: 'claim',
      label: isClaimPending ? 'Claiming…' : 'Become maintainer',
      isDisabled: isClaimPending,
      onSelect: handleClaimDeck,
    });
  }
  const isSelectedOnHome = preview.is_selected_on_home !== undefined
    ? Boolean(preview.is_selected_on_home)
    : !isMarket;

  if (isSelectedOnHome) {
    deckActions.push({
      key: 'remove-from-home',
      label: isHomeSelectionPending ? 'Removing from home…' : 'Remove from home',
      isDisabled: isHomeSelectionPending,
      onSelect: () => handleToggleHomeSelection(false),
    });
  } else {
    deckActions.push({
      key: 'add-to-home',
      label: isHomeSelectionPending ? 'Adding to home…' : 'Add to home',
      isDisabled: isHomeSelectionPending,
      onSelect: () => handleToggleHomeSelection(true),
    });
  }
  // Kept last: the market items above are about the deck as a whole, these two
  // reach only as far as the rows the table is currently showing. An empty deck
  // has nothing to hide, and a read-only one nothing to change.
  if (canEdit && totalCards > 0) {
    deckActions.push({
      key: 'bulk-hide',
      label: bulkActionLabel('Hide', tableRows.length, isFiltered),
      isDisabled: isBulkPending || hideableCount === 0,
      onSelect: () => handleBulkVisibility(false),
    });
    deckActions.push({
      key: 'bulk-show',
      label: bulkActionLabel('Show', tableRows.length, isFiltered),
      isDisabled: isBulkPending || showableCount === 0,
      onSelect: () => handleBulkVisibility(true),
    });
    deckActions.push({
      key: 'bulk-delete',
      label: bulkActionLabel('Delete', tableRows.length, isFiltered),
      isDisabled: isBulkPending || tableRows.length === 0,
      onSelect: () => setBulkDeleteConfirm(true),
    });
  }
  if (canEdit && !isMarket) {
    deckActions.push({
      key: 'delete-deck',
      label: 'Delete deck',
      isDanger: true,
      onSelect: () => setIsDeleteDeckModalOpen(true),
    });
  }

  // Collapsing the toolbar would otherwise hide the counts that made you open the
  // deck; a dot on the trigger keeps "something needs you in here" visible.
  const hasPendingDeckWork = updatesAvailable > 0 || outgoingChanges > 0 || openProposals > 0;

  function handleSort(key) {
    setSort((current) => {
      if (current.key !== key) return { key, dir: 1 };
      if (current.dir === 1) return { key, dir: -1 };
      return { key: null, dir: 1 };
    });
  }

  async function handleDeleteCard(cardId) {
    setActionError('');
    setPendingCardIds((current) => [...current, cardId]);

    const targetCard = preview?.cards?.find((card) => card.card_id === cardId);
    const wasLinked = targetCard && targetCard.base_card_id != null;

    try {
      await deleteCard(cardId);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        const outgoingDelta = wasLinked ? 1 : 0;

        return {
          ...current,
          cards: current.cards.filter((card) => card.card_id !== cardId),
          outgoing_changes: (current.outgoing_changes ?? 0) + outgoingDelta,
        };
      });
      setDetailsCardId(null);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setPendingCardIds((current) => current.filter((pendingCardId) => pendingCardId !== cardId));
    }
  }

  async function handleBulkDelete(cardIds) {
    if (!cardIds || !cardIds.length) {
      return;
    }

    setActionError('');
    setIsBulkPending(true);

    const deletedSet = new Set(cardIds);
    const newlyOutgoingCount = preview?.cards
      ? preview.cards.filter((card) => deletedSet.has(card.card_id) && card.base_card_id != null).length
      : 0;

    try {
      await deleteCards(cardIds);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          cards: current.cards.filter((card) => !deletedSet.has(card.card_id)),
          outgoing_changes: (current.outgoing_changes ?? 0) + newlyOutgoingCount,
        };
      });
      setBulkDeleteConfirm(false);
      if (detailsCardId && deletedSet.has(detailsCardId)) {
        setDetailsCardId(null);
      }
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setIsBulkPending(false);
    }
  }

  async function handleToggleCard(cardId, isEnabled) {
    setActionError('');
    setPendingCardIds((current) => [...current, cardId]);

    try {
      await updateCardVisibility(cardId, isEnabled);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          cards: current.cards.map((card) => (
            card.card_id === cardId
              ? { ...card, is_enabled: isEnabled }
              : card
          )),
        };
      });
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setPendingCardIds((current) => current.filter((pendingCardId) => pendingCardId !== cardId));
    }
  }

  // Bulk hide/show, scoped to the rows the current search and filter leave on
  // screen. Cards already in the target state are left out of the request so the
  // server's updated_count stays an honest delta.
  async function handleBulkVisibility(isEnabled) {
    const cardIds = tableRows
      .filter((row) => row.card.is_enabled !== isEnabled)
      .map((row) => row.card.card_id);

    if (!cardIds.length) {
      return;
    }

    setActionError('');
    setIsBulkPending(true);

    try {
      await updateCardsVisibility(cardIds, isEnabled);
      const changedIds = new Set(cardIds);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          cards: current.cards.map((card) => (
            changedIds.has(card.card_id)
              ? { ...card, is_enabled: isEnabled }
              : card
          )),
        };
      });
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setIsBulkPending(false);
    }
  }

  async function handleClaimDeck() {
    setActionError('');
    setIsClaimPending(true);

    try {
      await claimMarketDeck(preview.deck_id);
      setPreviewRefreshToken((token) => token + 1);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setIsClaimPending(false);
    }
  }

  async function handleSaveCard(cardId, values) {
    setActionError('');
    setPendingCardIds((current) => [...current, cardId]);

    try {
      const updatedCard = await updateCard(cardId, values);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          cards: current.cards.map((card) => (
            card.card_id === cardId
              ? updatedCard
              : card
          )),
        };
      });
      return updatedCard;
    } catch (requestError) {
      setActionError(requestError.message);
      return null;
    } finally {
      setPendingCardIds((current) => current.filter((pendingCardId) => pendingCardId !== cardId));
    }
  }

  const previewOriginType = preview ? getDeckOriginType(preview) : 'personal';

  return (
    <section className="panel deck-preview-page">
      <div className="deck-preview-page__toolbar">
        <Link className="back-link back-link--home back-link--button" to={backPath}>
          {from === 'market' ? <BackIcon /> : <HomeIcon />}
          <span>{backLabel}</span>
        </Link>
        <div className="deck-preview-page__toolbar-actions">
          <OverflowMenu label="Deck actions" triggerText="Deck actions" hasPending={hasPendingDeckWork} items={deckActions} />
        </div>
      </div>

      <div className="deck-preview__header">
        <p className="eyebrow">Deck explorer</p>
        <div className="deck-preview__title-row">
          <h2>{preview.deck_title}</h2>
          <span className={`deck-scope-chip deck-scope-chip--${previewOriginType}`}>
            <DeckOriginIcon type={previewOriginType} size={12} />
            <span>
              {previewOriginType === 'personal'
                ? 'Personal deck'
                : previewOriginType === 'managing'
                  ? 'Managing · Maintainer'
                  : 'Public · Market deck'}
            </span>
          </span>
          {!canEdit ? <span className="deck-scope-chip deck-scope-chip--readonly">Read-only</span> : null}
        </div>
        <p className="deck-preview__description">{preview.deck_description}</p>
        {isMarket && preview.owner_id !== undefined ? (
          <p className="deck-preview__maintainer">
            {preview.is_owner
              ? 'You maintain this public market deck — edits here publish to every subscriber.'
              : preview.owner_id
                ? (<>Public deck maintained by <strong>{preview.owner_name}</strong>{canEdit ? '' : ' — browse it here, or add it to your home from the market to edit your own copy.'}</>)
                : 'Community deck · no maintainer yet'}
          </p>
        ) : null}
        {!isMarket ? (
          <p className="deck-preview__maintainer">
            {isLinked
              ? 'Your private copy of a market deck — edits stay in your account until you propose them to the market.'
              : 'Your private deck — edits here only affect you.'}
          </p>
        ) : null}
      </div>

      {actionError ? <p className="deck-preview__status deck-preview__status--error">{actionError}</p> : null}

      {totalCards ? (
        <>
          <div className="deck-table-controls">
            <label className="h-deck-search deck-table-controls__search" aria-label="Search cards in this deck">
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search words, translations, examples…"
              />
              {searchQuery ? (
                <button
                  className="deck-table-controls__clear"
                  type="button"
                  aria-label="Clear search"
                  title="Clear search"
                  onClick={() => setSearchQuery('')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </label>

            <div className="h-seg deck-table-controls__filter" role="group" aria-label="Filter cards by visibility">
              {STATUS_FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`h-seg__btn${statusFilter === value ? ' h-seg__btn--active' : ''}`}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            <p className="deck-table-controls__count" role="status">
              {isFiltered ? `${tableRows.length} of ${totalCards} cards` : `${totalCards} card${totalCards === 1 ? '' : 's'}`}
              {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
            </p>
          </div>

          <div className="deck-table-shell">
            {tableRows.length ? (
              <div className="deck-table-scroll" ref={tableScrollRef}>
                <table className="deck-table">
                  <thead>
                    <tr>
                      <SortableHeader label="Spanish" sortKey="word" sort={sort} onSort={handleSort} className="deck-table__col--word" />
                      <SortableHeader label="English" sortKey="translation" sort={sort} onSort={handleSort} className="deck-table__col--translation" />
                      <SortableHeader label="Section" sortKey="section" sort={sort} onSort={handleSort} className="deck-table__col--section" />
                      <th className="deck-table__col--pos">Part of speech</th>
                      {canEdit ? <th className="deck-table__col--actions">Visible</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(({ card, matchedIn }) => (
                      <DeckWordRow
                        key={card.card_id}
                        card={card}
                        canEdit={canEdit}
                        isPending={pendingCardIds.includes(card.card_id)}
                        matchedIn={matchedIn}
                        highlightQuery={normalizedQuery}
                        onOpenDetails={() => setDetailsCardId(card.card_id)}
                        onToggle={() => handleToggleCard(card.card_id, !card.is_enabled)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="deck-table-empty">
                <p>
                  {normalizedQuery
                    ? <>No cards match <strong>“{searchQuery.trim()}”</strong>{statusFilter !== 'all' ? ` among ${statusFilter} cards` : ''}.</>
                    : `This deck has no ${statusFilter} cards.`}
                </p>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
                >
                  Clear search & filters
                </button>
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="deck-preview__status">This deck has no cards yet.</p>
      )}

      {detailsCard ? (
        <CardDetailsModal
          card={detailsCard}
          deck={preview ? { title: preview.deck_title, description: preview.deck_description } : undefined}
          isPending={pendingCardIds.includes(detailsCard.card_id)}
          onClose={() => setDetailsCardId(null)}
          onSave={canEdit ? (values) => handleSaveCard(detailsCard.card_id, values) : undefined}
          onToggle={canEdit ? () => handleToggleCard(detailsCard.card_id, !detailsCard.is_enabled) : undefined}
          onDelete={canEdit ? () => handleDeleteCard(detailsCard.card_id) : undefined}
        />
      ) : null}

      {bulkDeleteConfirm ? (
        <div className="details-modal" role="dialog" aria-modal="true" aria-label="Confirm bulk delete">
          <button
            aria-label="Close dialog"
            className="details-modal__backdrop"
            type="button"
            onClick={() => setBulkDeleteConfirm(false)}
          />
          <div className="details-modal__panel details-modal__panel--confirm">
            <button
              aria-label="Close dialog"
              className="details-modal__close"
              type="button"
              onClick={() => setBulkDeleteConfirm(false)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>

            <div className="details-modal__header">
              <p className="flashcard__label">Delete cards</p>
              <h3>Delete {tableRows.length} {tableRows.length === 1 ? 'card' : 'cards'}?</h3>
            </div>

            <div className="bulk-delete-dialog__body">
              <p>
                {isFiltered
                  ? `Are you sure you want to delete all ${tableRows.length} matching cards currently shown?`
                  : `Are you sure you want to delete all ${tableRows.length} cards from this deck?`}
              </p>
              {isLinked ? (
                <p className="bulk-delete-dialog__note">
                  Linked cards will be marked as removed in your copy, and you can propose these deletions to the market deck.
                </p>
              ) : null}
            </div>

            <div className="details-modal__actions">
              <span />
              <div className="details-modal__actions-group">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setBulkDeleteConfirm(false)}
                  disabled={isBulkPending}
                >
                  Cancel
                </button>
                <button
                  className="button button--danger"
                  type="button"
                  onClick={() => handleBulkDelete(tableRows.map((row) => row.card.card_id))}
                  disabled={isBulkPending}
                >
                  {isBulkPending ? 'Deleting…' : 'Confirm delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {activeSyncModal === 'sync' ? (
        <DeckSyncModal
          deckId={preview.deck_id}
          onClose={() => setActiveSyncModal(null)}
          onApplied={() => setPreviewRefreshToken((token) => token + 1)}
        />
      ) : null}

      {activeSyncModal === 'propose' ? (
        <ProposeChangesModal
          deckId={preview.deck_id}
          onClose={() => setActiveSyncModal(null)}
          onSubmitted={() => setPreviewRefreshToken((token) => token + 1)}
        />
      ) : null}

      {activeSyncModal === 'publish' ? (
        <DeckPublishModal
          deckId={preview.deck_id}
          deckPreview={preview}
          onClose={() => setActiveSyncModal(null)}
          onPublished={() => {
            setPreviewRefreshToken((token) => token + 1);
          }}
          onEditCard={(cardId) => {
            setDetailsCardId(cardId);
          }}
        />
      ) : null}

      {isDeleteDeckModalOpen && preview ? (
        <DeckDeleteModal
          deck={{ ...preview, title: preview.deck_title }}
          isPending={isDeleteDeckPending}
          onClose={() => setIsDeleteDeckModalOpen(false)}
          onConfirm={handleConfirmDeletePersonalDeck}
        />
      ) : null}
    </section>
  );
}

function DeckWordRow({ card, canEdit = true, isPending, matchedIn, highlightQuery, onToggle, onOpenDetails }) {
  const toggleTitle = card.is_enabled ? 'Hide card from deck' : 'Show card in deck again';

  return (
    <tr
      className={`deck-table__row ${card.is_enabled ? '' : 'deck-table__row--disabled'}`}
      onClick={onOpenDetails}
    >
      <td className="deck-table__cell deck-table__cell--word">
        <strong><HighlightText text={card.prompt_es} query={highlightQuery} /></strong>
        {!card.is_enabled ? <span className="deck-table__state-chip">Hidden</span> : null}
        {matchedIn ? <span className="deck-table__match-chip">Matched in {matchedIn}</span> : null}
      </td>
      <td className="deck-table__cell deck-table__cell--translation">
        <HighlightText text={card.answer_en} query={highlightQuery} />
      </td>
      <td className="deck-table__cell deck-table__cell--section">
        {card.section_name
          ? <HighlightText text={card.section_name} query={highlightQuery} />
          : <span className="deck-table__placeholder">—</span>}
      </td>
      <td className="deck-table__cell deck-table__cell--pos">
        {card.part_of_speech || <span className="deck-table__placeholder">—</span>}
      </td>
      {canEdit ? (
        <td className="deck-table__cell deck-table__cell--actions">
          <div className="deck-table__actions">
            <button
              className="deck-table__switch"
              type="button"
              role="switch"
              aria-checked={card.is_enabled}
              aria-label={`Card ${card.prompt_es} visible in deck`}
              title={toggleTitle}
              onClick={(event) => { event.stopPropagation(); onToggle(); }}
              disabled={isPending}
            >
              <span className="deck-table__switch-track" aria-hidden="true">
                <span className="deck-table__switch-thumb" />
              </span>
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}

export default DeckWordsPage;
