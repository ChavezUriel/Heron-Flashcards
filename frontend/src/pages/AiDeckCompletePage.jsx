// AI deck completion page (/decks/complete).
//
// Phase 1: Free, read-only deck gap scan.
// Inspects existing cards from the user's decks to detect missing example pairs,
// unpopulated word-bank distractors, incomplete lexical fields, or stale audits.

import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import AiModeTabs from '../components/AiModeTabs';
import DeckGapReport from '../components/DeckGapReport';
import { fetchHomeDecks, fetchMarketDecks, fetchDeckCardsForAi } from '../api';
import { scanDeck } from '../ai/deckAudit';

function StepHeader({ index, title, hint }) {
  return (
    <div className="ai-step__head">
      <span className="ai-step__index" aria-hidden="true">{index}</span>
      <div>
        <h2 className="st-section__title">{title}</h2>
        <p className="st-section__hint">{hint}</p>
      </div>
    </div>
  );
}

export default function AiDeckCompletePage() {
  const [searchParams] = useSearchParams();
  const initialDeckId = searchParams.get('deck');

  const [decks, setDecks] = useState([]);
  const [loadingDecks, setLoadingDecks] = useState(true);
  const [decksError, setDecksError] = useState('');

  const [selectedDeckId, setSelectedDeckId] = useState(initialDeckId ? Number(initialDeckId) : null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanResult, setScanResult] = useState(null);

  // Load candidate writable decks: personal home decks + market decks the user maintains
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingDecks(true);
      setDecksError('');
      try {
        const [homeDecks, marketDecks] = await Promise.all([
          fetchHomeDecks(),
          fetchMarketDecks().catch(() => []),
        ]);
        if (!cancelled) {
          const userHomeDecks = (homeDecks || []).map((d) => ({
            ...d,
            isMarket: false,
            writable: true,
          }));
          const maintainedMarketDecks = (marketDecks || [])
            .filter((d) => Boolean(d.is_owner))
            .map((d) => ({
              ...d,
              isMarket: true,
              writable: true,
            }));
          setDecks([...userHomeDecks, ...maintainedMarketDecks]);
        }
      } catch (err) {
        if (!cancelled) {
          setDecksError(err.message || 'Failed to load decks');
        }
      } finally {
        if (!cancelled) {
          setLoadingDecks(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDeck = decks.find((d) => d.id === selectedDeckId) || null;

  // Run scan whenever selected deck changes
  useEffect(() => {
    if (!selectedDeckId || !selectedDeck) {
      setScanResult(null);
      return;
    }

    let cancelled = false;
    async function runScan() {
      setScanning(true);
      setScanError('');
      try {
        const cards = await fetchDeckCardsForAi(selectedDeck.id);
        if (!cancelled) {
          const deckCtx = {
            id: selectedDeck.id,
            title: selectedDeck.title,
            description: selectedDeck.description,
            slug: selectedDeck.slug,
          };
          const scan = scanDeck(cards, deckCtx, true);
          setScanResult(scan);
        }
      } catch (err) {
        if (!cancelled) {
          setScanError(err.message || 'Failed to fetch deck cards for scan');
        }
      } finally {
        if (!cancelled) {
          setScanning(false);
        }
      }
    }

    runScan();
    return () => {
      cancelled = true;
    };
  }, [selectedDeckId, selectedDeck]);

  return (
    <div className="ai-page">
      <AiModeTabs />

      <header className="st-header">
        <p className="st-kicker">AI DECK COMPLETION</p>
        <h1 className="st-header__title">Complete an existing deck</h1>
        <p className="st-section__hint">
          Fill in missing example sentences, word-bank options, and vocabulary metadata for decks
          you already own — or audit and improve what is already there. The initial scan is free,
          instant, and runs completely in your browser.
        </p>
      </header>

      {/* --- Step 1: Pick a Deck --- */}
      <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-1">
        <StepHeader
          index="1"
          title={<span id="ai-complete-step-1">Pick a deck to scan</span>}
          hint="Select any personal deck or maintained market deck to inspect for missing fields."
        />

        {loadingDecks ? (
          <div className="st-section__hint">Loading your decks…</div>
        ) : decksError ? (
          <div className="st-error">{decksError}</div>
        ) : decks.length === 0 ? (
          <div className="st-section__hint">
            No writable decks found. <Link to="/market">Browse the market</Link> or{' '}
            <Link to="/decks/new">create a new deck</Link> first.
          </div>
        ) : (
          <label className="st-field">
            <span className="st-field__label">Target Deck</span>
            <select
              className="st-input"
              value={selectedDeckId || ''}
              onChange={(e) => setSelectedDeckId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select a deck…</option>
              {decks.map((deck) => (
                <option key={`${deck.isMarket ? 'market-' : 'home-'}${deck.id}`} value={deck.id}>
                  {deck.title} ({deck.total_cards ?? 0} cards){deck.isMarket ? ' — (Market deck you maintain)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {/* --- Step 2: Gap Report --- */}
      {selectedDeck ? (
        <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-2">
          <StepHeader
            index="2"
            title={<span id="ai-complete-step-2">Deck Gap Report</span>}
            hint="Free, instant analysis of missing or incomplete cards — zero LLM calls."
          />

          {scanning ? (
            <div className="st-section__hint">Scanning cards in {selectedDeck.title}…</div>
          ) : scanError ? (
            <div className="st-error">{scanError}</div>
          ) : scanResult ? (
            <DeckGapReport scan={scanResult} deck={selectedDeck} />
          ) : null}
        </section>
      ) : null}

      {/* --- Steps 3–5: Stubs for subsequent phases --- */}
      <section className="panel st-section ai-step ai-step--disabled" aria-labelledby="ai-complete-step-3">
        <StepHeader
          index="3"
          title={<span id="ai-complete-step-3">Choose what to do</span>}
          hint="Fill in blanks only (never touch existing values) or Audit and improve (re-evaluate and rewrite failing fields)."
        />
        <p className="st-section__hint">
          <em>Coming next in Phase 2: Select fill mode and customize which feature groups to repair.</em>
        </p>
      </section>

      <section className="panel st-section ai-step ai-step--disabled" aria-labelledby="ai-complete-step-4">
        <StepHeader
          index="4"
          title={<span id="ai-complete-step-4">Deck context</span>}
          hint="Provide deck topic and difficulty to guide the AI, or infer them automatically from the deck's cards."
        />
        <p className="st-section__hint">
          <em>Coming next in Phase 2: Automatic topic &amp; difficulty inference.</em>
        </p>
      </section>

      <section className="panel st-section ai-step ai-step--disabled" aria-labelledby="ai-complete-step-5">
        <StepHeader
          index="5"
          title={<span id="ai-complete-step-5">Provider &amp; launch</span>}
          hint="Run the fill job with your chosen LLM provider key, review the proposed diffs, and apply."
        />
        <p className="st-section__hint">
          <em>Coming next in Phase 2: Live fill run, per-card diff review, and batch patching.</em>
        </p>
      </section>
    </div>
  );
}
