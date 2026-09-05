import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchDeckProgress, fetchReviewCard, submitReview, undoReview, updateCard } from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import Flashcard from '../components/Flashcard';
import ProgressSummary from '../components/ProgressSummary';

function UndoIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M9 5 4 10l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 10h9a6 6 0 0 1 6 6v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReviewPage() {
  const { t } = useTranslation();
  const { deckId } = useParams();
  const [card, setCard] = useState(null);
  const [progress, setProgress] = useState(null);
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [isSavingCard, setIsSavingCard] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const flashcardActionsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function loadScreen() {
      try {
        setStatus('loading');
        const [nextCard, nextProgress] = await Promise.all([
          fetchReviewCard(deckId),
          fetchDeckProgress(deckId),
        ]);
        if (!cancelled) {
          setCard(nextCard);
          setProgress(nextProgress);
          setIsAnswerVisible(false);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadScreen();

    return () => {
      cancelled = true;
    };
  }, [deckId]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (status !== 'ready' || !card || isSubmitting || isDetailsVisible) {
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIsAnswerVisible((current) => !current);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIsAnswerVisible(true);
        return;
      }

      if (!isAnswerVisible) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        flashcardActionsRef.current?.triggerReview('left');
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        flashcardActionsRef.current?.triggerReview('right');
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [card, isAnswerVisible, isDetailsVisible, isSubmitting, status]);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [card?.card_id, isAnswerVisible]);

  async function handleReview(result) {
    if (!card) {
      return;
    }

    try {
      setIsSubmitting(true);
      await submitReview(card.card_id, result);
      const [nextCard, nextProgress] = await Promise.all([
        fetchReviewCard(deckId),
        fetchDeckProgress(deckId),
      ]);
      setCard(nextCard);
      setProgress(nextProgress);
      setIsAnswerVisible(false);
      setCanUndo(true);
    } catch (submitError) {
      setError(submitError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUndo() {
    if (!canUndo || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      const restoredCard = await undoReview();
      const nextProgress = await fetchDeckProgress(deckId);
      setCard(restoredCard);
      setProgress(nextProgress);
      // Show the answer so the user can immediately re-judge the card.
      setIsAnswerVisible(true);
      setCanUndo(false);
    } catch (undoError) {
      setError(undoError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveCard(values) {
    if (!card) {
      return null;
    }

    setIsSavingCard(true);
    setError('');

    try {
      const updatedCard = await updateCard(card.card_id, values);
      setCard((current) => (current?.card_id === updatedCard.card_id ? { ...current, ...updatedCard } : current));
      return updatedCard;
    } catch (saveError) {
      setError(saveError.message);
      return null;
    } finally {
      setIsSavingCard(false);
    }
  }

  if (status === 'loading') {
    return <section className="panel empty-state">{t('review.preparing_card')}</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>{t('review.loading_problem')}</p>
        <p>{error}</p>
        <Link className="button button--secondary" to="/">
          {t('review.back_to_home')}
        </Link>
      </section>
    );
  }

  return (
    <section className="review-screen">
      {progress ? <ProgressSummary progress={progress} /> : null}

      <div className="review-stage">
        <div className="review-topbar">
          <Link className="back-link" to="/">
            {t('review.back_to_home')}
          </Link>

          {canUndo ? (
            <button
              type="button"
              className="back-link review-undo-button"
              onClick={handleUndo}
              disabled={isSubmitting}
            >
              <UndoIcon />
              <span>{t('review.undo_last_card')}</span>
            </button>
          ) : null}
        </div>

        <Flashcard
          card={card}
          isAnswerVisible={isAnswerVisible}
          isSubmitting={isSubmitting}
          actionsRef={flashcardActionsRef}
          onReveal={() => setIsAnswerVisible((current) => !current)}
          onToggleReveal={() => setIsAnswerVisible((current) => !current)}
          onOpenDetails={() => setIsDetailsVisible(true)}
          onReviewKnown={() => handleReview('known')}
          onReviewUnknown={() => handleReview('unknown')}
        />

        <div className="review-actions">
          <p className="review-shortcuts">{t('review.shortcuts_prompt')}</p>
          <div className="action-row">
            <button
              className="button button--danger"
              type="button"
              onClick={() => flashcardActionsRef.current?.triggerReview('left')}
              disabled={!isAnswerVisible || isSubmitting}
            >
              {t('review.i_need_review')}
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => flashcardActionsRef.current?.triggerReview('right')}
              disabled={!isAnswerVisible || isSubmitting}
            >
              {t('review.i_knew_it')}
            </button>
          </div>
        </div>

        {card && isDetailsVisible ? (
          <CardDetailsModal
            card={card}
            isPending={isSavingCard}
            onClose={() => setIsDetailsVisible(false)}
            onSave={handleSaveCard}
          />
        ) : null}
      </div>

    </section>
  );
}

export default ReviewPage;
