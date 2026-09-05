// ProposedChangeList: Diff review screen for AI fill runs.
//
// Shows each processed card with before -> after diffs (using diffCardContent
// from cardDiff.js). Every card is checked by default; unchecking skips that
// card when applying patches.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CARD_STATUS } from '../ai/generator';
import { diffCardContent } from '../cardDiff';

export default function ProposedChangeList({
  job,
  onToggleCard,
  onToggleAll,
  onToggleField,
  onToggleMismatchFix,
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('all');
  const [openCardId, setOpenCardId] = useState(null);

  const statusLabel = {
    [CARD_STATUS.pending]: t('cards_list.status_queued'),
    [CARD_STATUS.working]: t('cards_list.status_working'),
    [CARD_STATUS.ready]: t('cards_list.status_ready'),
    [CARD_STATUS.flagged]: t('cards_list.status_check'),
    [CARD_STATUS.failed]: t('cards_list.status_failed'),
  };

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
          <h2 className="st-section__title" id="ai-proposed-title">{t('proposed_changes.title')}</h2>
          <p className="st-section__hint">
            {t('proposed_changes.selected_count', { selected: selectedCount, total: cards.length })}
          </p>
        </div>

        <div className="st-actions">
          <button
            type="button"
            className="ai-link"
            onClick={() => onToggleAll && onToggleAll(true)}
          >
            {t('proposed_changes.select_all')}
          </button>
          <button
            type="button"
            className="ai-link"
            onClick={() => onToggleAll && onToggleAll(false)}
          >
            {t('proposed_changes.deselect_all')}
          </button>
        </div>
      </div>

      <div className="ai-filters" role="tablist" aria-label={t('proposed_changes.filter_aria')}>
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          className={`ai-tab${filter === 'all' ? ' ai-tab--active' : ''}`}
          onClick={() => setFilter('all')}
        >
          {t('proposed_changes.filter_all')} <span className="ai-tab__count">{cards.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={filter === 'changed'}
          className={`ai-tab${filter === 'changed' ? ' ai-tab--active' : ''}`}
          onClick={() => setFilter('changed')}
        >
          {t('proposed_changes.filter_changed')} <span className="ai-tab__count">{changedCount}</span>
        </button>

        {unchangedCount > 0 ? (
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unchanged'}
            className={`ai-tab${filter === 'unchanged' ? ' ai-tab--active' : ''}`}
            onClick={() => setFilter('unchanged')}
          >
            {t('proposed_changes.filter_unchanged')} <span className="ai-tab__count">{unchangedCount}</span>
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
            {t('proposed_changes.filter_flagged')} <span className="ai-tab__count">{flaggedCount}</span>
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
                <label className="ai-card-select" title={t('proposed_changes.include_card_title')}>
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
                    <span className="ai-card__prompt">{card.l1_text ?? card.prompt_l1 ?? card.spanish_text ?? card.prompt_es}</span>
                    <span className="ai-card__answer">{card.l2_text ?? card.answer_l2 ?? card.english_text ?? card.answer_en}</span>
                  </span>

                  <span className="ai-card__tags">
                    {hasPairIssue ? (
                      <span className="st-chip st-chip--warning" title={t('proposed_changes.pair_mismatch_title')}>
                        {card._pair_mismatch?.fixes?.length
                          ? t('proposed_changes.pair_mismatch_fixes', { count: card._pair_mismatch.fixes.length })
                          : t('proposed_changes.pair_mismatch_title')}
                      </span>
                    ) : null}
                    {hasDiffs ? (
                      <span className="st-chip st-chip--muted">
                        {t('proposed_changes.changes_count', { count: diffs.length })}
                      </span>
                    ) : (
                      <span className="st-chip st-chip--muted">{t('proposed_changes.no_changes')}</span>
                    )}
                    <span className="ai-card__state">{statusLabel[card._status]}</span>
                  </span>
                </button>
              </div>

              {isOpen ? (
                <div className="ai-card__detail">
                  {hasPairIssue ? (
                    <div className="ai-mismatch-panel">
                      <div className="ai-mismatch-panel__head">
                        <span>{t('proposed_changes.pair_mismatch_heading')}</span>
                      </div>
                      <p className="ai-mismatch-panel__desc">
                        {card._pair_mismatch?.explanation || (card._pair_issues?.length ? card._pair_issues.join('. ') : 'The Spanish and English terms do not match.')}
                      </p>

                      {card._pair_mismatch?.fixes?.length ? (
                        <>
                          <div className="ai-mismatch-fixes">
                            {card._pair_mismatch.fixes.map((fix) => {
                              const isFixSelected = fix._selected !== false;
                              return (
                                <label
                                  key={fix.id}
                                  className={`ai-mismatch-fix${isFixSelected ? ' ai-mismatch-fix--selected' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isFixSelected}
                                    onChange={() => onToggleMismatchFix && onToggleMismatchFix(cardId, fix.id)}
                                    style={{ marginTop: '0.2rem' }}
                                  />
                                  <div className="ai-mismatch-fix__content">
                                    <span className="ai-mismatch-fix__title">{fix.label}</span>
                                    <span className="ai-mismatch-fix__pair">
                                      <span>{fix.l1_text ?? fix.prompt_l1 ?? fix.spanish_text}</span>
                                      <span>➔</span>
                                      <span>{fix.l2_text ?? fix.answer_l2 ?? fix.english_text}</span>
                                    </span>
                                    {fix.l2_definition ?? fix.definition_en ? (
                                      <span className="ai-mismatch-fix__def">{fix.l2_definition ?? fix.definition_en}</span>
                                    ) : null}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                          <div className="ai-mismatch-summary">
                            {(() => {
                              const selectedFixes = card._pair_mismatch.fixes.filter((f) => f._selected !== false);
                              if (selectedFixes.length >= 2) {
                                return t('proposed_changes.pair_fix_both_summary');
                              }
                              if (selectedFixes.length === 1) {
                                const fixL1 = selectedFixes[0].l1_text ?? selectedFixes[0].spanish_text;
                                const fixL2 = selectedFixes[0].l2_text ?? selectedFixes[0].english_text;
                                return t('proposed_changes.pair_fix_single_summary', { pair: `${fixL1} ➔ ${fixL2}` });
                              }
                              return t('proposed_changes.pair_fix_none_summary');
                            })()}
                          </div>
                        </>
                      ) : (
                        <p style={{ margin: '0.25rem 0', fontSize: '0.85rem' }}>
                          <em>{t('proposed_changes.pair_not_rewritten')}</em>
                        </p>
                      )}
                    </div>
                  ) : null}

                  {hasDiffs ? (
                    <div className="ai-diff-wrapper">
                      <table className="ai-diff-table">
                        <thead>
                          <tr>
                            <th>{t('proposed_changes.diff_field')}</th>
                            <th>{t('proposed_changes.diff_current')}</th>
                            <th>{t('proposed_changes.diff_proposed')}</th>
                            <th>{t('proposed_changes.diff_reason')}</th>
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
                                      title={isFieldIncluded ? t('proposed_changes.reject_field_title') : t('proposed_changes.accept_field_title')}
                                    />
                                    {diff.label}
                                  </label>
                                </td>
                                <td className="ai-diff-from">{diff.from || <em className="ai-diff-empty">{t('proposed_changes.empty')}</em>}</td>
                                <td className="ai-diff-to">{diff.to}</td>
                                <td className="ai-diff-reason" style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                                  {reason || t('proposed_changes.fill_gap_reason')}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="st-section__hint">
                      {t('proposed_changes.all_populated_msg')}
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
