// ProposedChangeList: Diff review screen for AI fill runs.
//
// Shows each processed card with before -> after diffs (using diffCardContent
// from cardDiff.js). Every card is checked by default; unchecking skips that
// card when applying patches.

import { useState } from 'react';
import { CARD_STATUS } from '../ai/generator';
import { diffCardContent } from '../cardDiff';

const STATUS_LABEL = {
  [CARD_STATUS.pending]: 'Queued',
  [CARD_STATUS.working]: 'Working',
  [CARD_STATUS.ready]: 'Ready',
  [CARD_STATUS.flagged]: 'Check',
  [CARD_STATUS.failed]: 'Failed',
};

export default function ProposedChangeList({ job, onToggleCard, onToggleAll, onToggleField }) {
  const [filter, setFilter] = useState('all');
  const [openCardId, setOpenCardId] = useState(null);

  const cards = job.cards ?? [];
  if (cards.length === 0) return null;

  const cardsWithDiff = cards.map((card) => {
    const diffs = card._before ? diffCardContent(card._before, card) : [];
    return { card, diffs, hasDiffs: diffs.length > 0 };
  });

  const changedCount = cardsWithDiff.filter((c) => c.hasDiffs).length;
  const unchangedCount = cardsWithDiff.filter((c) => !c.hasDiffs).length;
  const flaggedCount = cards.filter((c) => c._status === CARD_STATUS.flagged).length;
  const selectedCount = cards.filter((c) => c._selected !== false).length;

  const visible = cardsWithDiff.filter(({ card, hasDiffs }) => {
    if (filter === 'all') return true;
    if (filter === 'changed') return hasDiffs;
    if (filter === 'unchanged') return !hasDiffs;
    if (filter === 'flagged') return card._status === CARD_STATUS.flagged;
    if (filter === 'failed') return card._status === CARD_STATUS.failed;
    return true;
  });

  return (
    <section className="panel st-section" aria-labelledby="ai-proposed-title">
      <div className="ai-run__log-head">
        <div>
          <h2 className="st-section__title" id="ai-proposed-title">Proposed Changes</h2>
          <p className="st-section__hint">
            {selectedCount} of {cards.length} card(s) selected to apply.
          </p>
        </div>

        <div className="st-actions">
          <button
            type="button"
            className="ai-link"
            onClick={() => onToggleAll && onToggleAll(true)}
          >
            Select all
          </button>
          <button
            type="button"
            className="ai-link"
            onClick={() => onToggleAll && onToggleAll(false)}
          >
            Deselect all
          </button>
        </div>
      </div>

      <div className="ai-filters" role="tablist" aria-label="Filter proposed cards">
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          className={`ai-tab${filter === 'all' ? ' ai-tab--active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All <span className="ai-tab__count">{cards.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={filter === 'changed'}
          className={`ai-tab${filter === 'changed' ? ' ai-tab--active' : ''}`}
          onClick={() => setFilter('changed')}
        >
          Changes proposed <span className="ai-tab__count">{changedCount}</span>
        </button>

        {unchangedCount > 0 ? (
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unchanged'}
            className={`ai-tab${filter === 'unchanged' ? ' ai-tab--active' : ''}`}
            onClick={() => setFilter('unchanged')}
          >
            No changes <span className="ai-tab__count">{unchangedCount}</span>
          </button>
        ) : null}

        {flaggedCount > 0 ? (
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'flagged'}
            className={`ai-tab${filter === 'flagged' ? ' ai-tab--active' : ''}`}
            onClick={() => setFilter('flagged')}
          >
            Needs a look <span className="ai-tab__count">{flaggedCount}</span>
          </button>
        ) : null}
      </div>

      <ul className="ai-card-list">
        {visible.map(({ card, diffs, hasDiffs }) => {
          const cardId = card.card_id ?? card._before?.card_id ?? card.id;
          const isSelected = card._selected !== false;
          const isOpen = openCardId === cardId;
          const hasPairIssue = card._pair_correct === false || (card._pair_issues && card._pair_issues.length > 0);

          return (
            <li key={cardId} className={`ai-card ai-card--${card._status}`}>
              <div className="ai-proposed-row">
                <label className="ai-card-select" title="Include card in apply">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleCard && onToggleCard(cardId)}
                  />
                </label>

                <button
                  type="button"
                  className="ai-card__row ai-proposed-row__btn"
                  aria-expanded={isOpen}
                  onClick={() => setOpenCardId(isOpen ? null : cardId)}
                >
                  <span className="ai-card__status" aria-hidden="true" />
                  <span className="ai-card__text">
                    <span className="ai-card__prompt">{card.spanish_text}</span>
                    <span className="ai-card__answer">{card.english_text}</span>
                  </span>

                  <span className="ai-card__tags">
                    {hasPairIssue ? (
                      <span className="st-chip st-chip--warning" title="Potential translation mismatch">
                        Pair mismatch
                      </span>
                    ) : null}
                    {hasDiffs ? (
                      <span className="st-chip st-chip--muted">
                        {diffs.length} change{diffs.length === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="st-chip st-chip--muted">No changes</span>
                    )}
                    <span className="ai-card__state">{STATUS_LABEL[card._status]}</span>
                  </span>
                </button>
              </div>

              {isOpen ? (
                <div className="ai-card__detail">
                  {hasPairIssue ? (
                    <div className="st-alert st-alert--warning" style={{ marginBottom: '1rem', padding: '0.75rem', borderRadius: '4px' }}>
                      <strong>⚠️ Potential translation mismatch</strong>
                      <p style={{ margin: '0.25rem 0' }}>
                        {card._pair_issues?.length ? card._pair_issues.join('. ') : 'The Spanish and English pair was flagged as potentially inaccurate.'}
                        {' '}<em>Spanish and English texts were not rewritten to protect card identity.</em>
                      </p>
                      {job.targetDeck?.id ? (
                        <a
                          href={`/decks/${job.targetDeck.id}/words`}
                          target="_blank"
                          rel="noreferrer"
                          className="ai-link"
                          style={{ fontSize: '0.85rem' }}
                        >
                          Review in Deck Explorer ↗
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  {hasDiffs ? (
                    <div className="ai-diff-wrapper">
                      <table className="ai-diff-table">
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Current</th>
                            <th>Proposed</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {diffs.map((diff) => {
                            const isFieldIncluded = !card._rejectedFields?.includes(diff.key);
                            const reason = card._fieldReasons?.[diff.key];
                            return (
                              <tr key={diff.key} style={!isFieldIncluded ? { opacity: 0.5, textDecoration: 'line-through' } : {}}>
                                <td className="ai-diff-field">
                                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={isFieldIncluded}
                                      onChange={() => onToggleField && onToggleField(cardId, diff.key)}
                                      title={isFieldIncluded ? 'Click to reject this field change' : 'Click to accept this field change'}
                                    />
                                    {diff.label}
                                  </label>
                                </td>
                                <td className="ai-diff-from">{diff.from || <em className="ai-diff-empty">(empty)</em>}</td>
                                <td className="ai-diff-to">{diff.to}</td>
                                <td className="ai-diff-reason" style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                                  {reason || 'Fill gap'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="st-section__hint">
                      All fields were already populated or protected. No changes proposed.
                    </p>
                  )}

                  {card._issues?.length ? (
                    <ul className="ai-card__issues">
                      {card._issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
