// AI deck completion page (/decks/complete).
//
// Steps:
//   1. Choose the provider (AiProviderPanel, concurrency slider)
//   2. Pick a deck (home decks + maintained market decks)
//   3. Free gap scan (DeckGapReport: missing examples, distractors, lexical fields)
//   4. Choose what to do (mode + per-group checkboxes)
//   5. Deck context (topic, difficulty, notes; "Infer from the deck" button)
//   6. Launch (ready to complete, start fill/audit run)

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import AiModeTabs from '../components/AiModeTabs';
import DeckGapReport from '../components/DeckGapReport';
import AiProviderPanel from '../components/AiProviderPanel';
import { fetchHomeDecks, fetchMarketDecks, fetchDeckCardsForAi } from '../api';
import { scanDeck, estimateFillRun } from '../ai/deckAudit';
import { DIFFICULTIES } from '../ai/deckSpec';
import {
  specFromDeckPrompt,
  loadDeckContextCache,
  saveDeckContextCache,
} from '../ai/specPrompts';
import { createLlmClient } from '../ai/llmClient';
import { loadBuilderPrefs, saveBuilderPrefs } from '../ai/keyStore';
import { createFillJob } from '../ai/generator';
import { listJobs, saveJob, reconcileInterruptedJobs } from '../ai/jobStore';
import { startRun } from '../ai/runManager';

const CONCURRENCY_RANGE = { min: 1, max: 8 };

