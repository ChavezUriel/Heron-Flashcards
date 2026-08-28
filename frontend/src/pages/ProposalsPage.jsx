import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchMarketDecks,
  listDeckProposals,
  resolveDeckChangeProposal,
  transferMarketDeckOwnership,
  withdrawDeckChangeProposal,
} from '../api';
import { cardTitle, diffCardContent } from '../cardDiff';

function BackIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const STATUS_LABELS = {
  open: 'Open',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function ProposalItemDiff({ item }) {
  if (item.change_type === 'add_card') {
    return (
      <li className="sync-row">
        <p className="sync-row__title">
          <span className="sync-chip sync-chip--add">New card</span>
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
          <span className="sync-chip sync-chip--warn">Card removal</span>
          {cardTitle(item.base_snapshot)}
        </p>
        <p className="proposal-item__detail">Proposed deletion from the public market deck.</p>
      </li>
    );
  }

  const diff = diffCardContent(item.base_snapshot, item.payload);
  return (
    <li className="sync-row">
      <p className="sync-row__title">
        {cardTitle(item.base_snapshot ?? item.payload)}
        {item.is_stale ? (
          <span className="sync-chip sync-chip--warn" title="The market card changed after this was proposed">
            Market card changed since
          </span>
        ) : null}
        {item.current_base === null ? (
          <span className="sync-chip sync-chip--warn">Market card no longer exists</span>
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
  const [expanded, setExpanded] = useState(proposal.status === 'open');
  const [note, setNote] = useState('');
  const isOpen = proposal.status === 'open';

  return (
    <article className={`proposal-card ${isOpen ? 'proposal-card--open' : ''}`}>
      <button
        type="button"
        className="proposal-card__head"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <div className="proposal-card__head-main">
          <span className={`sync-chip sync-chip--${proposal.status}`}>{STATUS_LABELS[proposal.status] ?? proposal.status}</span>
          <span className="proposal-card__deck">{proposal.market_deck_title}</span>
          <span className="proposal-card__meta">
            {proposal.items.length} change{proposal.items.length === 1 ? '' : 's'}
            {' · '}
            {role === 'reviewer' ? `from ${proposal.proposer_name}` : 'by you'}
            {' · '}
            {formatDate(proposal.created_at)}
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
              {STATUS_LABELS[proposal.status]} {formatDate(proposal.resolved_at)}
              {proposal.resolved_by_name && proposal.status !== 'withdrawn' ? ` by ${proposal.resolved_by_name}` : ''}
              {proposal.resolution_note ? ` — “${proposal.resolution_note}”` : ''}
            </p>
          ) : null}

          {isOpen && role === 'reviewer' ? (
            <div className="proposal-card__actions">
              <input
                type="text"
                className="proposal-card__note"
                placeholder="Optional note to the proposer"
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
                  Approve &amp; apply
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={isPending}
                  onClick={() => onResolve(proposal.proposal_id, 'reject', note)}
                >
                  Reject
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
                Withdraw proposal
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MaintainedDeckRow({ deck, onTransferred }) {
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
            ? `${deck.open_proposals} open proposal${deck.open_proposals === 1 ? '' : 's'}`
            : 'No open proposals'}
        </span>
      </div>
      {showTransfer ? (
        <div className="maintained-deck__transfer">
          <input
            type="email"
            placeholder="new-maintainer@email.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
          />
          <button className="button button--primary" type="button" disabled={pending || !email.trim()} onClick={handleTransfer}>
            {pending ? 'Transferring…' : 'Transfer'}
          </button>
          <button className="button button--secondary" type="button" disabled={pending} onClick={() => { setShowTransfer(false); setError(''); }}>
            Cancel
          </button>
          {error ? <p className="sync-modal__status sync-modal__status--error">{error}</p> : null}
        </div>
      ) : (
        <button className="h-decks__text-action" type="button" onClick={() => setShowTransfer(true)}>
          Transfer ownership
        </button>
      )}
    </li>
  );
}

function ProposalsPage() {
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
    return <p className="h-empty-state">Loading proposals…</p>;
  }

  if (status === 'error') {
    return (
      <section className="h-market proposals-page">
        <Link to="/market" className="back-link back-link--home back-link--button">
          <BackIcon />
          <span>Back to market</span>
        </Link>
        <p className="h-empty-state h-empty-state--error">Unable to load proposals: {error}</p>
      </section>
    );
  }

  const visibleProposals = activeTab === 'to_review' ? proposals.to_review : proposals.mine;

  return (
    <section className="h-market proposals-page">
      <div className="proposals-page__head">
        <Link to="/market" className="back-link back-link--home back-link--button">
          <BackIcon />
          <span>Back to market</span>
        </Link>
        <p className="h-market__kicker">DECK MARKET</p>
        <h1 className="h-market__title">Change proposals.</h1>
        <p className="h-market__copy">
          Improvements travel both ways: subscribers propose card edits, maintainers review them,
          and approved changes reach everyone through deck sync.
        </p>
      </div>

      {maintainedDecks.length > 0 ? (
        <section className="proposals-page__maintained panel">
          <h2>Decks you maintain</h2>
          <ul>
            {maintainedDecks.map((deck) => (
              <MaintainedDeckRow key={deck.id} deck={deck} onTransferred={handleTransferred} />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="proposals-page__tabs" role="tablist" aria-label="Proposal lists">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'to_review'}
          className={`h-seg__btn ${activeTab === 'to_review' ? 'h-seg__btn--active' : ''}`}
          onClick={() => setTab('to_review')}
        >
          To review{openToReview > 0 ? ` (${openToReview})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'mine'}
          className={`h-seg__btn ${activeTab === 'mine' ? 'h-seg__btn--active' : ''}`}
          onClick={() => setTab('mine')}
        >
          My proposals{proposals.mine.length > 0 ? ` (${proposals.mine.length})` : ''}
        </button>
      </div>

      {actionError ? <p className="sync-modal__status sync-modal__status--error">{actionError}</p> : null}

      {visibleProposals.length === 0 ? (
        <div className="h-empty-panel panel">
          <p>
            {activeTab === 'to_review'
              ? 'No proposals to review. When subscribers of the decks you maintain propose changes, they land here.'
              : 'You have not proposed any changes yet. Edit cards in your copy of a market deck, then use “Propose to market” in the deck explorer.'}
          </p>
          <Link to="/market" className="button button--primary">Back to market</Link>
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
