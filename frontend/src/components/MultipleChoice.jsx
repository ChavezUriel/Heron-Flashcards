import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MinigameFeedback from './MinigameFeedback';
import { useAutoAdvance } from '../useAutoAdvance';

// How long the right/wrong reveal lingers before it auto-advances. A wrong pick
// dwells longer so the learner can read the correct answer; a right pick clears
// quickly to keep momentum. A click or key press during the window stays the
// advance and surfaces a Continue button instead (see useAutoAdvance).
const REVEAL_MS = { correct: 900, wrong: 1900 };

function normalize(value) {
  return (value ?? '').toLowerCase().trim();
}

// Fisher–Yates so the correct answer lands in a random tile each round.
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Tier-B recognition game (docs/minigames.md §3.1, §4 #4): show a prompt and a few
// tiles (the real answer + sibling distractors). Because the answer is on screen a
// win could come from elimination, so it earns NO positive signal:
//   * correct pick -> onResolve({ skip: true })            — advance, never grade
//   * clean wrong pick -> onResolve({ result: 'unknown', counts: true }) — a lapse
// Never awards `known`, so it can't inflate stability or the 2-streak (§3.2).
//
// The default prompt/answer is the es→en round (prompt_es → answer_en). Phase 5's
// Reverse MC (en→es) and Word-bank cloze reuse this same tile/keyboard engine by
// overriding `promptNode` / `answer` / `label` / `answerLabel` (§4 #5, #6).
function MultipleChoice({
  card,
  distractors,
  onResolve,
  onOpenDetails,
  // The correct option string (defaults to the L2 answer for the forward round).
  answer = card.answer_l2,
  label,
  answerLabel,
  // Prompt element rendered above the tiles; defaults to the Spanish word.
  promptNode = null,
  // Whether a click/key press can stay the auto-advance. In-queue rounds want this;
  // the rapid-fire speed round passes false so eager next-answer keys never pause it.
  stoppable = true,
}) {
  const { t } = useTranslation();
  const displayLabel = label ?? t('games.multiple_choice.label');
  const displayAnswerLabel = answerLabel ?? t('games.feedback.answer');
  const correctAnswer = answer;

  // Build the option tiles once the distractors arrive. De-dupe defensively even
  // though the RPC already excludes the answer and its synonyms.
  const { options, correctIndex } = useMemo(() => {
    if (!distractors) {
      return { options: null, correctIndex: -1 };
    }
    const seen = new Set([normalize(correctAnswer)]);
    const cleaned = [];
    for (const distractor of distractors) {
      const key = normalize(distractor);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      cleaned.push(distractor);
    }
    const shuffled = shuffle([correctAnswer, ...cleaned]);
    return { options: shuffled, correctIndex: shuffled.indexOf(correctAnswer) };
  }, [correctAnswer, distractors]);

  // Highlighted tile for keyboard selection; the committed pick once chosen.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [chosenIndex, setChosenIndex] = useState(null);
  const optionRefs = useRef([]);
  const autoAdvance = useAutoAdvance({ stoppable });

  const isRevealed = chosenIndex !== null;
  const isCorrect = isRevealed && chosenIndex === correctIndex;

  // Keep the highlighted tile focused while choosing so keyboard users always have a
  // target; once revealed, MinigameFeedback owns focus (its Continue button).
  useEffect(() => {
    if (!options || isRevealed) {
      return;
    }
    optionRefs.current[selectedIndex]?.focus();
  }, [selectedIndex, isRevealed, options]);

  function commitChoice(index) {
    if (isRevealed || !options || index < 0 || index >= options.length) {
      return;
    }
    setChosenIndex(index);
    const correct = index === correctIndex;
    // Correct -> advance without grading (skip); wrong -> record the lapse through the
    // shared onResolve contract. The hook makes this idempotent across the timer and
    // the Continue button.
    autoAdvance.arm(
      correct ? REVEAL_MS.correct : REVEAL_MS.wrong,
      correct
        ? () => onResolve({ skip: true })
        : () => onResolve({ result: 'unknown', counts: true }),
    );
  }

  // MC owns its own keyboard story (PracticePage's classic arrow handlers stay
  // inert for it): number keys 1–9 pick a tile, arrows move the highlight, and
  // Enter/Space on the focused tile or Continue button commit/advance natively.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (!options || isRevealed) {
        return;
      }

      const count = options.length;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(count, 9)) {
        event.preventDefault();
        commitChoice(digit - 1);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % count);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        setSelectedIndex((current) => (current - 1 + count) % count);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [options, isRevealed, correctIndex]);

  function tileClassName(index) {
    let className = 'mcgame__tile';
    if (isRevealed) {
      if (index === correctIndex) {
        className += ' mcgame__tile--correct';
      } else if (index === chosenIndex) {
        className += ' mcgame__tile--wrong';
      } else {
        className += ' mcgame__tile--muted';
      }
    } else if (index === selectedIndex) {
      className += ' mcgame__tile--active';
    }
    return className;
  }

  return (
    <section className="panel mcgame">
      {card.section_name ? (
        <div className="mcgame__meta-row">
          <span className="flashcard__meta-pill">{card.section_name}</span>
        </div>
      ) : null}

      <div className="mcgame__body">
        <p className="flashcard__label">{displayLabel}</p>
        {promptNode ?? <h2 className="mcgame__prompt">{card.prompt_l1}</h2>}

        {options ? (
          <div className="mcgame__options" role="group" aria-label={t('games.multiple_choice.options_group')}>
            {options.map((option, index) => (
              <button
                key={option}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                className={tileClassName(index)}
                onClick={() => commitChoice(index)}
                disabled={isRevealed}
                aria-label={t('games.multiple_choice.option_aria', { index: index + 1, option })}
              >
                <span className="mcgame__tile-key" aria-hidden="true">{index + 1}</span>
                <span className="mcgame__tile-text">{option}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="mcgame__loading" role="status" aria-live="polite">{t('games.multiple_choice.loading')}</p>
        )}

        {isRevealed ? (
          <MinigameFeedback
            tone={isCorrect ? 'correct' : 'wrong'}
            phase={autoAdvance.phase}
            delay={isCorrect ? REVEAL_MS.correct : REVEAL_MS.wrong}
            stoppable={stoppable}
            onAdvance={autoAdvance.advance}
          >
            {!isCorrect ? (
              <p className="mcgame__answer">
                <span className="mcgame__answer-label">{displayAnswerLabel}</span>
                <span className="mcgame__answer-text">{correctAnswer}</span>
              </p>
            ) : null}
          </MinigameFeedback>
        ) : null}
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

export default MultipleChoice;
