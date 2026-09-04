import { useEffect, useMemo, useRef, useState } from 'react';
import { getLanguage } from '../languages';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// Wrong guesses allowed before the word is revealed.
const MAX_MISSES = 6;

// Tier-C cool-down game (docs/minigames.md §4 #10): a SINGLE-card game of hangman run
// as a queue-external interstitial — guess the answer letter by letter. It is
// pure arcade fun, so it NEVER grades: it only
// ever calls onDone() to dismiss and never touches a session RPC (§5.2, §8.2).
function Hangman({ card, onDone }) {
  const answer = (card.answer_l2 ?? '').trim();
  const prompt = card.prompt_l1;
  const sourceLang = getLanguage(card.language_from ?? 'es');
  const sourceLabel = sourceLang?.name ?? 'Prompt';
  const answerLetters = useMemo(() => {
    const set = new Set();
    for (const ch of answer.toUpperCase()) {
      if (/\p{L}/u.test(ch)) {
        set.add(ch);
      }
    }
    return set;
  }, [answer]);

  const [guessed, setGuessed] = useState(() => new Set());
  const doneRef = useRef(false);
  const continueRef = useRef(null);

  const misses = useMemo(
    () => [...guessed].filter((letter) => !answerLetters.has(letter)).length,
    [guessed, answerLetters],
  );
  const isWin = answerLetters.size > 0 && [...answerLetters].every((letter) => guessed.has(letter));
  const isLoss = misses >= MAX_MISSES;
  const isOver = isWin || isLoss;

  useEffect(() => {
    if (isOver) {
      continueRef.current?.focus();
    }
  }, [isOver]);

  function guessLetter(letter) {
    const upper = letter.toUpperCase();
    if (isOver || guessed.has(upper) || !/^[A-Z]$/.test(upper)) {
      return;
    }
    setGuessed((current) => {
      const next = new Set(current);
      next.add(upper);
      return next;
    });
  }

  function finish() {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    onDone();
  }

  // Physical letter keys guess (§8.4); the on-screen keyboard buttons remain the
  // pointer/Tab path. The host owns Escape-to-dismiss.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.key === 'Escape') {
        return;
      }
      if (/^[a-zA-Z]$/.test(event.key)) {
        guessLetter(event.key);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // guessLetter reads guessed/isOver via state each call through the setter; bind
    // to the values that gate it so the closure stays fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOver, guessed]);

  const remaining = MAX_MISSES - misses;

  return (
    <section className="panel hangmangame">
      <p className="flashcard__label">Hangman</p>
      <p className="hangmangame__prompt">
        <span className="hangmangame__prompt-label">{sourceLabel}</span>
        {prompt}
      </p>

      <div className="hangmangame__word" role="status" aria-live="polite" aria-label={isOver ? answer : 'Word to guess'}>
        {[...answer].map((ch, index) => {
          if (!/\p{L}/u.test(ch)) {
            return <span key={index} className="hangmangame__space">{ch === ' ' ? ' ' : ch}</span>;
          }
          const revealed = guessed.has(ch.toUpperCase());
          const missed = isLoss && !revealed;
          return (
            <span
              key={index}
              className={`hangmangame__letter${revealed ? ' hangmangame__letter--filled' : ''}${missed ? ' hangmangame__letter--missed' : ''}`}
            >
              {revealed || missed ? ch : ''}
            </span>
          );
        })}
      </div>

      <p className="hangmangame__lives" aria-label={`${remaining} guesses left`}>
        {Array.from({ length: MAX_MISSES }, (_, index) => (
          <span
            key={index}
            className={`hangmangame__life${index < misses ? ' hangmangame__life--lost' : ''}`}
            aria-hidden="true"
          >
            ●
          </span>
        ))}
      </p>

      {!isOver ? (
        <div className="hangmangame__keyboard" role="group" aria-label="Letters">
          {ALPHABET.map((letter) => {
            const isGuessed = guessed.has(letter);
            const isHit = isGuessed && answerLetters.has(letter);
            const isMiss = isGuessed && !answerLetters.has(letter);
            return (
              <button
                key={letter}
                type="button"
                className={`hangmangame__key${isHit ? ' hangmangame__key--hit' : ''}${isMiss ? ' hangmangame__key--miss' : ''}`}
                onClick={() => guessLetter(letter)}
                disabled={isGuessed}
                aria-label={`Guess ${letter}`}
              >
                {letter}
              </button>
            );
          })}
        </div>
      ) : (
        <div className={`hangmangame__feedback hangmangame__feedback--${isWin ? 'win' : 'loss'}`} role="status" aria-live="polite">
          <p className="hangmangame__verdict">{isWin ? 'Solved it! 🎉' : 'Out of guesses'}</p>
          <p className="hangmangame__answer">{answer}</p>
          <button ref={continueRef} type="button" className="button button--primary hangmangame__action" onClick={finish}>
            Continue
          </button>
        </div>
      )}
    </section>
  );
}

export default Hangman;
