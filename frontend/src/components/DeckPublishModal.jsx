import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publishUserDeck, updateCardVisibility } from '../api';
import { auditDeckForPublishing, SAFETY_CATEGORIES } from '../ai/safetyAudit';
import { loadCredentials, loadBuilderPrefs } from '../ai/keyStore';
import { DEFAULT_PROVIDER_ID } from '../ai/providers';
import { createLlmClient } from '../ai/llmClient';
import AiProviderPanel from './AiProviderPanel';

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="publish-icon publish-icon--success">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldAlertIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="publish-icon publish-icon--alert">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8v4M12 16h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SeverityBadge({ severity }) {
  const norm = String(severity || 'medium').toLowerCase();
  const label = norm.charAt(0).toUpperCase() + norm.slice(1);
  return <span className={`safety-badge safety-badge--${norm}`}>{label}</span>;
}

function CategoryBadge({ categoryKey }) {
  const cat = SAFETY_CATEGORIES[categoryKey] || { label: categoryKey };
  return <span className="safety-category-chip">{cat.label}</span>;
}

export default function DeckPublishModal({
  deckId,
  deckPreview,
  onClose,
  onPublished,
  onEditCard,
}) {
  const navigate = useNavigate();
  const [credentials, setCredentials] = useState(() => loadCredentials());
  const [providerId, setProviderId] = useState(() => loadBuilderPrefs().providerId || DEFAULT_PROVIDER_ID);
  const [showProviderSetup, setShowProviderSetup] = useState(false);

  // States: 'idle' | 'scanning' | 'report' | 'publishing' | 'published'
  const [stage, setStage] = useState('idle');
  const [scanProgress, setScanProgress] = useState({ phase: '', step: 0, total: 0, message: '' });
  const [report, setReport] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  const [error, setError] = useState('');
  const [actionPendingCardId, setActionPendingCardId] = useState(null);

  const abortControllerRef = useRef(null);

  const activeCards = useMemo(() => {
    return (deckPreview?.cards || []).filter((c) => !c.is_deleted);
  }, [deckPreview]);

  const credential = credentials[providerId];
  const hasKey = Boolean(credential?.apiKey);

  // Run or re-run the safety audit
  async function handleStartScan() {
    setError('');
    setStage('scanning');
    setReport(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const client = hasKey ? createLlmClient(credential) : null;
      const runPrompt = client
        ? (promptObj) => client.chatJson(promptObj, controller.signal)
        : null;

      const deckMeta = {
        id: deckPreview.deck_id,
        title: deckPreview.deck_title,
        description: deckPreview.deck_description,
        language_from: deckPreview.language_from || 'es',
        language_to: deckPreview.language_to || 'en',
      };

      const auditResult = await auditDeckForPublishing(deckMeta, deckPreview.cards, {
        runPrompt,
        onProgress: (p) => setScanProgress(p),
        signal: controller.signal,
        skipLLM: !hasKey,
      });

      setReport(auditResult);
      setStage('report');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Error occurred during safety audit.');
      setStage('idle');
    }
  }

  // Cancel running scan
  function handleCancelScan() {
    abortControllerRef.current?.abort();
    setStage('idle');
  }

  // Publish confirmed deck to market
  async function handleConfirmPublish() {
    if (!report?.eligible) return;
    setStage('publishing');
    setError('');

    try {
      const result = await publishUserDeck(deckId, report);
      setPublishResult(result);
      setStage('published');
      onPublished?.(result);
    } catch (err) {
      setError(err.message || 'Failed to publish deck.');
      setStage('report');
    }
  }

  // Quick action: Hide/Disable a conflicted card so the deck can pass
  async function handleDisableCard(cardId) {
    setActionPendingCardId(cardId);
    try {
      await updateCardVisibility(cardId, false);
      // Remove or update the card locally in report
      setReport((prev) => {
        if (!prev) return prev;
        const nextConflicted = prev.conflicted_cards.filter((c) => c.card_id !== cardId);
        const isEligible = nextConflicted.length === 0 && prev.summary.deck_level_issues.length === 0;
        return {
          ...prev,
          eligible: isEligible,
          verdict: isEligible ? 'approved' : 'rejected',
          summary: {
            ...prev.summary,
            conflicted_cards_count: nextConflicted.length,
            verdict_summary: isEligible
              ? 'All conflicted cards resolved! Deck is now ready for publishing.'
              : prev.summary.verdict_summary,
          },
          conflicted_cards: nextConflicted,
        };
      });
    } catch (err) {
      setError(`Failed to disable card: ${err.message}`);
    } finally {
      setActionPendingCardId(null);
    }
  }

  return (
    <div className="details-modal" role="dialog" aria-modal="true" aria-label="Publish deck to market">
      <button
        aria-label="Close publish dialog"
        className="details-modal__backdrop"
        type="button"
        onClick={onClose}
      />
      <div className="details-modal__panel publish-modal__panel">
        <button
          aria-label="Close publish dialog"
          className="details-modal__close"
          type="button"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>

        <div className="details-modal__header">
          <p className="flashcard__label">Market Publication</p>
          <h3>Publish Deck to Market</h3>
        </div>

        {error && <p className="sync-modal__status sync-modal__status--error">{error}</p>}

        {/* STAGE 1: IDLE / SETUP */}
        {stage === 'idle' && (
          <div className="publish-modal__body">
            <div className="publish-summary-card">
              <h4 className="publish-summary-title">{deckPreview.deck_title}</h4>
              <p className="publish-summary-desc">{deckPreview.deck_description || 'No description provided.'}</p>
              <div className="publish-meta-row">
                <span className="publish-meta-pill">
                  <strong>{activeCards.length}</strong> active flashcards
                </span>
                <span className="publish-meta-pill">
                  Creator maintains ownership
                </span>
              </div>
            </div>

            <div className="publish-info-box">
              <h4>Safety & Quality Guarantee</h4>
              <p>
                Before publishing, DuoCards filters content with an AI security, ethics, and quality check to ensure
                community guidelines, language accuracy, and privacy are upheld.
              </p>
              {!hasKey && (
                <p className="publish-note">
                  <em>Tip:</em> Configure an AI API key below for deep semantic checking and automatic false-friend analysis.
                </p>
              )}
            </div>

            {/* Provider dropdown / config */}
            <div className="publish-provider-toggle">
              <button
                type="button"
                className="button button--secondary st-button--compact"
                onClick={() => setShowProviderSetup((prev) => !prev)}
              >
                {showProviderSetup ? 'Hide AI Provider Settings' : 'Configure AI Provider Key ⚙'}
              </button>
            </div>

            {showProviderSetup && (
              <div className="publish-provider-embed">
                <AiProviderPanel
                  providerId={providerId}
                  onProviderChange={setProviderId}
                  onCredentialChange={() => {
                    setCredentials(loadCredentials());
                  }}
                />
              </div>
            )}

            <div className="publish-modal__footer">
              <button type="button" className="button button--secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={handleStartScan}
                disabled={activeCards.length === 0}
              >
                Start Security & Ethics Audit →
              </button>
            </div>
          </div>
        )}

        {/* STAGE 2: SCANNING IN PROGRESS */}
        {stage === 'scanning' && (
          <div className="publish-modal__body">
            <div className="publish-scanning">
              <div className="publish-spinner" />
              <h3>Scanning Flashcards with AI</h3>
              <p className="publish-scanning__msg">{scanProgress.message || 'Analyzing cards...'}</p>

              <div className="publish-progress-bar">
                <div
                  className="publish-progress-bar__fill"
                  style={{
                    width: `${scanProgress.total > 0 ? (scanProgress.step / scanProgress.total) * 100 : 25}%`,
                  }}
                />
              </div>

              <div className="publish-modal__footer publish-modal__footer--center">
                <button type="button" className="button button--secondary st-button--compact" onClick={handleCancelScan}>
                  Stop Scan
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STAGE 3: REPORT (APPROVED OR REJECTED) */}
        {stage === 'report' && report && (
          <div className="publish-modal__body">
            {report.eligible ? (
              /* APPROVED VERDICT */
              <div className="publish-verdict publish-verdict--approved">
                <div className="publish-verdict__icon">
                  <ShieldCheckIcon />
                </div>
                <div className="publish-verdict__content">
                  <h4>Deck Approved for Community Market!</h4>
                  <p>{report.summary.verdict_summary}</p>
                  <div className="publish-metrics">
                    <span>✓ {report.summary.clean_cards} cards clean</span>
                    <span>✓ 0 policy conflicts</span>
                  </div>
                </div>
              </div>
            ) : (
              /* REJECTED VERDICT */
              <div className="publish-verdict publish-verdict--rejected">
                <div className="publish-verdict__icon">
                  <ShieldAlertIcon />
                </div>
                <div className="publish-verdict__content">
                  <h4>Publication Blocked — Revisions Required</h4>
                  <p className="publish-verdict__why">{report.summary.verdict_summary}</p>

                  {/* Policy breakdown tags */}
                  <div className="publish-breakdown-tags">
                    {Object.entries(report.summary.policy_breakdown || {}).map(([catKey, count]) => {
                      if (count <= 0) return null;
                      return (
                        <span key={catKey} className="publish-breakdown-tag">
                          <strong>{count}</strong> {SAFETY_CATEGORIES[catKey]?.label || catKey}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* LIST OF CONFLICTED FLASHCARDS */}
            {report.conflicted_cards.length > 0 && (
              <div className="publish-conflicted-section">
                <div className="publish-conflicted-header">
                  <h4>
                    Conflicted Flashcards ({report.conflicted_cards.length})
                  </h4>
                  <p>
                    Fix the highlighted issues below or exclude the card from the deck before publishing.
                  </p>
                </div>

                <div className="publish-conflicted-list">
                  {report.conflicted_cards.map((card) => (
                    <div key={card.card_id} className="safety-conflicted-card">
                      <div className="safety-conflicted-card__head">
                        <div className="safety-card-pair">
                          <span className="safety-card-prompt">{card.prompt_l1}</span>
                          <span className="safety-card-arrow">→</span>
                          <span className="safety-card-answer">{card.answer_l2}</span>
                        </div>
                        <div className="safety-card-tags">
                          <SeverityBadge severity={card.severity} />
                          {(card.violated_categories || []).map((cat) => (
                            <CategoryBadge key={cat} categoryKey={cat} />
                          ))}
                        </div>
                      </div>

                      {/* Why Rejected Explanation */}
                      <div className="safety-issue-reason">
                        <strong>Why Rejected:</strong> {card.why_rejected}
                      </div>

                      {/* Flagged Excerpt */}
                      {card.flagged_excerpt && (
                        <div className="safety-issue-excerpt">
                          <span className="safety-excerpt-label">Flagged text ({card.flagged_field}):</span>
                          <mark className="safety-mark">{card.flagged_excerpt}</mark>
                        </div>
                      )}

                      {/* Actionable Remediation Advice */}
                      <div className="safety-remediation">
                        <strong>💡 How to Fix:</strong> {card.remediation_advice}
                      </div>

                      {/* Actions per card */}
                      <div className="safety-card-actions">
                        {onEditCard && (
                          <button
                            type="button"
                            className="button button--secondary st-button--compact"
                            onClick={() => {
                              onEditCard(card.card_id);
                            }}
                          >
                            ✏️ Edit Card
                          </button>
                        )}
                        <button
                          type="button"
                          className="button button--danger-outline st-button--compact"
                          disabled={actionPendingCardId === card.card_id}
                          onClick={() => handleDisableCard(card.card_id)}
                        >
                          {actionPendingCardId === card.card_id ? 'Excluding…' : 'Exclude from Deck'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bottom Actions */}
            <div className="publish-modal__footer">
              <button type="button" className="button button--secondary" onClick={onClose}>
                Close
              </button>
              {!report.eligible && (
                <button type="button" className="button button--secondary" onClick={handleStartScan}>
                  🔄 Re-run Safety Audit
                </button>
              )}
              {report.eligible && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={handleConfirmPublish}
                  disabled={stage === 'publishing'}
                >
                  {stage === 'publishing' ? 'Publishing…' : 'Publish to Market Now 🚀'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* STAGE 4: PUBLISHED SUCCESS */}
        {stage === 'published' && publishResult && (
          <div className="publish-modal__body">
            <div className="publish-success">
              <div className="publish-verdict__icon">
                <ShieldCheckIcon />
              </div>
              <h3>🎉 Your Deck is Live on the Market!</h3>
              <p>
                Other language learners can now discover, add, and study your deck from the Market.
                You are registered as the deck maintainer.
              </p>
              <div className="publish-modal__footer publish-modal__footer--center">
                <button type="button" className="button button--secondary" onClick={onClose}>
                  Done
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => {
                    onClose();
                    navigate('/market');
                  }}
                >
                  View Market →
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