const GROUP_OPTIONS = [
  { id: 'lexical', label: 'Part of speech & English definitions' },
  { id: 'equivalents', label: 'Translations & collocations' },
  { id: 'synonyms', label: 'English synonyms' },
  { id: 'examples', label: '3+ blankable example sentence pairs' },
  { id: 'cloze-options', label: 'Curated word-bank distractors' },
];

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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialDeckId = searchParams.get('deck');

  const [decks, setDecks] = useState([]);
  const [loadingDecks, setLoadingDecks] = useState(true);
  const [decksError, setDecksError] = useState('');

  const [selectedDeckId, setSelectedDeckId] = useState(initialDeckId ? Number(initialDeckId) : null);
  const [rawCards, setRawCards] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanResult, setScanResult] = useState(null);

  const [mode, setMode] = useState('fill');
  const [selectedGroups, setSelectedGroups] = useState([
    'lexical',
    'equivalents',
    'synonyms',
    'examples',
    'cloze-options',
  ]);

  const [deckCtx, setDeckCtx] = useState({
    topic: '',
    difficulty: 'intermediate',
    learner_profile: '',
    generation_notes: '',
  });
  const [inferring, setInferring] = useState(false);
  const [inferError, setInferError] = useState('');

  const [prefs, setPrefs] = useState(() => loadBuilderPrefs());
  const [credential, setCredential] = useState(null);
  const [launchError, setLaunchError] = useState('');
  const [recentJobs, setRecentJobs] = useState([]);

  useEffect(() => {
    reconcileInterruptedJobs();
    setRecentJobs(listJobs().filter((j) => j.kind === 'fill'));
  }, []);

  const hasKey = Boolean(credential?.apiKey);
  const handleCredentialChange = useCallback((next) => setCredential(next), []);

  function updatePrefs(patch) {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      saveBuilderPrefs(next);
      return next;
    });
  }

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

  useEffect(() => {
    const deckParam = searchParams.get('deck');
    if (deckParam) {
      setSelectedDeckId(Number(deckParam));
    }
  }, [searchParams]);

  const selectedDeck = decks.find((d) => Number(d.id) === Number(selectedDeckId)) || null;

  // Run scan whenever selected deck changes
  useEffect(() => {
    if (!selectedDeckId || !selectedDeck) {
      setScanResult(null);
      setRawCards([]);
      return;
    }

    let cancelled = false;
    async function runScan() {
      setScanning(true);
      setScanError('');
      try {
        const cards = await fetchDeckCardsForAi(selectedDeck.id);
        if (!cancelled) {
          setRawCards(cards || []);
          const ctx = {
            id: selectedDeck.id,
            title: selectedDeck.title,
            description: selectedDeck.description,
            slug: selectedDeck.slug,
          };
          const scan = scanDeck(cards, ctx, true);
          setScanResult(scan);

          // Populate or load cached deck context
          const cached = loadDeckContextCache(selectedDeck.id);
          if (cached) {
            setDeckCtx(cached);
          } else {
            setDeckCtx({
              topic: selectedDeck.title || '',
              difficulty: 'intermediate',
              learner_profile: '',
              generation_notes: '',
            });
          }
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

  const estimate = useMemo(
    () => estimateFillRun(scanResult, mode, selectedGroups, prefs.concurrency),
    [scanResult, mode, selectedGroups, prefs.concurrency],
  );

  function toggleGroup(groupId) {
    setSelectedGroups((current) =>
      current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId],
    );
  }

  async function handleInferContext() {
    if (!hasKey || !selectedDeck || !rawCards.length) return;
    setInferring(true);
    setInferError('');
    try {
      const client = createLlmClient(credential);
      const prompt = specFromDeckPrompt(selectedDeck, rawCards);
      const response = await client.chatJson(prompt);
      const inferred = {
        topic: response.topic || selectedDeck.title || '',
        difficulty: response.difficulty || 'intermediate',
        learner_profile: response.learner_profile || '',
        generation_notes: response.generation_notes || '',
      };
      setDeckCtx(inferred);
      saveDeckContextCache(selectedDeck.id, inferred);
    } catch (err) {
      setInferError(err.message || 'Failed to infer deck context');
    } finally {
      setInferring(false);
    }
  }

  function handleStart() {
    if (!hasKey || !selectedDeck || !rawCards.length) return;
    setLaunchError('');
    try {
      const job = createFillJob({
        deck: selectedDeck,
        cards: rawCards,
        deckCtx: {
          ...deckCtx,
          title: selectedDeck.title,
          description: selectedDeck.description,
        },
        mode,
        groups: selectedGroups,
        provider: { providerId: credential.providerId, model: credential.model },
        concurrency: prefs.concurrency,
      });
      saveJob(job);
      startRun(job, credential);
      navigate(`/decks/runs/${job.id}`);
    } catch (err) {
      setLaunchError(err.message || 'Failed to start fill run');
    }
  }

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

      {/* --- Step 1: Choose the Provider --- */}
      <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-1">
        <StepHeader
          index="1"
          title={<span id="ai-complete-step-1">Choose the provider</span>}
          hint="Set up your AI key to infer context and complete your deck. Your key stays in this browser."
        />

        <AiProviderPanel
          providerId={prefs.providerId}
          onProviderChange={(providerId) => updatePrefs({ providerId })}
          onCredentialChange={handleCredentialChange}
        />

        <label className="st-field">
          <span className="st-field__label">Cards in parallel — {prefs.concurrency}</span>
          <input
            className="ai-range"
            type="range"
            min={CONCURRENCY_RANGE.min}
            max={CONCURRENCY_RANGE.max}
            value={prefs.concurrency}
            onChange={(event) => updatePrefs({ concurrency: Number(event.target.value) })}
          />
          <span className="ai-provider__hint">
            Higher is faster but more likely to hit your provider's rate limit. 3–4 is a safe start.
          </span>
        </label>
      </section>

      {/* --- Step 2: Pick a Deck --- */}
      <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-2">
        <StepHeader
          index="2"
          title={<span id="ai-complete-step-2">Pick a deck to scan</span>}
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

      {/* --- Step 3: Gap Report --- */}
      {selectedDeck ? (
        <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-3">
          <StepHeader
            index="3"
            title={<span id="ai-complete-step-3">Deck Gap Report</span>}
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

      {/* --- Step 4: Choose What to Do --- */}
      {selectedDeck && scanResult ? (
        <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-4">
          <StepHeader
            index="4"
            title={<span id="ai-complete-step-4">Choose what to do</span>}
            hint="Fill in blanks only (never touch existing values) or Audit and improve (re-evaluate and rewrite failing fields)."
          />

          <div className="st-field">
            <span className="st-field__label">Operation Mode</span>
            <div className="ai-mode-picker">
              <label className={`ai-mode-option${mode === 'fill' ? ' ai-mode-option--active' : ''}`}>
                <input
                  type="radio"
                  name="fill-mode"
                  value="fill"
                  checked={mode === 'fill'}
                  onChange={() => setMode('fill')}
                />
                <div>
                  <strong>Fill in blanks only</strong>
                  <p className="st-section__hint">
                    Never overwrites non-empty hand-written values. Only gaps (missing examples, definitions, or distractors) are filled.
                  </p>
                </div>
              </label>

              <label className={`ai-mode-option${mode === 'audit' ? ' ai-mode-option--active' : ''}`}>
                <input
                  type="radio"
                  name="fill-mode"
                  value="audit"
                  checked={mode === 'audit'}
                  onChange={() => setMode('audit')}
                />
                <div>
                  <strong>Audit and improve</strong>
                  <p className="st-section__hint">
                    Uses LLM-as-judge to evaluate existing cards and rewrite low-quality or inaccurate sentences, definitions, and options.
                  </p>
                </div>
              </label>
            </div>
          </div>

          <div className="st-field">
            <div className="ai-run__log-head">
              <span className="st-field__label">Feature groups to fill</span>
              <div className="st-actions">
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => setSelectedGroups(GROUP_OPTIONS.map((g) => g.id))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => setSelectedGroups([])}
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="ai-group-checkboxes">
              {GROUP_OPTIONS.map((group) => {
                const checked = selectedGroups.includes(group.id);
                return (
                  <label key={group.id} className={`ai-group-box${checked ? ' ai-group-box--checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleGroup(group.id)}
                    />
                    <span>{group.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="ai-estimate-box">
            <span className="st-field__label">Estimated Run</span>
            <p className="st-section__hint">
              <strong>{estimate.cards}</strong> cards will be processed · roughly{' '}
              <strong>{estimate.calls}</strong> model calls · <strong>{estimate.label}</strong>.
            </p>
          </div>
        </section>
      ) : null}

      {/* --- Step 5: Deck Context --- */}
      {selectedDeck && scanResult ? (
        <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-5">
          <StepHeader
            index="5"
            title={<span id="ai-complete-step-5">Deck context</span>}
            hint="Guiding context fed into every model prompt to keep examples and definitions cohesive."
          />

          <div className="ai-context-editor">
            <label className="st-field">
              <span className="st-field__label">Deck Topic</span>
              <input
                className="st-input"
                value={deckCtx.topic}
                onChange={(e) => setDeckCtx((c) => ({ ...c, topic: e.target.value }))}
                placeholder="e.g. Travel and airport navigation"
              />
            </label>

            <label className="st-field">
              <span className="st-field__label">Difficulty</span>
              <select
                className="st-input"
                value={deckCtx.difficulty}
                onChange={(e) => setDeckCtx((c) => ({ ...c, difficulty: e.target.value }))}
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d.charAt(0).toUpperCase() + d.slice(1)}
                  </option>
                ))}
              </select>
            </label>

            <label className="st-field">
              <span className="st-field__label">Learner Profile</span>
              <input
                className="st-input"
                value={deckCtx.learner_profile}
                onChange={(e) => setDeckCtx((c) => ({ ...c, learner_profile: e.target.value }))}
                placeholder="e.g. Intermediate Spanish speaker preparing for travel"
              />
            </label>

            <label className="st-field">
              <span className="st-field__label">Generation Notes</span>
              <input
                className="st-input"
                value={deckCtx.generation_notes}
                onChange={(e) => setDeckCtx((c) => ({ ...c, generation_notes: e.target.value }))}
                placeholder="e.g. Neutral Latin American Spanish, formal register"
              />
            </label>

            <div className="st-actions">
              <button
                type="button"
                className="button button--secondary st-button--compact"
                disabled={!hasKey || inferring || !rawCards.length}
                onClick={handleInferContext}
              >
                {inferring ? 'Inferring from deck…' : 'Infer from the deck'}
              </button>
              {!hasKey ? (
                <span className="st-section__hint">Add a provider key in step 1 first.</span>
              ) : null}
              {inferError ? <span className="st-error">{inferError}</span> : null}
            </div>
          </div>
        </section>
      ) : null}

      {/* --- Launch Section --- */}
      {selectedDeck && scanResult ? (
        <section className="panel st-section ai-launch" aria-labelledby="ai-complete-step-launch">
          <div>
            <h2 className="st-section__title" id="ai-complete-step-launch">Ready to complete</h2>
            <p className="st-section__hint">
              {estimate.cards} card(s) · roughly {estimate.calls} model calls · {estimate.label}.
              You will review all proposed diffs before anything is written to your deck.
            </p>
          </div>

          {!hasKey ? (
            <p className="st-error">Add an API key for {prefs.providerId} in step 1 to start.</p>
          ) : null}
          {selectedGroups.length === 0 ? (
            <p className="st-error">Select at least one feature group to fill.</p>
          ) : null}
          {launchError ? <p className="st-error">{launchError}</p> : null}

          <div className="st-actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!hasKey || selectedGroups.length === 0 || estimate.cards === 0}
              onClick={handleStart}
            >
              Start {mode === 'audit' ? 'audit run' : 'fill run'} ({estimate.cards} cards)
            </button>
            <Link className="button button--secondary" to="/">Back to home</Link>
          </div>
        </section>
      ) : null}

      {recentJobs.length > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-recent-fill">
          <div>
            <h2 className="st-section__title" id="ai-recent-fill">Recent fill runs</h2>
            <p className="st-section__hint">Runs stay on this device so you can resume or review them.</p>
          </div>
          <ul className="st-identity-list">
            {recentJobs.map((job) => (
              <li className="st-identity" key={job.id}>
                <div className="st-identity__info">
                  <span className="st-identity__name">{job.spec?.title || 'Untitled deck'}</span>
                  <span className="st-identity__meta">
                    {new Date(job.createdAt).toLocaleString()} · {job.cards?.length ?? 0} cards ·{' '}
                    {job.provider?.model ?? job.provider?.providerId}
                  </span>
                </div>
                <div className="st-actions">
                  <span className={`ai-status ai-status--${job.status}`}>{job.status}</span>
                  <Link className="button button--secondary st-button--compact" to={`/decks/runs/${job.id}`}>
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
