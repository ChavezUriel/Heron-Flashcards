import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { classifyGuess, normalizeAnswer } from '../minigameText';
import MinigameFeedback from './MinigameFeedback';
import { AnswerShape, HintButton, TranslationHint, useHints } from './MinigameHints';
import { useAutoAdvance } from '../useAutoAdvance';

// How long the feedback lingers before it auto-advances. A miss or near miss dwells
// longer so the learner can read the correct answer; a hit clears quickly to keep
// momentum. A click or key press during the window stays the advance and surfaces a
// Continue button instead (see useAutoAdvance).
const FEEDBACK_MS = { known: 1100, almost: 2000, unknown: 2000 };

// Tier-A production game (docs/minigames.md §3.1, §4 #2): show the English
// definition (and part of speech) with nothing to recognize, and the learner types
// the English answer. That demands the same free recall as the classic swipe, so a
// correct answer counts as `known` and a wrong one as `unknown` — both flow through
// the identical onResolve({ result, counts }) contract, reaching FSRS exactly like a
// swipe. A NEAR MISS (a typo / dropped function word, classifyGuess 'almost') is
// NEUTRAL: amber feedback shows the exact answer and the card advances via the skip
// RPC — never graded, recycled for a clean rep (§4 near-miss aside). Selected only
// when the card carries a definition (see selectModality).
function RecallFromDefinition({ card, onResolve, onOpenDetails }) {
  const { t } = useTranslation();
  const [guess, setGuess] = useState('');
  // null while typing; 'known' | 'almost' | 'unknown' once submitted (drives the reveal).
  const [outcome, setOutcome] = useState(null);
  // First empty submit arms a "Sure?" skip confirmation; the second one skips.
  const [confirmSkip, setConfirmSkip] = useState(false);
  const inputRef = useRef(null);
  const autoAdvance = useAutoAdvance();
  // Two-step hint ladder (shape, then prompt); revealing refocuses the input.
  const hints = useHints(inputRef);

  const definition = card.l2_definition ?? card.definition_en;
  const answer = card.answer_l2 ?? card.answer_en;
  const prompt = card.prompt_l1 ?? card.prompt_es;

  // Focus the input while typing; once submitted, MinigameFeedback owns focus (its
  // Continue button, shown if the learner stays the auto-advance).
  useEffect(() => {
    if (outcome === null) {
      inputRef.current?.focus();
    }
  }, [outcome]);

  function handleSubmit(event) {
    event.preventDefault();

    if (outcome !== null) {
      return;
    }

    // Empty input → offer to skip the card, but require a second submit to confirm
    // (double-Enter) so a stray Enter never discards the rep. A skipped guess is a
    // genuine "couldn't recall it", so it grades `unknown` and reveals the answer,
    // exactly like a wrong guess.
    if (!normalizeAnswer(guess)) {
      if (!confirmSkip) {
        setConfirmSkip(true);
        return;
      }
      setConfirmSkip(false);
      setOutcome('unknown');
      autoAdvance.arm(FEEDBACK_MS.unknown, () => onResolve({ result: 'unknown', counts: true }));
      return;
    }

    const verdict = classifyGuess(guess, card);

    // Near miss → neutral: advance WITHOUT grading via the skip path (card recycles
    // to the back of the queue, FSRS untouched). `result: 'almost'` rides along so
    // telemetry can tell a near miss from a recognition-win skip.
    if (verdict === 'almost') {
      setOutcome('almost');
      autoAdvance.arm(FEEDBACK_MS.almost, () => onResolve({ result: 'almost', counts: false, skip: true }));
      return;
    }

    const result = verdict === 'correct' ? 'known' : 'unknown';
    setOutcome(result);
    // The hook keeps this idempotent across the timer and the Continue button.
    autoAdvance.arm(FEEDBACK_MS[result], () => onResolve({ result, counts: true }));
  }

  const isRevealed = outcome !== null;

  return (
    <section className="panel typegame recallgame">
      <div className="typegame__meta-row recallgame__meta-row">
        {card.part_of_speech ? <span className="flashcard__meta-pill">{card.part_of_speech}</span> : null}
        {card.section_name ? <span className="flashcard__meta-pill">{card.section_name}</span> : null}
      </div>

      <div className="typegame__body">
        <p className="flashcard__label">{t('games.recall_from_definition.label')}</p>
        <p className="recallgame__definition">{definition}</p>

        {/* Hint reveals under the definition: first the answer's shape (an underscore
            per character, word gaps visible), then the prompt side of the card. */}
        {!isRevealed && hints.level >= 1 ? (
          <p className="typegame__hint-line">
            <AnswerShape answer={answer} />
          </p>
        ) : null}
        {!isRevealed && hints.level >= 2 ? <TranslationHint text={prompt} /> : null}

        <form className="typegame__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={`st-input typegame__input${isRevealed ? ` typegame__input--${outcome}` : ''}`}
            type="text"
            value={guess}
            onChange={(event) => {
              setGuess(event.target.value);
              // Typing again abandons a pending skip prompt.
              if (confirmSkip) {
                setConfirmSkip(false);
              }
            }}
            placeholder={t('games.recall_from_definition.placeholder')}
            aria-label={t('games.recall_from_definition.input_label')}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={isRevealed}
          />

          {isRevealed ? (
            <MinigameFeedback
              tone={outcome === 'known' ? 'correct' : outcome === 'almost' ? 'almost' : 'wrong'}
              phase={autoAdvance.phase}
              delay={FEEDBACK_MS[outcome]}
              onAdvance={autoAdvance.advance}
            >
              {/* On a near miss, echo the guess so the learner can spot the typo. */}
              {outcome === 'almost' ? (
                <p className="typegame__answer">
                  <span className="typegame__answer-label">{t('games.feedback.you_typed')}</span>
                  <span className="typegame__typed-text">{guess.trim()}</span>
                </p>
              ) : null}
              <p className="typegame__answer">
                <span className="typegame__answer-label">{t('games.feedback.answer')}</span>
                <span className="typegame__answer-text">{answer}</span>
              </p>
            </MinigameFeedback>
          ) : (
            <>
              {/* Directly after the input in DOM order — exactly one Tab away. */}
              <HintButton level={hints.level} onReveal={hints.reveal} />
              <button
                type="submit"
                className={
                  guess.trim()
                    ? 'button button--primary typegame__action'
                    : `button typegame__action typegame__action--skip${confirmSkip ? ' typegame__action--confirm' : ''}`
                }
              >
                {guess.trim() ? t('common.check') : confirmSkip ? t('common.sure') : t('common.skip')}
              </button>
            </>
          )}
        </form>
      </div>

      {isRevealed && onOpenDetails ? (
        <button
          aria-label={t('deck.show_metadata')}
          className="info-button"
          type="button"
          onClick={onOpenDetails}
        >
          i
        </button>
      ) : null}
    </section>
  );
}

export default RecallFromDefinition;
