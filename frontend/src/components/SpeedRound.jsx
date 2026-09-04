import { useEffect, useMemo, useRef, useState } from 'react';
import MultipleChoice from './MultipleChoice';

// Fisher–Yates over a copy.
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Build MC-style questions entirely from the client card pool: each question's
// distractors are sibling answers drawn from the same pool. So the speed round
// needs NO distractor RPC, and — being queue-external — it never submits a grade
// (docs/minigames.md §4 #7, §5.2).
function buildQuestions(cards, optionsPerQuestion = 4) {
  const answers = cards.map((card) => card.answer_l2 ?? card.answer_en);
  return cards.map((card) => {
    const cardAnswer = card.answer_l2 ?? card.answer_en;
    const distractors = shuffle(answers.filter((answer) => answer !== cardAnswer));
    return { card, distractors: distractors.slice(0, Math.max(0, optionsPerQuestion - 1)) };
  });
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Tier-B "Speed round" (§4 #7) run as a boundary game: a quick sequence of MC
// questions that reuses the MultipleChoice tiles (and their keyboard story). It
// NEVER grades a card — each answer only tallies a local score — and calls
// onDone() when the run finishes. The elapsed clock is display-only, so a frozen
// test clock can never trap the round; answering every question always ends it.
function SpeedRound({ cards, onDone }) {
  const questions = useMemo(() => buildQuestions(cards), [cards]);
  const [index, setIndex] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [finished, setFinished] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(Date.now());
  const doneRef = useRef(false);
  const continueRef = useRef(null);

  useEffect(() => {
    if (finished) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 250);
    return () => window.clearInterval(interval);
  }, [finished]);

  useEffect(() => {
    if (finished) {
      continueRef.current?.focus();
    }
  }, [finished]);

  function finish() {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    onDone();
  }

  // MultipleChoice reports a correct pick as { skip: true } and a clean wrong pick
  // as { result: 'unknown' }. Here both outcomes are only tallied locally — there
  // is no card to grade, so nothing reaches a session RPC.
  function handleResolve(outcome) {
    if (outcome?.skip) {
      setCorrect((current) => current + 1);
    }
    const nextIndex = index + 1;
    if (nextIndex >= questions.length) {
      setElapsed(Date.now() - startedAtRef.current);
      setFinished(true);
    } else {
      setIndex(nextIndex);
    }
  }

  if (questions.length === 0) {
    // The host only launches this with a vetted pool, so this is defensive.
    return null;
  }

  if (finished) {
    return (
      <section className="panel speedround speedround--done">
        <p className="flashcard__label">Speed round</p>
        <p className="speedround__verdict">Nice pace! ⚡</p>
        <p className="speedround__score">
          {correct} / {questions.length} correct · {formatElapsed(elapsed)}
        </p>
        <button ref={continueRef} type="button" className="button button--primary" onClick={finish}>
          Continue
        </button>
      </section>
    );
  }

  const question = questions[index];
  return (
    <div className="speedround">
      <div className="speedround__status">
        <span className="speedround__count">Question {index + 1} of {questions.length}</span>
        <span className="speedround__timer" aria-label="Elapsed time" role="timer">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <MultipleChoice
        key={question.card.card_id}
        card={question.card}
        distractors={question.distractors}
        onResolve={handleResolve}
        // Rapid-fire: never let an eager next-answer key/tap stay the advance, so the
        // color feedback just flashes and the round rolls straight to the next Q.
        stoppable={false}
      />
    </div>
  );
}

export default SpeedRound;
