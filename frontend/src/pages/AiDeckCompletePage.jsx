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
import { useTranslation, Trans } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
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
  { id: 'lexical', labelKey: 'builder.group_lexical' },
  { id: 'equivalents', labelKey: 'builder.group_equivalents' },
  { id: 'synonyms', labelKey: 'builder.group_synonyms' },
  { id: 'examples', labelKey: 'builder.group_examples' },
  { id: 'cloze-options', labelKey: 'builder.group_cloze_options' },
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
  const { t } = useTranslation();
  const { formatDate } = useLocale();
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
          setDecksError(err.message || t('builder.error_failed_load_decks'));
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
          setScanError(err.message || t('builder.error_failed_fetch_cards'));
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
      setInferError(err.message || t('builder.error_failed_infer_context'));
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
      setLaunchError(err.message || t('builder.error_failed_start_fill'));
    }
  }

  return (
    <div className="ai-page">
      <AiModeTabs />

      <header className="st-header">
        <p className="st-kicker">{t('builder.complete_kicker')}</p>
        <h1 className="st-header__title">{t('builder.complete_title')}</h1>
        <p className="st-section__hint">
          {t('builder.complete_subtitle')}
        </p>
      </header>

      {/* --- Step 1: Choose the Provider --- */}
      <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-1">
        <StepHeader
          index="1"
          title={<span id="ai-complete-step-1">{t('builder.step1_complete_title')}</span>}
          hint={t('builder.step1_complete_hint')}
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

      {/* --- Step 2: Pick a Deck --- */}
      <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-2">
        <StepHeader
          index="2"
          title={<span id="ai-complete-step-2">{t('builder.step2_complete_title')}</span>}
          hint={t('builder.step2_complete_hint')}
        />

        {loadingDecks ? (
          <div className="st-section__hint">{t('builder.loading_decks')}</div>
        ) : decksError ? (
          <div className="st-error">{decksError}</div>
        ) : decks.length === 0 ? (
          <div className="st-section__hint">
            <Trans
              i18nKey="builder.no_writable_decks_found"
              components={{
                1: <Link to="/market" />,
                2: <Link to="/decks/new" />,
              }}
            />
          </div>
        ) : (
          <label className="st-field">
            <span className="st-field__label">{t('builder.target_deck_label')}</span>
            <select
              className="st-input"
              value={selectedDeckId || ''}
              onChange={(e) => setSelectedDeckId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{t('builder.select_deck_placeholder')}</option>
              {decks.map((deck) => (
                <option key={`${deck.isMarket ? 'market-' : 'home-'}${deck.id}`} value={deck.id}>
                  {deck.title} ({t('home.cards_count', { count: deck.total_cards ?? 0 })}){deck.isMarket ? t('builder.deck_option_market_tag') : ''}
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
            title={<span id="ai-complete-step-3">{t('builder.step3_complete_title')}</span>}
            hint={t('builder.step3_complete_hint')}
          />

          {scanning ? (
            <div className="st-section__hint">{t('builder.scanning_deck_cards', { title: selectedDeck.title })}</div>
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
            title={<span id="ai-complete-step-4">{t('builder.step4_complete_title')}</span>}
            hint={t('builder.step4_complete_hint')}
          />

          <div className="st-field">
            <span className="st-field__label">{t('builder.operation_mode_label')}</span>
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
                  <strong>{t('builder.mode_fill_title')}</strong>
                  <p className="st-section__hint">
                    {t('builder.mode_fill_detail')}
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
                  <strong>{t('builder.mode_audit_title')}</strong>
                  <p className="st-section__hint">
                    {t('builder.mode_audit_detail')}
                  </p>
                </div>
              </label>
            </div>
          </div>

          <div className="st-field">
            <div className="ai-run__log-head">
              <span className="st-field__label">{t('builder.feature_groups_label')}</span>
              <div className="st-actions">
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => setSelectedGroups(GROUP_OPTIONS.map((g) => g.id))}
                >
                  {t('deck_words.select_all')}
                </button>
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => setSelectedGroups([])}
                >
                  {t('builder.clear_groups')}
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
                    <span>{t(group.labelKey)}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="ai-estimate-box">
            <span className="st-field__label">{t('builder.estimated_run_label')}</span>
            <p className="st-section__hint">
              <Trans
                i18nKey="builder.estimated_run_desc"
                values={{ cards: estimate.cards, calls: estimate.calls, time: estimate.label }}
                components={{ strong: <strong /> }}
              />
            </p>
          </div>
        </section>
      ) : null}

      {/* --- Step 5: Deck Context --- */}
      {selectedDeck && scanResult ? (
        <section className="panel st-section ai-step" aria-labelledby="ai-complete-step-5">
          <StepHeader
            index="5"
            title={<span id="ai-complete-step-5">{t('builder.step5_complete_title')}</span>}
            hint={t('builder.step5_complete_hint')}
          />

          <div className="ai-context-editor">
            <label className="st-field">
              <span className="st-field__label">{t('builder.deck_topic_label')}</span>
              <input
                className="st-input"
                value={deckCtx.topic}
                onChange={(e) => setDeckCtx((c) => ({ ...c, topic: e.target.value }))}
                placeholder={t('builder.deck_topic_placeholder')}
              />
            </label>

            <label className="st-field">
              <span className="st-field__label">{t('builder.difficulty_label')}</span>
              <select
                className="st-input"
                value={deckCtx.difficulty}
                onChange={(e) => setDeckCtx((c) => ({ ...c, difficulty: e.target.value }))}
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {t(`builder.difficulty_${d}`, { defaultValue: d.charAt(0).toUpperCase() + d.slice(1) })}
                  </option>
                ))}
              </select>
            </label>

            <label className="st-field">
              <span className="st-field__label">{t('builder.learner_profile_label')}</span>
              <input
                className="st-input"
                value={deckCtx.learner_profile}
                onChange={(e) => setDeckCtx((c) => ({ ...c, learner_profile: e.target.value }))}
                placeholder={t('builder.learner_profile_complete_placeholder')}
              />
            </label>

            <label className="st-field">
              <span className="st-field__label">{t('builder.notes_label')}</span>
              <input
                className="st-input"
                value={deckCtx.generation_notes}
                onChange={(e) => setDeckCtx((c) => ({ ...c, generation_notes: e.target.value }))}
                placeholder={t('builder.generation_notes_complete_placeholder')}
              />
            </label>

            <div className="st-actions">
              <button
                type="button"
                className="button button--secondary st-button--compact"
                disabled={!hasKey || inferring || !rawCards.length}
                onClick={handleInferContext}
              >
                {inferring ? t('builder.inferring') : t('builder.infer_from_deck')}
              </button>
              {!hasKey ? (
                <span className="st-section__hint">{t('builder.add_key_hint')}</span>
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
            <h2 className="st-section__title" id="ai-complete-step-launch">{t('builder.step6_complete_title')}</h2>
            <p className="st-section__hint">
              {t('builder.launch_summary', { cards: estimate.cards, calls: estimate.calls, time: estimate.label })}
            </p>
          </div>

          {!hasKey ? (
            <p className="st-error">{t('builder.add_key_error', { provider: prefs.providerId })}</p>
          ) : null}
          {selectedGroups.length === 0 ? (
            <p className="st-error">{t('builder.select_one_group_error')}</p>
          ) : null}
          {launchError ? <p className="st-error">{launchError}</p> : null}

          <div className="st-actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!hasKey || selectedGroups.length === 0 || estimate.cards === 0}
              onClick={handleStart}
            >
              {mode === 'audit'
                ? t('builder.start_audit_run_btn', { count: estimate.cards })
                : t('builder.start_fill_run_btn', { count: estimate.cards })}
            </button>
            <Link className="button button--secondary" to="/">{t('deck_words.back_to_home')}</Link>
          </div>
        </section>
      ) : null}

      {recentJobs.length > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-recent-fill">
          <div>
            <h2 className="st-section__title" id="ai-recent-fill">{t('builder.recent_fill_runs_title')}</h2>
            <p className="st-section__hint">{t('builder.recent_fill_runs_hint')}</p>
          </div>
          <ul className="st-identity-list">
            {recentJobs.map((job) => (
              <li className="st-identity" key={job.id}>
                <div className="st-identity__info">
                  <span className="st-identity__name">{job.spec?.title || t('builder.untitled_deck')}</span>
                  <span className="st-identity__meta">
                    {t('builder.recent_runs_meta', {
                      date: formatDate(job.createdAt, { dateStyle: 'short', timeStyle: 'short' }),
                      count: job.cards?.length ?? 0,
                    })}
                    {' · '}
                    {job.provider?.model ?? job.provider?.providerId}
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
