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

  const structuralFeatures = perFeature.filter((f) => f.type === 'structural');
  const auditFeatures = perFeature.filter((f) => f.type === 'audit');

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
    if (totals.emptyFields > 0) {
      badges.push(`${totals.emptyFields} missing core fields`);
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
        {totals.missingExamples > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--warn">
            <span className="ai-gap-stat__value">{totals.missingExamples}</span>
            <span className="ai-gap-stat__label">Missing Examples</span>
          </div>
        ) : null}
        {totals.missingClozeDistractors > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--warn">
            <span className="ai-gap-stat__value">{totals.missingClozeDistractors}</span>
            <span className="ai-gap-stat__label">Missing Word-Bank</span>
          </div>
        ) : null}
        {totals.neverAudited > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--muted">
            <span className="ai-gap-stat__value">{totals.neverAudited}</span>
            <span className="ai-gap-stat__label">Unaudited by AI</span>
          </div>
        ) : (
          <div className="ai-gap-stat ai-gap-stat--success">
            <span className="ai-gap-stat__value">100%</span>
            <span className="ai-gap-stat__label">AI Audited</span>
          </div>
        )}
        {totals.invalidFields > 0 ? (
          <div className="ai-gap-stat ai-gap-stat--danger">
            <span className="ai-gap-stat__value">{totals.invalidFields}</span>
            <span className="ai-gap-stat__label">Invalid Fields</span>
          </div>
        ) : null}
      </div>

      {/* --- Feature breakdown: Core Structural Data --- */}
      <div className="ai-gap-breakdown">
        <h3 className="st-field__label">Core Data Completeness (Required for minigames)</h3>
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
                    <span className="ai-status ai-status--completed">Complete</span>
                  ) : (
                    <span className="ai-status ai-status--failed">
                      {feature.count} card{feature.count === 1 ? '' : 's'} missing
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
            <h3 className="st-field__label">AI Quality Audits (Optional Deep Verification)</h3>
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
                      <span className="ai-status ai-status--completed">Verified</span>
                    ) : (
                      <span className="ai-status">
                        {feature.count} card{feature.count === 1 ? '' : 's'} unverified
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="st-section__hint">
            Unaudited cards are fully playable in Smart Practice and all minigames as long as core fields are complete.
            Running an <strong>Audit and improve</strong> run evaluates and refines them using an AI judge.
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
              ? `Hide itemized cards (${cardsNeedingWork.length})`
              : `Inspect cards needing work (${cardsNeedingWork.length})`}
          </button>

          {showCardDetails ? (
            <ul className="ai-gap-card-list">
              {cardsNeedingWork.map(({ card, presence, issues, failingFeatures }, idx) => (
                <li className="ai-gap-card-item" key={card.id || card.card_id || idx}>
                  <div className="ai-gap-card-item__head">
                    <span className="ai-gap-card-item__spanish">{card.l1_text ?? card.prompt_l1 ?? card.spanish_text ?? card.prompt_es}</span>
                    <span className="ai-gap-card-item__arrow">→</span>
                    <span className="ai-gap-card-item__english">{card.l2_text ?? card.answer_l2 ?? card.english_text ?? card.answer_en}</span>
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
                    {presence['cloze-options'] === 'partial' && (
                      <span className="ai-gap-tag ai-gap-tag--partial">Incomplete word-bank</span>
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
            🎉 All cards in this deck have complete definitions, examples, and word-bank options. No structural gaps detected.
          </p>
        </div>
      )}
    </div>
  );
}
