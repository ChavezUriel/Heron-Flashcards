import { useEffect, useState } from 'react';
import { createDeckChangeProposal, fetchDeckOutgoingChanges } from '../api';
import { cardTitle, diffCardContent } from '../cardDiff';

// One proposable change. Edits show a field-level diff; additions and removals
// only need their title plus a chip naming the kind.
function ProposeChangeRow({ change, checked, onToggle }) {
  const kind = change.kind ?? 'edit';
  const cardId = change.user_card.card_id;
  const diff = kind === 'edit' ? diffCardContent(change.base_card, change.user_card) : [];

  return (
    <li className="sync-row">
      <label className="sync-check">
        <input type="checkbox" checked={checked} onChange={() => onToggle(cardId)} />
        <span className="sync-row__title">
          {kind === 'add' ? <span className="sync-chip sync-chip--add">New card</span> : null}
          {kind === 'remove' ? (
            (change.is_deleted || change.user_card?.is_deleted) ? (
              <span className="sync-chip sync-chip--warn">Deleted</span>
            ) : (
              <span className="sync-chip sync-chip--warn">Hidden</span>
            )
          ) : null}
          {cardTitle(change.user_card)}
          {change.already_proposed ? (
            <span className="sync-chip">Already in an open proposal</span>
          ) : null}
        </span>
      </label>
      {diff.length > 0 ? (
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
      ) : null}
    </li>
  );
}

function ProposeSection({ title, hint, changes, selectedIds, onToggle }) {
  if (changes.length === 0) {
    return null;
  }
  return (
    <section className="sync-section">
      <div className="sync-section__head">
        <span className="sync-section__title">{title}</span>
        <span className="sync-section__count">{changes.length}</span>
      </div>
      {hint ? <p className="sync-section__hint">{hint}</p> : null}
      <ul className="sync-section__list">
        {changes.map((change) => (
          <ProposeChangeRow
            key={change.user_card.card_id}
            change={change}
            checked={selectedIds.has(change.user_card.card_id)}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

// Propose my local card edits, additions, and removals back to the market deck
// ("pull request").
function ProposeChangesModal({ deckId, onClose, onSubmitted }) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [outgoing, setOutgoing] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [message, setMessage] = useState('');
  const [sentProposal, setSentProposal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setStatus('loading');
        setError('');
        const next = await fetchDeckOutgoingChanges(deckId);
        if (!cancelled) {
          setOutgoing(next);
          // Edits and additions are safe to pre-select; removals are
          // destructive for every subscriber, so they start unchecked. Cards
          // already sitting in one of my open proposals start unchecked too.
          setSelectedIds(new Set(
            (next.changes ?? [])
              .filter((change) => !change.already_proposed && (change.kind ?? 'edit') !== 'remove')
              .map((change) => change.user_card.card_id),
          ));
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [deckId]);

  function toggleCard(cardId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
      return next;
    });
  }

  async function handleSubmit() {
    if (selectedIds.size === 0) {
      return;
    }
    setStatus('submitting');
    setError('');
    try {
      const proposal = await createDeckChangeProposal(outgoing.market_deck_id, message, [...selectedIds]);
      setSentProposal(proposal);
      setStatus('sent');
      onSubmitted?.(proposal);
    } catch (submitError) {
      setError(submitError.message);
      setStatus('ready');
    }
  }

  const changes = outgoing?.linked ? outgoing.changes : [];
  const editChanges = changes.filter((change) => (change.kind ?? 'edit') === 'edit');
  const addChanges = changes.filter((change) => change.kind === 'add');
  const removeChanges = changes.filter((change) => change.kind === 'remove');

  return (
    <div className="details-modal" role="dialog" aria-modal="true" aria-label="Propose changes to market deck">
      <button aria-label="Close proposal dialog" className="details-modal__backdrop" type="button" onClick={onClose} />
      <div className="details-modal__panel sync-modal__panel">
        <button aria-label="Close proposal dialog" className="details-modal__close" type="button" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>

        <div className="details-modal__header">
          <p className="flashcard__label">Propose to market</p>
          <h3>{outgoing?.linked ? outgoing.market_deck_title : 'Propose changes'}</h3>
        </div>

        {status === 'loading' ? <p className="sync-modal__status">Comparing your deck with the market…</p> : null}
        {status === 'error' ? <p className="sync-modal__status sync-modal__status--error">{error}</p> : null}

        {status === 'sent' && sentProposal ? (
          <div className="sync-modal__done">
            <p>✓ Proposal sent with {sentProposal.items.length} change{sentProposal.items.length === 1 ? '' : 's'}.</p>
            <p className="sync-modal__done-note">
              The deck maintainer will review it. Track it under “Proposals” in the market.
            </p>
            <button className="button button--secondary" type="button" onClick={onClose}>Close</button>
          </div>
        ) : null}

        {(status === 'ready' || status === 'submitting') && outgoing && !outgoing.linked ? (
          <p className="sync-modal__status">This deck is no longer linked to a market deck.</p>
        ) : null}

        {(status === 'ready' || status === 'submitting') && outgoing?.linked ? (
          changes.length === 0 ? (
            <div className="sync-modal__done">
              <p>Your cards match the market deck — nothing to propose.</p>
              <p className="sync-modal__done-note">Edit, add, or hide cards in your copy first, then propose the changes here.</p>
            </div>
          ) : (
            <>
              <div className="sync-modal__body">
                {error ? <p className="sync-modal__status sync-modal__status--error">{error}</p> : null}
                <p className="sync-section__hint">
                  These are the ways your copy differs from the market. Selected changes are bundled
                  into one proposal for the deck maintainer to review.
                </p>

                <ProposeSection
                  title="Edited cards"
                  changes={editChanges}
                  selectedIds={selectedIds}
                  onToggle={toggleCard}
                />
                <ProposeSection
                  title="New cards"
                  hint="Cards you added that the market deck does not have yet."
                  changes={addChanges}
                  selectedIds={selectedIds}
                  onToggle={toggleCard}
                />
                <ProposeSection
                  title="Card removals"
                  hint="Cards you deleted or hid in your copy. Approving a removal deletes them for all subscribers of the market deck."
                  changes={removeChanges}
                  selectedIds={selectedIds}
                  onToggle={toggleCard}
                />

                <label className="sync-modal__message">
                  <span>Message for the maintainer (optional)</span>
                  <textarea
                    rows={3}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="What did you improve, and why?"
                  />
                </label>
              </div>

              <div className="sync-modal__footer">
                <span className="sync-modal__footer-note">{selectedIds.size} card{selectedIds.size === 1 ? '' : 's'} selected</span>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={selectedIds.size === 0 || status === 'submitting'}
                  onClick={handleSubmit}
                >
                  {status === 'submitting' ? 'Sending…' : 'Send proposal'}
                </button>
              </div>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

export default ProposeChangesModal;
