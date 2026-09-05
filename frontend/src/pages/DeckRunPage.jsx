import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useLocale } from '../context/LocaleContext';
import { CARD_STATUS, jobProgress, usableCards, recomputeMismatchCard } from '../ai/generator';
import { deleteJob, getJob, saveJob } from '../ai/jobStore';
import { getLiveJob, isRunning, startRun, stopRun, subscribeToJob } from '../ai/runManager';
import { loadCredential } from '../ai/keyStore';
import { getProvider } from '../ai/providers';
import { saveJobAsDeck } from '../ai/saveDeck';
import { applyFillJob } from '../ai/applyFill';
import GeneratedCardList from '../components/GeneratedCardList';
import ProposedChangeList from '../components/ProposedChangeList';
import ProposeChangesModal from '../components/ProposeChangesModal';

const CREATE_STAGES = [
  ['blueprint', 'run_page.blueprint_stage'],
  ['wordsets', 'run_page.wordsets_stage'],
  ['cards', 'run_page.cards_stage'],
  ['done', 'run_page.done_stage'],
];

const FILL_STAGES = [
  ['scan', 'run_page.scan_stage'],
  ['cards', 'run_page.cards_stage'],
  ['review', 'run_page.review_stage'],
  ['applied', 'run_page.applied_stage'],
];

const STATUS_KEYS = {
  pending: 'run_page.status_pending',
  running: 'run_page.status_running',
  cancelled: 'run_page.status_cancelled',
  interrupted: 'run_page.status_interrupted',
  failed: 'run_page.status_failed',
  completed: 'run_page.status_completed',
};

