import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AiProviderPanel from '../components/AiProviderPanel';
import AiModeTabs from '../components/AiModeTabs';
import DeckSpecEditor from '../components/DeckSpecEditor';
import { DEFAULT_SPEC, normalizeSpec, plannedCardCount, validateSpec } from '../ai/deckSpec';
import { specDraftPrompt, specRefinePrompt } from '../ai/specPrompts';
import { createLlmClient } from '../ai/llmClient';
import { loadBuilderPrefs, saveBuilderPrefs } from '../ai/keyStore';
import { createJob } from '../ai/generator';
import { listJobs, saveJob, reconcileInterruptedJobs } from '../ai/jobStore';
import { startRun } from '../ai/runManager';

// Measured against the real pipeline (3 cards, 46 calls): a card costs ~15
// prompts and ~45s of wall clock, so a run's cost scales with the card count
// and its duration with the parallelism. Shown as a range — models differ.
const CALLS_PER_CARD = 15;
const SECONDS_PER_CARD = 45;
const CONCURRENCY_RANGE = { min: 1, max: 8 };

function estimateRun(spec, concurrency) {
  const cards = plannedCardCount(spec);
  const calls = cards * CALLS_PER_CARD;
  const minutes = (cards * SECONDS_PER_CARD) / Math.max(1, concurrency) / 60;
  return {
    cards,
    calls,
    label: minutes < 1.5
      ? 'about a minute'
      : `about ${Math.round(minutes)}–${Math.round(minutes * 1.6)} minutes`,
  };
}

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

