import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { claimMarketDeck, fetchMarketDecks, updateDeckHomeSelection } from '../api';
import DeckCard from '../components/DeckCard';
import { useLocale } from '../context/LocaleContext';
import { normalizeSearchText } from '../textSearch';

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function sortDecks(decks, localeCompare) {
  return [...decks].sort((leftDeck, rightDeck) => {
    const leftHome = leftDeck.is_selected_on_home ? 1 : 0;
    const rightHome = rightDeck.is_selected_on_home ? 1 : 0;
    if (leftHome !== rightHome) {
      return rightHome - leftHome;
    }

    if (leftDeck.completion_ratio !== rightDeck.completion_ratio) {
      return rightDeck.completion_ratio - leftDeck.completion_ratio;
    }

    return localeCompare
      ? localeCompare(leftDeck.title, rightDeck.title)
      : String(leftDeck.title).localeCompare(String(rightDeck.title));
  });
}

function MarketPage() {
  const { t } = useTranslation();
  const { localeCompare } = useLocale();
  const [decks, setDecks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [pendingDeckIds, setPendingDeckIds] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadDecks() {
      try {
        const nextDecks = await fetchMarketDecks();
        if (!cancelled) {
          setDecks(sortDecks(nextDecks, localeCompare));
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadDecks();

    return () => {
      cancelled = true;
    };
  }, [localeCompare]);

  const normalizedSearchQuery = normalizeSearchText(searchQuery);
  const visibleDecks = useMemo(() => {
    if (!normalizedSearchQuery) {
      return decks;
    }

    return decks.filter((deck) => {
      const titleMatch = normalizeSearchText(deck.title).includes(normalizedSearchQuery);
      const descriptionMatch = normalizeSearchText(deck.description).includes(normalizedSearchQuery);
      return titleMatch || descriptionMatch;
    });
  }, [decks, normalizedSearchQuery]);

  async function handleToggleHome(deckId, isSelectedOnHome) {
    setPendingDeckIds((current) => [...current, deckId]);

    try {
      await updateDeckHomeSelection(deckId, isSelectedOnHome);
      // Update selection state but do NOT re-sort while the market page is open.
      // The ordering should be generated when the market screen is opened.
      setDecks((current) => current.map((deck) => (deck.id === deckId ? { ...deck, is_selected_on_home: isSelectedOnHome } : deck)));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPendingDeckIds((current) => current.filter((pendingDeckId) => pendingDeckId !== deckId));
    }
  }

  async function handleClaimDeck(deckId) {
    setPendingDeckIds((current) => [...current, deckId]);

    try {
      const result = await claimMarketDeck(deckId);
      setDecks((current) => current.map((deck) => (
        deck.id === deckId
          ? { ...deck, owner_id: result.owner_id, owner_name: result.owner_name, is_owner: true, open_proposals: 0 }
          : deck
      )));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPendingDeckIds((current) => current.filter((pendingDeckId) => pendingDeckId !== deckId));
    }
  }

  const openProposalsToReview = decks.reduce((sum, deck) => sum + (deck.is_owner ? (deck.open_proposals ?? 0) : 0), 0);
  const hasProposalActivity = decks.some((deck) => deck.is_owner || (deck.my_open_proposals ?? 0) > 0);

  if (status === 'loading') {
    return <p className="h-empty-state">{t('market.loading_market')}</p>;
  }

  if (status === 'error') {
    return <p className="h-empty-state h-empty-state--error">{t('market.load_error', { error })}</p>;
  }

  return (
    <section className="h-market">
      <div className="h-market__head">
        <div className="h-market__head-left">
          <Link to="/" className="back-link back-link--home back-link--button h-market__back">
            <HomeIcon />
            <span>{t('nav.home')}</span>
          </Link>
          <p className="h-market__kicker">{t('market.kicker')}</p>
          <h1 className="h-market__title">{t('market.heading')}</h1>
          <p className="h-market__copy">{t('market.copy')}</p>
          <Link to="/market/proposals" className="h-decks__text-action h-market__proposals-link">
            {openProposalsToReview > 0
              ? t('market.proposals_to_review', { count: openProposalsToReview })
              : hasProposalActivity
                ? t('market.change_proposals_link')
                : t('market.your_proposals_link')}
          </Link>
        </div>

        <label className="h-deck-search h-market__search" aria-label={t('market.search_aria')}>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }}>
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('market.search_placeholder')}
          />
        </label>
      </div>

      {visibleDecks.length === 0 ? (
        <div className="h-empty-panel panel">
          <p>{decks.length === 0 ? t('market.all_decks_on_home') : t('market.no_matches')}</p>
          <Link to="/" className="button button--primary">{t('market.back_home_btn')}</Link>
        </div>
      ) : (
        <div className="h-market-grid">
          {visibleDecks.map((deck) => (
            <DeckCard
              key={deck.id}
              deck={deck}
              variant="market"
              isPending={pendingDeckIds.includes(deck.id)}
              onToggleHome={handleToggleHome}
              onClaim={handleClaimDeck}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default MarketPage;
