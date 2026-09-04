import { useTranslation } from 'react-i18next';

function ProgressSummary({ progress }) {
  const { t } = useTranslation();
  const percentage = progress.total_cards === 0 ? 0 : Math.round(progress.completion_ratio * 100);

  return (
    <aside className="review-progress" aria-label={t('deck.progress_label')}>
      <div className="review-progress__track" aria-hidden="true">
        <div className="review-progress__fill" style={{ width: `${percentage}%` }} />
      </div>
      <div className="review-progress__meta">
        <span>{t('deck.reviewed_ratio', { reviewed: progress.reviewed_cards, total: progress.total_cards })}</span>
        <span>{t('deck.known_count', { count: progress.known_cards })}</span>
        <span>{t('deck.unknown_count', { count: progress.unknown_cards })}</span>
        {progress.is_completed ? <span className="review-progress__status">{t('deck.practice_anytime')}</span> : null}
      </div>
    </aside>
  );
}

export default ProgressSummary;