function AiDeckBuilderPage() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState(() => loadBuilderPrefs());
  const [credential, setCredential] = useState(null);
  const [spec, setSpec] = useState(() => normalizeSpec(DEFAULT_SPEC));
  const [idea, setIdea] = useState('');
  const [assistant, setAssistant] = useState({ status: 'idle', notes: [], error: '' });
  const [refineInstruction, setRefineInstruction] = useState('');
  const [previousSpec, setPreviousSpec] = useState(null);
  const [launchError, setLaunchError] = useState('');
  const [recentJobs, setRecentJobs] = useState([]);

  useEffect(() => {
    reconcileInterruptedJobs();
    setRecentJobs(listJobs());
  }, []);

  const problems = useMemo(() => validateSpec(spec), [spec]);
  const estimate = useMemo(() => estimateRun(spec, prefs.concurrency), [spec, prefs.concurrency]);
  const hasKey = Boolean(credential?.apiKey);

  const handleCredentialChange = useCallback((next) => setCredential(next), []);

  function updatePrefs(patch) {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      saveBuilderPrefs(next);
      return next;
    });
  }

  async function runAssistant(buildPrompt, { keepSpec = false } = {}) {
    if (!hasKey) return;
    setAssistant({ status: 'working', notes: [], error: '' });
    try {
      const client = createLlmClient(credential);
      const response = await client.chatJson(buildPrompt());
      const draft = response?.spec && typeof response.spec === 'object' ? response.spec : response;
      if (keepSpec) setPreviousSpec(spec);
      setSpec(normalizeSpec({ ...(keepSpec ? spec : {}), ...draft }));
      setAssistant({
        status: 'done',
        notes: Array.isArray(response?.notes) ? response.notes.filter((note) => typeof note === 'string') : [],
        error: '',
      });
    } catch (error) {
      setAssistant({ status: 'error', notes: [], error: error.message });
    }
  }

  function handleStart() {
    setLaunchError('');
    try {
      // The form edits the spec raw (so typing a space works); this is where it
      // is trimmed and clamped, exactly once, on its way into the run.
      const job = createJob({
        spec: normalizeSpec(spec),
        provider: { providerId: credential.providerId, model: credential.model },
        concurrency: prefs.concurrency,
      });
      saveJob(job);
      startRun(job, credential);
      navigate(`/decks/runs/${job.id}`);
    } catch (error) {
      setLaunchError(error.message);
    }
  }

  return (
    <div className="ai-page">
      <AiModeTabs />
      <header className="st-header">
        <p className="st-kicker">AI DECK BUILDER</p>
        <h1 className="st-header__title">Build a deck with your own AI key</h1>
        <p className="st-section__hint">
          Describe what you want to learn, review the plan, and let your provider write the cards —
          definitions, example sentences, synonyms and word-bank options included. Your key stays in
          this browser.
        </p>
      </header>

      <section className="panel st-section ai-step" aria-labelledby="ai-step-idea">
        <StepHeader
          index="1"
          title={<span id="ai-step-idea">Describe the deck</span>}
          hint="One or two sentences is enough. The assistant turns it into a full specification you can edit."
        />
        <label className="st-field">
          <span className="st-field__label">What should this deck teach?</span>
          <textarea
            className="st-input ai-textarea"
            rows={3}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder="English I need for a job interview in tech — small talk, describing my experience, asking about the team."
          />
        </label>
        <div className="st-actions">
          <button
            type="button"
            className="button button--primary st-button--compact"
            disabled={!hasKey || !idea.trim() || assistant.status === 'working'}
            onClick={() => runAssistant(() => specDraftPrompt(idea, { targetCardCount: spec.target_card_count }))}
          >
            {assistant.status === 'working' ? 'Drafting…' : 'Draft the specification'}
          </button>
          {!hasKey ? <span className="st-section__hint">Add a provider key in step 3 first.</span> : null}
          {assistant.status === 'error' ? <span className="st-error">{assistant.error}</span> : null}
        </div>
      </section>

      <section className="panel st-section ai-step" aria-labelledby="ai-step-spec">
        <StepHeader
          index="2"
          title={<span id="ai-step-spec">Review the specification</span>}
          hint="Every field below is fed to the model as deck context. Edit it as a form or as YAML you can save and re-run."
        />

        <DeckSpecEditor spec={spec} onChange={setSpec} />

        <div className="ai-refine">
          <label className="st-field">
            <span className="st-field__label">Ask the assistant to improve it</span>
            <div className="ai-refine__row">
              <input
                className="st-input"
                value={refineInstruction}
                onChange={(event) => setRefineInstruction(event.target.value)}
                placeholder="Make it more specific to phone calls, and add a section on polite refusals."
              />
              <button
                type="button"
                className="button button--secondary st-button--compact"
                disabled={!hasKey || assistant.status === 'working'}
                onClick={() => runAssistant(() => specRefinePrompt(spec, refineInstruction), { keepSpec: true })}
              >
                Improve
              </button>
            </div>
          </label>
          {assistant.notes.length > 0 ? (
            <div className="ai-notes">
              <p className="st-field__label">What changed</p>
              <ul>
                {assistant.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
              {previousSpec ? (
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => { setSpec(previousSpec); setPreviousSpec(null); setAssistant({ status: 'idle', notes: [], error: '' }); }}
                >
                  Undo these changes
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel st-section ai-step" aria-labelledby="ai-step-provider">
        <StepHeader
          index="3"
          title={<span id="ai-step-provider">Choose the provider</span>}
          hint="You pay your provider directly. Nothing is billed by this app, and no key is sent to its database."
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

      <section className="panel st-section ai-launch" aria-labelledby="ai-step-launch">
        <div>
          <h2 className="st-section__title" id="ai-step-launch">Start the run</h2>
          <p className="st-section__hint">
            {estimate.cards} cards · roughly {estimate.calls} model calls · {estimate.label}. You can
            watch it card by card, and stop or resume at any point.
          </p>
        </div>
        {problems.length > 0 ? (
          <ul className="ai-problems">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        ) : null}
        {!hasKey ? <p className="st-error">Add an API key for {prefs.providerId} to start.</p> : null}
        {launchError ? <p className="st-error">{launchError}</p> : null}
        <div className="st-actions">
          <button
            type="button"
            className="button button--primary"
            disabled={problems.length > 0 || !hasKey}
            onClick={handleStart}
          >
            Generate {estimate.cards} cards
          </button>
          <Link className="button button--secondary" to="/">Back to home</Link>
        </div>
      </section>

      {recentJobs.length > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-recent">
          <div>
            <h2 className="st-section__title" id="ai-recent">Recent runs</h2>
            <p className="st-section__hint">Runs stay on this device so you can resume or save them later.</p>
          </div>
          <ul className="st-identity-list">
            {recentJobs.map((job) => (
              <li className="st-identity" key={job.id}>
                <div className="st-identity__info">
                  <span className="st-identity__name">{job.spec.title || 'Untitled deck'}</span>
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

export default AiDeckBuilderPage;
