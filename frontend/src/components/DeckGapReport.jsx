// Deck Gap Report — visualizes the free, deterministic scanDeck() result.
//
// Shows which fields are missing, invalid, or unverified across a deck's cards.
// Supports both a compact summary (for picker items) and a full detailed report
// (for step 2 of AiDeckCompletePage).

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function DeckGapReport({ scan, deck, compact = false }) {
  const { t } = useTranslation();
  const [showCardDetails, setShowCardDetails] = useState(false);

  if (!scan || !scan.totals) {
    return <div className="st-section__hint">{t('gap_report.no_scan_data')}</div>;
  }

  const { totals, perFeature, perCard } = scan;
  const cardsNeedingWork = perCard.filter((c) => c.needsWork);

  const structuralFeatures = perFeature.filter((f) => f.type === 'structural');
  const auditFeatures = perFeature.filter((f) => f.type === 'audit');

  if (compact) {
    if (totals.cardsNeedingWork === 0) {
      return (
        <span className="ai-gap-badge ai-gap-badge--clean">
          ✓ {t('gap_report.all_complete', { count: totals.totalCards })}
        </span>
      );
    }
    const badges = [];
    if (totals.missingExamples > 0) {
      badges.push(t('gap_report.missing_examples', { count: totals.missingExamples }));
    }
    if (totals.missingClozeDistractors > 0) {
      badges.push(t('gap_report.missing_cloze', { count: totals.missingClozeDistractors }));
    }
    if (totals.emptyFields > 0) {
      badges.push(t('gap_report.empty_fields', { count: totals.emptyFields }));
    }
    if (totals.invalidFields > 0) {
      badges.push(t('gap_report.invalid_fields', { count: totals.invalidFields }));
    }

    return (
      <div className="ai-gap-compact">
        <span className="ai-gap-badge ai-gap-badge--warn">
          {t('gap_report.cards_need_work', { count: totals.cardsNeedingWork, total: totals.totalCards })}
        </span>
        {badges.length > 0 ? (
          <span className="ai-gap-compact__details">
            ({badges.slice(0, 2).join(' · ')}{badges.length > 2 ? '…' : ''})
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="ai-gap-report">
      {/* --- Aggregate summary stat pills --- */}
      <div className="ai-gap-summary">
        <div className="ai-gap-stat">
          <span className="ai-gap-stat__value">{totals.totalCards}</span>
          <span className="ai-gap-stat__label">{t('gap_report.total_cards_stat')}</span>
        </div>
        <div className={`ai-gap-stat ${totals.cardsNeedingWork > 0 ? 'ai-gap-stat--warn' : 'ai-gap-stat--success'}`}>
          <span className="ai-gap-stat__value">{totals.cardsNeedingWork}</span>
          <span className="ai-gap-stat__label">{t('gap_report.need_work_stat')}</span>
        </div>
        {totals.missingExamples > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--warn">
            <span className="ai-gap-stat__value">{totals.missingExamples}</span>
            <span className="ai-gap-stat__label">{t('gap_report.missing_examples_stat')}</span>
          </div>
        ) : null}
        {totals.missingClozeDistractors > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--warn">
            <span className="ai-gap-stat__value">{totals.missingClozeDistractors}</span>
            <span className="ai-gap-stat__label">{t('gap_report.missing_wordbank_stat')}</span>
          </div>
        ) : null}
        {totals.neverAudited > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--muted">
            <span className="ai-gap-stat__value">{totals.neverAudited}</span>
            <span className="ai-gap-stat__label">{t('gap_report.unaudited_stat')}</span>
          </div>
        ) : (
          <div className="ai-gap-stat ai-gap-stat--success">
            <span className="ai-gap-stat__value">100%</span>
            <span className="ai-gap-stat__label">{t('gap_report.audited_stat')}</span>
          </div>
        )}
        {totals.invalidFields > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--danger">
            <span className="ai-gap-stat__value">{totals.invalidFields}</span>
            <span className="ai-gap-stat__label">{t('gap_report.invalid_stat')}</span>
          </div>
        ) : null}
      </div>

      {/* --- Feature breakdown: Core Structural Data --- */}
      <div className="ai-gap-breakdown">
        <h3 className="st-field__label">{t('gap_report.core_completeness_title')}</h3>
        <ul className="ai-gap-feature-list">
          {structuralFeatures.map((feature) => {
            const isClean = feature.count === 0;
            return (
              <li
                className={`ai-gap-feature-item ${isClean ? 'ai-gap-feature-item--clean' : 'ai-gap-feature-item--gap'}`}
                key={feature.id}
              >
                <div className="ai-gap-feature-item__info">
                  <span className="ai-gap-feature-item__title">{feature.title}</span>
                </div>
                <div className="ai-gap-feature-item__status">
                  {isClean ? (
                    <span className="ai-status ai-status--completed">{t('gap_report.complete_status')}</span>
                  ) : (
                    <span className="ai-status ai-status--failed">
                      {t('gap_report.missing_status', { count: feature.count })}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* --- Feature breakdown: AI Quality Audits --- */}
      {auditFeatures.length > 0 ? (
        <div className="ai-gap-breakdown">
          <div className="ai-run__log-head">
            <h3 className="st-field__label">{t('gap_report.ai_audit_title')}</h3>
          </div>
          <ul className="ai-gap-feature-list">
            {auditFeatures.map((feature) => {
              const isClean = feature.count === 0;
              return (
                <li
                  className={`ai-gap-feature-item ${isClean ? 'ai-gap-feature-item--clean' : ''}`}
                  key={feature.id}
                >
                  <div className="ai-gap-feature-item__info">
                    <span className="ai-gap-feature-item__title">{feature.title}</span>
                  </div>
                  <div className="ai-gap-feature-item__status">
                    {isClean ? (
                      <span className="ai-status ai-status--completed">{t('gap_report.verified_status')}</span>
                    ) : (
                      <span className="ai-status">
                        {t('gap_report.unverified_status', { count: feature.count })}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="st-section__hint">
            {t('gap_report.unaudited_hint')}
          </p>
        </div>
      ) : null}

      {/* --- Itemized card gap inspection --- */}
      {cardsNeedingWork.length > 0 ? (
        <div className="ai-gap-cards-section">
          <button
            type="button"
            className="ai-link"
            onClick={() => setShowCardDetails((prev) => !prev)}
            aria-expanded={showCardDetails}
          >
            {showCardDetails
              ? t('gap_report.hide_cards_btn', { count: cardsNeedingWork.length })
              : t('gap_report.inspect_cards_btn', { count: cardsNeedingWork.length })}
          </button>

          {showCardDetails ? (
            <ul className="ai-gap-card-list">
              {cardsNeedingWork.map(({ card, presence, issues, failingFeatures }, idx) => (
                <li className="ai-gap-card-item" key={card.id || card.card_id || idx}>
                  <div className="ai-gap-card-item__head">
                    <span className="ai-gap-card-item__spanish">{card.l1_text ?? card.prompt_l1}</span>
                    <span className="ai-gap-card-item__arrow">→</span>
                    <span className="ai-gap-card-item__english">{card.l2_text ?? card.answer_l2}</span>
                  </div>

                  <div className="ai-gap-card-item__tags">
                    {presence.examples === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">{t('gap_report.tag_no_examples')}</span>
                    )}
                    {presence.examples === 'partial' && (
                      <span className="ai-gap-tag ai-gap-tag--partial">{t('gap_report.tag_incomplete_examples')}</span>
                    )}
                    {presence['cloze-options'] === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">{t('gap_report.tag_no_wordbank')}</span>
                    )}
                    {presence['cloze-options'] === 'partial' && (
                      <span className="ai-gap-tag ai-gap-tag--partial">{t('gap_report.tag_incomplete_wordbank')}</span>
                    )}
                    {presence.lexical === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">{t('gap_report.tag_no_def')}</span>
                    )}
                    {presence.synonyms === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">{t('gap_report.tag_no_synonyms')}</span>
                    )}
                  </div>

                  {/* Specific issues */}
                  {failingFeatures.length > 0 && (
                    <ul className="ai-gap-card-item__issues">
                      {issues.lexical.map((err) => <li key={err}>{err}</li>)}
                      {issues.equivalents.map((err) => <li key={err}>{err}</li>)}
                      {issues.examples.map((err) => <li key={err}>{err}</li>)}
                      {issues.synonyms.map((err) => <li key={err}>{err}</li>)}
                      {issues.clozeDistractors.map((err) => <li key={err}>{err}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="ai-gap-all-clean">
          <p className="st-section__hint">
            {t('gap_report.all_clean_msg')}
          </p>
        </div>
      )}
    </div>
  );
}
