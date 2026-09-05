import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  fetchMarketDecks,
  listDeckProposals,
  resolveDeckChangeProposal,
  transferMarketDeckOwnership,
  withdrawDeckChangeProposal,
} from '../api';
import { cardTitle, diffCardContent } from '../cardDiff';
import { useLocale } from '../context/LocaleContext';

function BackIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProposalItemDiff({ item }) {
  const { t } = useTranslation();
  if (item.change_type === 'add_card') {
    return (
      <li className="sync-row">
        <p className="sync-row__title">
          <span className="sync-chip sync-chip--add">{t('proposals.new_card_chip')}</span>
          {cardTitle(item.payload)}
        </p>
        {item.payload?.definition_en ? <p className="proposal-item__detail">{item.payload.definition_en}</p> : null}
      </li>
    );
  }

  if (item.change_type === 'remove_card') {
    return (
      <li className="sync-row">
        <p className="sync-row__title">
          <span className="sync-chip sync-chip--warn">{t('proposals.removal_chip')}</span>
          {cardTitle(item.base_snapshot)}
        </p>
        <p className="proposal-item__detail">{t('proposals.removal_desc')}</p>
      </li>
    );
  }

  const diff = diffCardContent(item.base_snapshot, item.payload);
  return (
    <li className="sync-row">
      <p className="sync-row__title">
        {cardTitle(item.base_snapshot ?? item.payload)}
        {item.is_stale ? (
          <span className="sync-chip sync-chip--warn" title={t('proposals.stale_chip_tooltip')}>
            {t('proposals.stale_chip')}
          </span>
        ) : null}
        {item.current_base === null ? (
          <span className="sync-chip sync-chip--warn">{t('proposals.deleted_chip')}</span>
        ) : null}
      </p>
      <ul className="sync-diff">
        {diff.map((row) => (
          <li key={row.key}>
            <span className="sync-diff__label">{row.label}</span>
            <span className="sync-diff__values">
              <del>{row.from || '—'}</del>
              <span aria-hidden="true" className="sync-diff__arrow">→</span>
              <ins>{row.to || '—'}</ins>
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function ProposalCard({ proposal, role, isPending, onResolve, onWithdraw }) {
  const { t } = useTranslation();
  const { formatDate } = useLocale();
  const [expanded, setExpanded] = useState(proposal.status === 'open');
  const [note, setNote] = useState('');
  const isOpen = proposal.status === 'open';

  const formattedCreatedDate = proposal.created_at
    ? formatDate(proposal.created_at, { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  const formattedResolvedDate = proposal.resolved_at
    ? formatDate(proposal.resolved_at, { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  const statusLabel = t(`proposals.status_${proposal.status}`, { defaultValue: proposal.status });

  return (
    <article className={`proposal-card ${isOpen ? 'proposal-card--open' : ''}`}>
      <button
        type="button"
        className="proposal-card__head"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <div className="proposal-card__head-main">
          <span className={`sync-chip sync-chip--${proposal.status}`}>{statusLabel}</span>
          <span className="proposal-card__deck">{proposal.market_deck_title}</span>
          <span className="proposal-card__meta">
            {t('proposals.changes_count', { count: proposal.items.length })}
            {' · '}
            {role === 'reviewer' ? t('proposals.from_author', { name: proposal.proposer_name }) : t('proposals.by_you')}
            {formattedCreatedDate ? ` · ${formattedCreatedDate}` : ''}
          </span>
        </div>
        <span className="proposal-card__chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded ? (
        <div className="proposal-card__body">
          {proposal.message ? <p className="proposal-card__message">“{proposal.message}”</p> : null}

          <ul className="sync-section__list">
            {proposal.items.map((item) => (
              <ProposalItemDiff key={item.item_id} item={item} />
            ))}
          </ul>

          {proposal.status !== 'open' && (proposal.resolution_note || proposal.resolved_at) ? (
            <p className="proposal-card__resolution">
              {statusLabel} {formattedResolvedDate}
              {proposal.resolved_by_name && proposal.status !== 'withdrawn' ? ` ${t('proposals.by_author', { name: proposal.resolved_by_name })}` : ''}
              {proposal.resolution_note ? ` — “${proposal.resolution_note}”` : ''}
            </p>
          ) : null}

          {isOpen && role === 'reviewer' ? (
            <div className="proposal-card__actions">
              <input
                type="text"
                className="proposal-card__note"
                placeholder={t('proposals.add_note_placeholder')}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={isPending}
              />
              <div className="proposal-card__buttons">
                <button
                  className="button button--primary"
                  type="button"
                  disabled={isPending}
                  onClick={() => onResolve(proposal.proposal_id, 'approve', note)}
                >
                  {t('proposals.approve_apply_btn')}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={isPending}
                  onClick={() => onResolve(proposal.proposal_id, 'reject', note)}
                >
                  {t('proposals.reject_proposal')}
                </button>
              </div>
            </div>
          ) : null}

          {isOpen && role === 'proposer' ? (
            <div className="proposal-card__actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={isPending}
                onClick={() => onWithdraw(proposal.proposal_id)}
              >
                {t('proposals.withdraw_proposal')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MaintainedDeckRow({ deck, onTransferred }) {
  const { t } = useTranslation();
  const [showTransfer, setShowTransfer] = useState(false);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function handleTransfer() {
    if (!email.trim()) return;
    setPending(true);
    setError('');
    try {
      const result = await transferMarketDeckOwnership(deck.id, email.trim());
      onTransferred(deck.id, result);
      setShowTransfer(false);
    } catch (transferError) {
      setError(transferError.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="maintained-deck">
      <div className="maintained-deck__main">
        <span className="maintained-deck__title">{deck.title}</span>
        <span className="maintained-deck__meta">
          {deck.open_proposals > 0
            ? t('proposals.open_proposals_count', { count: deck.open_proposals })
            : t('proposals.no_open_proposals')}
        </span>
      </div>
      {showTransfer ? (
        <div className="maintained-deck__transfer">
          <input
            type="email"
            placeholder={t('proposals.transfer_email_placeholder')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
          />
          <button className="button button--primary" type="button" disabled={pending || !email.trim()} onClick={handleTransfer}>
            {pending ? t('proposals.transferring') : t('proposals.transfer_btn')}
          </button>
          <button className="button button--secondary" type="button" disabled={pending} onClick={() => { setShowTransfer(false); setError(''); }}>
            {t('common.cancel')}
          </button>
          {error ? <p className="sync-modal__status sync-modal__status--error">{error}</p> : null}
        </div>
      ) : (
        <button className="h-decks__text-action" type="button" onClick={() => setShowTransfer(true)}>
          {t('proposals.transfer_ownership_btn')}
        </button>
      )}
    </li>
  );
}

function ProposalsPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [proposals, setProposals] = useState({ to_review: [], mine: [] });
  const [maintainedDecks, setMaintainedDecks] = useState([]);
  const [tab, setTab] = useState(null);
  const [pendingIds, setPendingIds] = useState([]);
  const [actionError, setActionError] = useState('');

  async function load() {
    try {
      setStatus('loading');
      setError('');
      const [nextProposals, marketDecks] = await Promise.all([
        listDeckProposals(),
        fetchMarketDecks().catch(() => []),
      ]);
      setProposals(nextProposals);
      setMaintainedDecks(marketDecks.filter((deck) => deck.is_owner));
      setStatus('ready');
    } catch (loadError) {
      setError(loadError.message);
      setStatus('error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const openToReview = useMemo(
    () => proposals.to_review.filter((proposal) => proposal.status === 'open').length,
    [proposals],
  );

  const activeTab = tab ?? (proposals.to_review.length > 0 ? 'to_review' : 'mine');

  async function handleResolve(proposalId, action, note) {
    setActionError('');
    setPendingIds((current) => [...current, proposalId]);
    try {
      await resolveDeckChangeProposal(proposalId, action, note || null);
      await load();
    } catch (resolveError) {
      setActionError(resolveError.message);
    } finally {
      setPendingIds((current) => current.filter((id) => id !== proposalId));
    }
  }

  async function handleWithdraw(proposalId) {
    setActionError('');
    setPendingIds((current) => [...current, proposalId]);
    try {
      await withdrawDeckChangeProposal(proposalId);
      await load();
    } catch (withdrawError) {
      setActionError(withdrawError.message);
    } finally {
      setPendingIds((current) => current.filter((id) => id !== proposalId));
    }
  }

  function handleTransferred(deckId) {
    setMaintainedDecks((current) => current.filter((deck) => deck.id !== deckId));
    load();
  }

  if (status === 'loading') {
    return <p className="h-empty-state">{t('proposals.loading_proposals')}</p>;
  }

  if (status === 'error') {
    return (
      <section className="h-market proposals-page">
        <Link to="/market" className="back-link back-link--home back-link--button">
          <BackIcon />
          <span>{t('proposals.back_to_market')}</span>
        </Link>
        <p className="h-empty-state h-empty-state--error">{t('proposals.load_error', { error })}</p>
      </section>
    );
  }

  const visibleProposals = activeTab === 'to_review' ? proposals.to_review : proposals.mine;

  return (
    <section className="h-market proposals-page">
      <div className="proposals-page__head">
        <Link to="/market" className="back-link back-link--home back-link--button">
          <BackIcon />
          <span>{t('proposals.back_to_market')}</span>
        </Link>
        <p className="h-market__kicker">{t('market.kicker')}</p>
        <h1 className="h-market__title">{t('proposals.title')}</h1>
        <p className="h-market__copy">{t('proposals.subtitle')}</p>
      </div>

      {maintainedDecks.length > 0 ? (
        <section className="proposals-page__maintained panel">
          <h2>{t('proposals.maintained_decks_title')}</h2>
          <ul>
            {maintainedDecks.map((deck) => (
              <MaintainedDeckRow key={deck.id} deck={deck} onTransferred={handleTransferred} />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="proposals-page__tabs" role="tablist" aria-label={t('proposals.tabs_aria')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'to_review'}
          className={`h-seg__btn ${activeTab === 'to_review' ? 'h-seg__btn--active' : ''}`}
          onClick={() => setTab('to_review')}
        >
          {t('proposals.to_review_tab')}{openToReview > 0 ? ` (${openToReview})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'mine'}
          className={`h-seg__btn ${activeTab === 'mine' ? 'h-seg__btn--active' : ''}`}
          onClick={() => setTab('mine')}
        >
          {t('proposals.outgoing_tab')}{proposals.mine.length > 0 ? ` (${proposals.mine.length})` : ''}
        </button>
      </div>

      {actionError ? <p className="sync-modal__status sync-modal__status--error">{actionError}</p> : null}

      {visibleProposals.length === 0 ? (
        <div className="h-empty-panel panel">
          <p>
            {activeTab === 'to_review'
              ? t('proposals.no_incoming')
              : t('proposals.no_outgoing')}
          </p>
          <Link to="/market" className="button button--primary">{t('proposals.back_to_market')}</Link>
        </div>
      ) : (
        <div className="proposals-page__list">
          {visibleProposals.map((proposal) => (
            <ProposalCard
              key={proposal.proposal_id}
              proposal={proposal}
              role={activeTab === 'to_review' ? 'reviewer' : 'proposer'}
              isPending={pendingIds.includes(proposal.proposal_id)}
              onResolve={handleResolve}
              onWithdraw={handleWithdraw}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default ProposalsPage;
