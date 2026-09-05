import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLiveJob, runningJobIds, subscribeToRuns } from '../ai/runManager';
import { jobProgress } from '../ai/generator';

// A deck run keeps going while the learner browses the rest of the app, so the
// header carries a live link back to it — otherwise the only way back is the
// browser's history.
function AiRunIndicator() {
  const { t } = useTranslation();
  const [runIds, setRunIds] = useState(() => runningJobIds());

  useEffect(() => subscribeToRuns(() => setRunIds(runningJobIds())), []);

  if (runIds.length === 0) return null;

  const jobId = runIds[0];
  const job = getLiveJob(jobId);
  const progress = job ? jobProgress(job) : null;

  return (
    <Link className="ai-run-pill" to={`/decks/runs/${jobId}`}>
      <span className="ai-run-pill__dot" aria-hidden="true" />
      {progress
        ? t('builder.indicator_progress', { done: progress.done, total: progress.total })
        : t('builder.indicator_generating')}
      {runIds.length > 1 ? ` +${runIds.length - 1}` : ''}
    </Link>
  );
}

export default AiRunIndicator;
