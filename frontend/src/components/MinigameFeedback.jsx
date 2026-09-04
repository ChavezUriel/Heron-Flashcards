import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// Per-tone verdict mark and translation key. The color mark IS the verdict; the
// sr-only line keeps it available to assistive tech.
const TONES = {
  correct: { mark: '✓', key: 'games.feedback.correct' },
  almost: { mark: '≈', key: 'games.feedback.almost' },
  wrong: { mark: '✗', key: 'games.feedback.wrong' },
};

// Shared reveal feedback for the auto-advancing minigames (multiple choice + the
// typing games). It replaces the old "Correct!/Not quite" verdict *text* with a
// color-coded animation and drives the stoppable auto-advance flow from
// useAutoAdvance:
//   * a green (correct), amber (almost) or red (wrong) mark pops + pulses in — this
//     IS the verdict,
//   * while counting down it shows a depleting timer bar and NO Continue button, plus
//     a quiet hint that a tap or key press will stay the advance,
//   * once the learner stops the countdown it swaps in an explicit Continue button.
//
// `tone` is 'correct' | 'almost' | 'wrong'. 'almost' is the typing games' NEUTRAL
// near-miss verdict (never graded, card recycles — docs/minigames.md §4 near-miss
// aside), so it alone carries a one-line caption: color can say "not right", but not
// "this won't count against you".
//
// `children` is the game's own answer reveal (e.g. the correct answer for a miss),
// rendered between the color mark and the countdown/Continue control.
function MinigameFeedback({ tone, phase, delay, stoppable = true, onAdvance, children }) {
  const { t } = useTranslation();
  const config = TONES[tone] ?? TONES.wrong;
  const stopped = phase === 'stopped';
  const continueRef = useRef(null);

  // Once stopped, move focus to Continue so a keyboard user advances with Enter/Space
  // (mirrors the focus handling the other minigames use).
  useEffect(() => {
    if (stopped) {
      continueRef.current?.focus();
    }
  }, [stopped]);

  return (
    <div className={`mg-feedback mg-feedback--${tone}`} role="status" aria-live="polite">
      {/* The verdict is conveyed by color; this keeps it available to screen readers. */}
      <span className="sr-only">{t(config.key)}</span>

      <div className={`mg-feedback__flash mg-feedback__flash--${tone}`} aria-hidden="true">
        <span className="mg-feedback__mark">{config.mark}</span>
      </div>

      {tone === 'almost' ? (
        <p className="mg-feedback__caption">{t('games.feedback.almost_caption')}</p>
      ) : null}

      {children}

      {stopped ? (
        <button
          ref={continueRef}
          type="button"
          className="button button--primary mg-feedback__continue"
          onClick={onAdvance}
        >
          {t('common.continue')}
        </button>
      ) : (
        <div className="mg-feedback__auto">
          <div className="mg-feedback__timer">
            <span
              className={`mg-feedback__timer-fill mg-feedback__timer-fill--${tone}`}
              style={{ animationDuration: `${delay}ms` }}
            />
          </div>
          {stoppable ? (
            <p className="mg-feedback__hint">{t('games.feedback.stoppable_hint')}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default MinigameFeedback;
