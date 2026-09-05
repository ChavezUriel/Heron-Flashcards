import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
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

function estimateRun(spec, concurrency, t) {
  const cards = plannedCardCount(spec);
  const calls = cards * CALLS_PER_CARD;
  const minutes = (cards * SECONDS_PER_CARD) / Math.max(1, concurrency) / 60;
  return {
    cards,
    calls,
    label: minutes < 1.5
      ? t('builder.estimate_time_minute')
      : t('builder.estimate_time_range', { min: Math.round(minutes), max: Math.round(minutes * 1.6) }),
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
  const { t } = useTranslation();
  const { formatDate } = useLocale();
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
  const estimate = useMemo(() => estimateRun(spec, prefs.concurrency, t), [spec, prefs.concurrency, t]);
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
        <p className="st-kicker">{t('builder.builder_kicker')}</p>
        <h1 className="st-header__title">{t('builder.builder_heading')}</h1>
        <p className="st-section__hint">
          {t('builder.builder_subheading')}
        </p>
      </header>

      <section className="panel st-section ai-step" aria-labelledby="ai-step-provider">
        <StepHeader
          index="1"
          title={<span id="ai-step-provider">{t('builder.step1_title')}</span>}
          hint={t('builder.step1_hint')}
        />
        <AiProviderPanel
          providerId={prefs.providerId}
          onProviderChange={(providerId) => updatePrefs({ providerId })}
          onCredentialChange={handleCredentialChange}
        />
        <label className="st-field">
          <span className="st-field__label">{t('builder.concurrency_cards_label', { count: prefs.concurrency })}</span>
          <input
            className="ai-range"
            type="range"
            min={CONCURRENCY_RANGE.min}
            max={CONCURRENCY_RANGE.max}
            value={prefs.concurrency}
            onChange={(event) => updatePrefs({ concurrency: Number(event.target.value) })}
          />
          <span className="ai-provider__hint">
            {t('builder.concurrency_hint')}
          </span>
        </label>
      </section>

      <section className="panel st-section ai-step" aria-labelledby="ai-step-idea">
        <StepHeader
          index="2"
          title={<span id="ai-step-idea">{t('builder.step2_title')}</span>}
          hint={t('builder.step2_hint')}
        />
        <label className="st-field">
          <span className="st-field__label">{t('builder.what_teach_label')}</span>
          <textarea
            className="st-input ai-textarea"
            rows={3}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder={t('builder.idea_placeholder')}
          />
        </label>
        <div className="st-actions">
          <button
            type="button"
            className="button button--primary st-button--compact"
            disabled={!hasKey || !idea.trim() || assistant.status === 'working'}
            onClick={() => runAssistant(() => specDraftPrompt(idea, { targetCardCount: spec.target_card_count }))}
          >
            {assistant.status === 'working' ? t('builder.drafting_spec') : t('builder.draft_spec_btn')}
          </button>
          {!hasKey ? <span className="st-section__hint">{t('builder.add_key_hint')}</span> : null}
          {assistant.status === 'error' ? <span className="st-error">{assistant.error}</span> : null}
        </div>
      </section>

      <section className="panel st-section ai-step" aria-labelledby="ai-step-spec">
        <StepHeader
          index="3"
          title={<span id="ai-step-spec">{t('builder.step3_title')}</span>}
          hint={t('builder.step3_hint')}
        />

        <DeckSpecEditor spec={spec} onChange={setSpec} />

        <div className="ai-refine">
          <label className="st-field">
            <span className="st-field__label">{t('builder.ask_assistant_label')}</span>
            <div className="ai-refine__row">
              <input
                className="st-input"
                value={refineInstruction}
                onChange={(event) => setRefineInstruction(event.target.value)}
                placeholder={t('builder.refine_placeholder')}
              />
              <button
                type="button"
                className="button button--secondary st-button--compact"
                disabled={!hasKey || assistant.status === 'working'}
                onClick={() => runAssistant(() => specRefinePrompt(spec, refineInstruction), { keepSpec: true })}
              >
                {assistant.status === 'working' ? t('builder.refining_spec') : t('builder.refine_btn')}
              </button>
            </div>
          </label>
          {assistant.notes.length > 0 ? (
            <div className="ai-notes">
              <p className="st-field__label">{t('builder.what_changed_label')}</p>
              <ul>
                {assistant.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
              {previousSpec ? (
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => { setSpec(previousSpec); setPreviousSpec(null); setAssistant({ status: 'idle', notes: [], error: '' }); }}
                >
                  {t('builder.undo_refine')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel st-section ai-launch" aria-labelledby="ai-step-launch">
        <div>
          <h2 className="st-section__title" id="ai-step-launch">{t('builder.step4_title')}</h2>
          <p className="st-section__hint">
            {t('builder.launch_summary_create', {
              cards: estimate.cards,
              calls: estimate.calls,
              time: estimate.label,
            })}
          </p>
        </div>
        {problems.length > 0 ? (
          <ul className="ai-problems">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        ) : null}
        {!hasKey ? <p className="st-error">{t('builder.add_key_error', { provider: prefs.providerId })}</p> : null}
        {launchError ? <p className="st-error">{launchError}</p> : null}
        <div className="st-actions">
          <button
            type="button"
            className="button button--primary"
            disabled={problems.length > 0 || !hasKey}
            onClick={handleStart}
          >
            {t('builder.generate_cards_btn', { count: estimate.cards })}
          </button>
          <Link className="button button--secondary" to="/">{t('practice.back_to_home')}</Link>
        </div>
      </section>

      {recentJobs.length > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-recent">
          <div>
            <h2 className="st-section__title" id="ai-recent">{t('builder.recent_runs_title')}</h2>
            <p className="st-section__hint">{t('builder.recent_fill_runs_hint')}</p>
          </div>
          <ul className="st-identity-list">
            {recentJobs.map((job) => (
              <li className="st-identity" key={job.id}>
                <div className="st-identity__info">
                  <span className="st-identity__name">{job.spec.title || t('builder.untitled_deck')}</span>
                  <span className="st-identity__meta">
                    {t('builder.recent_runs_meta', {
                      date: formatDate(job.createdAt, { dateStyle: 'short', timeStyle: 'short' }),
                      count: job.cards?.length ?? 0,
                    })}
                    {job.provider?.model || job.provider?.providerId ? ` · ${job.provider?.model ?? job.provider?.providerId}` : ''}
                  </span>
                </div>
                <div className="st-actions">
                  <span className={`ai-status ai-status--${job.status}`}>{job.status}</span>
                  <Link className="button button--secondary st-button--compact" to={`/decks/runs/${job.id}`}>
                    {t('builder.open_run_btn')}
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