function formatDuration(fromIso, toIso) {
  if (!fromIso) return '—';
  const seconds = Math.max(0, Math.round(((toIso ? new Date(toIso) : new Date()).getTime() - new Date(fromIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function DeckRunPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useLocale();
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [, bump] = useReducer((count) => count + 1, 0);
  const [job, setJob] = useState(() => getLiveJob(jobId) ?? getJob(jobId));
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' });
  const [deckTitle, setDeckTitle] = useState(job?.spec?.title ?? '');
  const [showLog, setShowLog] = useState(true);
  const [showProposeModal, setShowProposeModal] = useState(false);
  const logBoxRef = useRef(null);

  const live = isRunning(jobId);

  // The runner mutates the job object in place (so a page that mounts mid-run
  // sees everything already produced); re-render on its updates.
  useEffect(() => subscribeToJob(jobId, (next) => { setJob(next); bump(); }), [jobId]);

  // While a run is in flight, keep the elapsed clock honest.
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(bump, 1000);
    return () => clearInterval(timer);
  }, [live]);

  // Keep the log pinned to its newest line — by scrolling the log box itself,
  // never scrollIntoView, which would drag the whole page down to it on mount.
  useEffect(() => {
    const box = logBoxRef.current;
    if (box && showLog && live) box.scrollTop = box.scrollHeight;
  }, [showLog, live, job?.log?.length]);

  const progress = useMemo(() => (job ? jobProgress(job) : null), [job, job?.updatedAt]);

  if (!job) {
    return (
      <div className="ai-page">
        <p className="h-empty-state">{t('run_page.run_missing')}</p>
        <div className="st-actions">
          <Link className="button button--primary" to="/decks/new">{t('run_page.start_new_btn')}</Link>
        </div>
      </div>
    );
  }

  const isFill = job.kind === 'fill';
  const stages = isFill ? FILL_STAGES : CREATE_STAGES;
  const provider = getProvider(job.provider?.providerId);
  const finished = ['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status);

  const resumable = finished && (
    (isFill ? job.stage !== 'review' && job.stage !== 'applied' : job.stage !== 'done') ||
    job.cards.some((card) => card._status === CARD_STATUS.pending || card._status === CARD_STATUS.working)
  );

  const savable = usableCards(job).length;
  const selectedCards = (job.cards ?? []).filter((c) => c._selected !== false && c._status !== CARD_STATUS.failed);
  const appliable = selectedCards.length;

  // A personal copy of a market deck: base_deck_id is what links the two, so
  // edits here can be offered back upstream as a change proposal.
  const isMarketLinked = Boolean(job.targetDeck?.base_deck_id);

  const syncModifyingFields = [
    'definition_en', 'part_of_speech', 'main_translations_es', 'collocations',
    'synonyms_en', 'examples', 'example_es', 'example_en', 'example_sentence', 'mnemonic_en',
  ];

  const locallyModifiedCount = selectedCards.filter((card) => {
    const patch = card._patch || {};
    return syncModifyingFields.some((field) => patch[field] !== undefined);
  }).length;

  function handleResume() {
    const credential = loadCredential(job.provider?.providerId ?? 'opencode');
    if (!credential.apiKey) {
      setSaveState({ status: 'error', message: t('run_page.add_key_error', { provider: provider.label }) });
      return;
    }
    startRun(job, { ...credential, model: job.provider?.model || credential.model });
    bump();
  }

  function handleRetryFailed() {
    for (const card of job.cards ?? []) {
      if (card._status === CARD_STATUS.failed) {
        card._status = CARD_STATUS.pending;
        card._issues = [];
      }
    }
    saveJob(job);
    handleResume();
  }

  function handleToggleCard(cardId) {
    const card = (job.cards ?? []).find((c) => (c.card_id ?? c._before?.card_id ?? c.id) === cardId);
    if (card) {
      card._selected = card._selected === false ? true : false;
      saveJob(job);
      bump();
    }
  }

  function handleToggleField(cardId, fieldKey) {
    const card = (job.cards ?? []).find((c) => (c.card_id ?? c._before?.card_id ?? c.id) === cardId);
    if (card) {
      const rejected = new Set(card._rejectedFields || []);
      if (rejected.has(fieldKey)) {
        rejected.delete(fieldKey);
      } else {
        rejected.add(fieldKey);
      }
      card._rejectedFields = Array.from(rejected);
      saveJob(job);
      bump();
    }
  }

  function handleToggleMismatchFix(cardId, fixId) {
    const card = (job.cards ?? []).find((c) => (c.card_id ?? c._before?.card_id ?? c.id) === cardId);
    if (card && card._pair_mismatch?.fixes) {
      const fix = card._pair_mismatch.fixes.find((f) => f.id === fixId);
      if (fix) {
        fix._selected = fix._selected === false ? true : false;
        recomputeMismatchCard(card);
        saveJob(job);
        bump();
      }
    }
  }

  function handleToggleAll(selected) {
    for (const card of job.cards ?? []) {
      card._selected = selected;
    }
    saveJob(job);
    bump();
  }

  async function handleSave() {
    setSaveState({ status: 'working', message: '' });
    try {
      const { deck, cardCount } = await saveJobAsDeck(job, {
        title: deckTitle,
        description: job.spec.description,
        existingDeckId: job.savedDeck?.id ?? null,
      });
      job.savedDeck = { id: deck.id, slug: deck.slug, title: deck.title, cardCount };
      saveJob(job);
      setSaveState({ status: 'done', message: t('run_page.saved_success', { count: cardCount, title: deck.title }) });
      bump();
    } catch (error) {
      if (error.partial) {
        job.savedDeck = { id: error.partial.deck.id, slug: error.partial.deck.slug, title: error.partial.deck.title, cardCount: error.partial.cardCount };
        saveJob(job);
      }
      setSaveState({ status: 'error', message: error.message });
    }
  }

  async function handleApply() {
    setSaveState({ status: 'working', message: '' });
    try {
      const { appliedCount, insertedCount } = await applyFillJob(job);
      job.appliedDeck = {
        id: job.targetDeck?.id,
        title: job.targetDeck?.title || job.spec?.title,
        appliedAt: new Date().toISOString(),
        appliedCount,
        insertedCount: insertedCount || 0,
      };
      job.stage = 'applied';
      saveJob(job);
      const insertedMsg = insertedCount > 0 ? t('run_page.applied_inserted', { count: insertedCount }) : '';
      setSaveState({
        status: 'done',
        message: t('run_page.applied_success', {
          count: appliedCount,
          inserted: insertedMsg,
          title: job.targetDeck?.title || t('run_page.your_deck_fallback'),
        }),
      });
      bump();
    } catch (error) {
      if (error.partial) {
        job.appliedDeck = {
          id: job.targetDeck?.id,
          title: job.targetDeck?.title,
          appliedAt: new Date().toISOString(),
          appliedCount: error.partial.appliedCount,
        };
        saveJob(job);
      }
      setSaveState({ status: 'error', message: error.message });
    }
  }

  function handleDownload() {
    const payload = {
      slug: job.savedDeck?.slug ?? job.targetDeck?.slug ?? null,
      title: job.spec.title,
      description: job.spec.description,
      language_from: job.spec.language_from,
      language_to: job.spec.language_to,
      cards: usableCards(job),
    };
    const blob = new Blob([JSON.stringify([payload], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(job.spec.title || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.seed.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function handleDelete() {
    if (live) stopRun(jobId);
    deleteJob(jobId);
    navigate(isFill ? '/decks/complete' : '/decks/new');
  }

  const stageIndex = stages.findIndex(([id]) => id === job.stage);

  return (
    <div className="ai-page">
      <header className="ai-run__header">
        <div>
          <p className="st-kicker">
            {isFill ? t('run_page.kicker_fill', { id: job.id.slice(5, 13) }) : t('run_page.kicker_create', { id: job.id.slice(5, 13) })}
          </p>
          <h1 className="st-header__title">{job.spec.title || t('builder.untitled_deck')}</h1>
          <p className="st-section__hint">
            {provider.label} · {job.provider?.model} · {t('run_page.started_at', { time: job.startedAt ? formatDate(job.startedAt, { timeStyle: 'short' }) : '—' })} ·{' '}
            {formatDuration(job.startedAt, job.finishedAt)} elapsed
          </p>
        </div>
        <span className={`ai-status ai-status--${job.status} ai-status--large`}>
          {STATUS_KEYS[job.status] ? t(STATUS_KEYS[job.status]) : job.status}
        </span>
      </header>

      <section className="panel st-section" aria-label={t('run_page.progress_aria')}>
        <ol className="ai-stages">
          {stages.map(([id, labelKey], index) => (
            <li
              key={id}
              className={`ai-stage${index < stageIndex ? ' ai-stage--done' : ''}${index === stageIndex ? ' ai-stage--active' : ''}`}
            >
              <span className="ai-stage__dot" aria-hidden="true" />
              {t(labelKey)}
            </li>
          ))}
        </ol>

        <div className="ai-progress">
          <div className="ai-progress__bar">
            <span className="ai-progress__fill" style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} />
          </div>
          <div className="ai-progress__counts">
            <Trans
              i18nKey="run_page.cards_ratio"
              values={{ done: progress?.done ?? 0, total: progress?.total ?? 0 }}
              parent="span"
              components={{ strong: <strong /> }}
            />
            {(progress?.working ?? 0) > 0 ? <span>{t('run_page.in_flight_count', { count: progress.working })}</span> : null}
            {(progress?.flagged ?? 0) > 0 ? <span className="ai-count--warn">{t('run_page.open_issues_count', { count: progress.flagged })}</span> : null}
            {(progress?.failed ?? 0) > 0 ? <span className="ai-count--error">{t('run_page.failed_count', { count: progress.failed })}</span> : null}
            <span className="ai-count--muted">
              {t('run_page.usage_meta', {
                calls: job.usage.calls,
                tokens: formatNumber(job.usage.input_tokens + job.usage.output_tokens),
              })}
            </span>
          </div>
        </div>

        {job.error ? <p className="st-error">{job.error}</p> : null}

        <div className="st-actions">
          {live ? (
            <button type="button" className="button button--secondary" onClick={() => stopRun(jobId)}>
              {t('run_page.stop_after_card')}
            </button>
          ) : null}
          {!live && resumable ? (
            <button type="button" className="button button--primary" onClick={handleResume}>
              {t('run_page.resume_run')}
            </button>
          ) : null}
          {!live && (progress?.failed ?? 0) > 0 ? (
            <button type="button" className="button button--secondary" onClick={handleRetryFailed}>
              {t('run_page.retry_failed_cards', { count: progress.failed })}
            </button>
          ) : null}
          {!live ? (
            <button type="button" className="button button--secondary st-button--compact" onClick={handleDelete}>
              {t('run_page.delete_run')}
            </button>
          ) : null}
        </div>
      </section>

      {/* --- Action section: Save to your decks (create) OR Apply to target deck (fill) --- */}
      {!isFill && savable > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-save-title">
          <div>
            <h2 className="st-section__title" id="ai-save-title">
              {job.savedDeck ? t('run_page.saved_title') : t('run_page.save_title')}
            </h2>
            <p className="st-section__hint">
              {job.savedDeck
                ? t('run_page.saved_desc', { title: job.savedDeck.title, count: job.savedDeck.cardCount })
                : t('run_page.savable_desc', { count: savable })}
            </p>
          </div>
          {!job.savedDeck ? (
            <label className="st-field">
              <span className="st-field__label">{t('run_page.deck_name_label')}</span>
              <input
                className="st-input"
                value={deckTitle}
                onChange={(event) => setDeckTitle(event.target.value)}
                placeholder={t('run_page.deck_name_placeholder')}
              />
            </label>
          ) : null}
          <div className="st-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={handleSave}
              disabled={saveState.status === 'working' || !deckTitle.trim()}
            >
              {saveState.status === 'working'
                ? t('run_page.saving_deck')
                : job.savedDeck ? t('run_page.save_again') : t('run_page.save_deck')}
            </button>
            {job.savedDeck ? (
              <>
                <Link className="button button--secondary" to={`/decks/${job.savedDeck.id}/words`}>
                  {t('run_page.open_deck_btn')}
                </Link>
                <Link className="button button--secondary" to="/">{t('run_page.go_to_home_btn')}</Link>
              </>
            ) : null}
            <button type="button" className="button button--secondary st-button--compact" onClick={handleDownload}>
              {t('run_page.download_json_btn')}
            </button>
          </div>
          {saveState.status === 'done' ? <p className="st-success">{saveState.message}</p> : null}
          {saveState.status === 'error' ? <p className="st-error">{saveState.message}</p> : null}
        </section>
      ) : null}

      {isFill && appliable > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-apply-title">
          <div>
            <h2 className="st-section__title" id="ai-apply-title">
              {job.appliedDeck
                ? t('run_page.applied_title', { title: job.targetDeck?.title || t('run_page.your_deck_fallback') })
                : t('run_page.apply_title', { title: job.targetDeck?.title || t('run_page.your_deck_fallback') })}
            </h2>
            <p className="st-section__hint">
              {job.appliedDeck
                ? t('run_page.applied_patches_desc', { count: job.appliedDeck.appliedCount, title: job.targetDeck?.title })
                : t('run_page.appliable_patches_desc', { count: appliable, title: job.targetDeck?.title })}
            </p>
          </div>

          {isMarketLinked && locallyModifiedCount > 0 ? (
            <div className="ai-warning-box">
              <span aria-hidden="true">⚠️</span>
              <div>
                <strong>{t('run_page.market_sync_note_title')}</strong>{' '}
                {t('run_page.market_sync_note_desc', { count: locallyModifiedCount })}
              </div>
            </div>
          ) : null}

          <div className="st-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={handleApply}
              disabled={saveState.status === 'working' || appliable === 0}
            >
              {saveState.status === 'working'
                ? t('run_page.applying_changes')
                : job.appliedDeck ? t('run_page.apply_again') : t('run_page.apply_to_deck', { title: job.targetDeck?.title || t('run_page.your_deck_fallback') })}
            </button>
            {isMarketLinked && job.appliedDeck ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setShowProposeModal(true)}
              >
                {t('run_page.propose_to_market')}
              </button>
            ) : null}
            {job.targetDeck?.id ? (
              <Link className="button button--secondary" to={`/decks/${job.targetDeck.id}/words`}>
                {t('run_page.open_deck_btn')}
              </Link>
            ) : null}
            <Link className="button button--secondary" to="/">{t('run_page.go_to_home_btn')}</Link>
            <button type="button" className="button button--secondary st-button--compact" onClick={handleDownload}>
              {t('run_page.download_json_btn')}
            </button>
          </div>
          {saveState.status === 'done' ? <p className="st-success">{saveState.message}</p> : null}
          {saveState.status === 'error' ? <p className="st-error">{saveState.message}</p> : null}
        </section>
      ) : null}

      {/* --- Card review list --- */}
      {isFill ? (
        <ProposedChangeList
          job={job}
          onToggleCard={handleToggleCard}
          onToggleAll={handleToggleAll}
          onToggleField={handleToggleField}
          onToggleMismatchFix={handleToggleMismatchFix}
        />
      ) : (
        <GeneratedCardList job={job} />
      )}

      <section className="panel st-section" aria-labelledby="ai-log-title">
        <div className="ai-run__log-head">
          <h2 className="st-section__title" id="ai-log-title">{t('run_page.activity_title')}</h2>
          <button type="button" className="ai-link" onClick={() => setShowLog((current) => !current)}>
            {showLog ? t('run_page.hide_btn') : t('run_page.show_btn')}
          </button>
        </div>
        {showLog ? (
          <ol className="ai-log" ref={logBoxRef}>
            {job.log.map((entry) => (
              <li key={entry.id} className={`ai-log__row ai-log__row--${entry.level}`}>
                <time dateTime={entry.at}>{formatDate(entry.at, { timeStyle: 'medium' })}</time>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {showProposeModal && job.targetDeck?.id ? (
        <ProposeChangesModal
          deckId={job.targetDeck.id}
          onClose={() => setShowProposeModal(false)}
          onSubmitted={() => {
            // proposal sent; modal shows success view
          }}
        />
      ) : null}
    </div>
  );
}

export default DeckRunPage;
