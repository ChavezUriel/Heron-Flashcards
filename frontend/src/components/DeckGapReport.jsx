// Deck Gap Report — visualizes the free, deterministic scanDeck() result.
//
// Shows which fields are missing, invalid, or unverified across a deck's cards.
// Supports both a compact summary (for picker items) and a full detailed report
// (for step 2 of AiDeckCompletePage).

import { useState } from 'react';

export default function DeckGapReport({ scan, deck, compact = false }) {
  const [showCardDetails, setShowCardDetails] = useState(false);

  if (!scan || !scan.totals) {
    return <div className="st-section__hint">No scan data available.</div>;
  }

  const { totals, perFeature, perCard } = scan;
  const cardsNeedingWork = perCard.filter((c) => c.needsWork);

  if (compact) {
    if (totals.cardsNeedingWork === 0) {
      return (
        <span className="ai-gap-badge ai-gap-badge--clean">
          ✓ {totals.totalCards} cards · All complete
        </span>
      );
    }
    const badges = [];
    if (totals.missingExamples > 0) {
      badges.push(`${totals.missingExamples} missing examples`);
    }
    if (totals.missingClozeDistractors > 0) {
      badges.push(`${totals.missingClozeDistractors} missing word-bank options`);
    }
    if (totals.neverAudited > 0) {
      badges.push(`${totals.neverAudited} unaudited`);
    }
    if (totals.invalidFields > 0) {
      badges.push(`${totals.invalidFields} invalid fields`);
    }

    return (
      <div className="ai-gap-compact">
        <span className="ai-gap-badge ai-gap-badge--warn">
          {totals.cardsNeedingWork}/{totals.totalCards} cards need work
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
          <span className="ai-gap-stat__label">Total Cards</span>
        </div>
        <div className={`ai-gap-stat ${totals.cardsNeedingWork > 0 ? 'ai-gap-stat--warn' : 'ai-gap-stat--success'}`}>
          <span className="ai-gap-stat__value">{totals.cardsNeedingWork}</span>
          <span className="ai-gap-stat__label">Need Work</span>
        </div>
        <div className={`ai-gap-stat ${totals.missingExamples > 0 ? 'ai-gap-stat--warn' : ''}`}>
          <span className="ai-gap-stat__value">{totals.missingExamples}</span>
          <span className="ai-gap-stat__label">Missing Examples</span>
        </div>
        <div className={`ai-gap-stat ${totals.missingClozeDistractors > 0 ? 'ai-gap-stat--warn' : ''}`}>
          <span className="ai-gap-stat__value">{totals.missingClozeDistractors}</span>
          <span className="ai-gap-stat__label">Missing Word-Bank</span>
        </div>
        <div className={`ai-gap-stat ${totals.neverAudited > 0 ? 'ai-gap-stat--muted' : ''}`}>
          <span className="ai-gap-stat__value">{totals.neverAudited}</span>
          <span className="ai-gap-stat__label">Unaudited</span>
        </div>
        {totals.invalidFields > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--danger">
            <span className="ai-gap-stat__value">{totals.invalidFields}</span>
            <span className="ai-gap-stat__label">Invalid Fields</span>
          </div>
        ) : null}
      </div>

      {/* --- Feature breakdown table --- */}
      <div className="ai-gap-breakdown">
        <h3 className="st-field__label">Feature Breakdown</h3>
        <ul className="ai-gap-feature-list">
          {perFeature.map((feature) => {
            const isClean = feature.count === 0;
            return (
              <li className={`ai-gap-feature-item ${isClean ? 'ai-gap-feature-item--clean' : 'ai-gap-feature-item--gap'}`} key={feature.id}>
                <div className="ai-gap-feature-item__info">
                  <span className="ai-gap-feature-item__title">{feature.title}</span>
                </div>
                <div className="ai-gap-feature-item__status">
                  {isClean ? (
                    <span className="ai-status ai-status--completed">Complete</span>
                  ) : (
                    <span className="ai-status ai-status--failed">
                      {feature.count} card{feature.count === 1 ? '' : 's'} failing
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

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
              ? `Hide itemized cards (${cardsNeedingWork.length})`
              : `Inspect cards needing work (${cardsNeedingWork.length})`}
          </button>

          {showCardDetails ? (
            <ul className="ai-gap-card-list">
              {cardsNeedingWork.map(({ card, presence, issues, audits, failingFeatures }, idx) => (
                <li className="ai-gap-card-item" key={card.id || card.card_id || idx}>
                  <div className="ai-gap-card-item__head">
                    <span className="ai-gap-card-item__spanish">{card.spanish_text}</span>
                    <span className="ai-gap-card-item__arrow">→</span>
                    <span className="ai-gap-card-item__english">{card.english_text}</span>
                  </div>

                  <div className="ai-gap-card-item__tags">
                    {presence.examples === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">No examples</span>
                    )}
                    {presence.examples === 'partial' && (
                      <span className="ai-gap-tag ai-gap-tag--partial">Incomplete examples</span>
                    )}
                    {presence['cloze-options'] === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">No word-bank options</span>
                    )}
                    {presence.lexical === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">No definition</span>
                    )}
                    {presence.synonyms === 'empty' && (
                      <span className="ai-gap-tag ai-gap-tag--empty">No synonyms</span>
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
                      {audits.map((err) => <li key={err}>{err}</li>)}
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
            🎉 All cards in this deck meet the full feature set. No gaps detected.
          </p>
        </div>
      )}
    </div>
  );
}
