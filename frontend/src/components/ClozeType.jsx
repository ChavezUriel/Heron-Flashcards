import { useEffect, useMemo, useRef, useState } from 'react';
import { classifyGuess, locateAnswerInExample, normalizeAnswer } from '../minigameText';
import MinigameFeedback from './MinigameFeedback';
import { AnswerShape, HintButton, TranslationHint, useHints } from './MinigameHints';
import { useAutoAdvance } from '../useAutoAdvance';

// How long the feedback lingers before it auto-advances. A miss or near miss dwells
// longer so the learner can read the correct answer; a hit clears quickly to keep
// momentum. A click or key press during the window stays the advance and surfaces a
// Continue button instead (see useAutoAdvance).
const FEEDBACK_MS = { known: 1100, almost: 2000, unknown: 2000 };

// Tier-A production game (docs/minigames.md §3.1, §4 #3): blank the answer out of
// the English example sentence and have the learner type the missing word. The
// sentence is a *cue*, but the word itself is produced from memory — as strong as a
// swipe — so it counts fully: correct -> `known`, wrong -> `unknown`, through the
// identical onResolve({ result, counts }) contract. A NEAR MISS (a typo / dropped
// function word, classifyGuess 'almost') is NEUTRAL: amber feedback shows the exact
// answer and the card advances via the skip RPC — never graded, recycled for a clean
// rep (§4 near-miss aside). Selected only when the answer can be located as a whole
// word in one of the card's example sentences (see selectModality); MinigameHost
// picks WHICH sentence this presentation blanks (`clozeExample`, one of the
// clozeCandidates — migration 0019 gives cards several) and passes it down with
// its span. Falls back to the card's primary example when the prop is absent.
function ClozeType({ card, clozeExample, onResolve, onOpenDetails }) {
  const [guess, setGuess] = useState('');
  // null while typing; 'known' | 'almost' | 'unknown' once submitted (drives the reveal).
  const [outcome, setOutcome] = useState(null);
  // First empty submit arms a "Sure?" skip confirmation; the second one skips.
  const [confirmSkip, setConfirmSkip] = useState(false);
  const inputRef = useRef(null);
  const autoAdvance = useAutoAdvance();
  // Two-step hint ladder (shape, then Spanish); revealing refocuses the input.
  const hints = useHints(inputRef);

  // The raw span of the answer inside the chosen example, so the sentence can be
  // split into "before ___ after". The gate guarantees a match; guard defensively.
  const example = clozeExample?.l2 ?? clozeExample?.en ?? card.example_l2 ?? card.example_en ?? '';
  const answer = card.answer_l2 ?? card.answer_en;
  const prompt = card.prompt_l1 ?? card.prompt_es;
  const span = useMemo(
    () => clozeExample?.span ?? locateAnswerInExample(example, answer),
    [clozeExample, example, answer],
  );
  const before = span ? example.slice(0, span.start) : '';
  const after = span ? example.slice(span.end) : '';

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
    <section className="panel typegame clozegame">
      {card.section_name ? (
        <div className="typegame__meta-row">
          <span className="flashcard__meta-pill">{card.section_name}</span>
        </div>
      ) : null}

      <div className="typegame__body">
        <p className="flashcard__label">Fill in the missing word</p>
        <p className="clozegame__sentence">
          {before}
          {isRevealed ? (
            <span className={`clozegame__slot clozegame__slot--${outcome}`}>{answer}</span>
          ) : hints.level >= 1 ? (
            // First hint: the anonymous blank becomes the answer's shape — an
            // underscore per character, word gaps visible (AnswerShape labels itself).
            <span className="clozegame__slot clozegame__slot--blank">
              <AnswerShape answer={answer} />
            </span>
          ) : (
            <span className="clozegame__slot clozegame__slot--blank clozegame__slot--line" aria-label="missing word" />
          )}
          {after}
        </p>

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
            placeholder="Type the missing word"
            aria-label="Type the word that fills the gap"
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
                  <span className="typegame__answer-label">You typed</span>
                  <span className="typegame__typed-text">{guess.trim()}</span>
                </p>
              ) : null}
              <p className="typegame__answer">
                <span className="typegame__answer-label">Answer</span>
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
                {guess.trim() ? 'Check' : confirmSkip ? 'Sure?' : 'Skip'}
              </button>
            </>
          )}
        </form>
      </div>

      {isRevealed && onOpenDetails ? (
        <button
          aria-label="Show flashcard metadata"
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

export default ClozeType;
