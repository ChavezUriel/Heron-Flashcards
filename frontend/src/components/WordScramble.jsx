import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeAnswer } from '../minigameText';
import { getLanguage } from '../languages';

// Fisher–Yates over a copy.
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Scramble the answer's letters, retrying a few times so the jumble is never the
// answer itself (short words can shuffle back into order).
function scramble(letters) {
  if (letters.length < 2) {
    return [...letters];
  }
  const original = letters.join('');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = shuffle(letters);
    if (next.join('') !== original) {
      return next;
    }
  }
  return shuffle(letters);
}

// Tier-C cool-down game (docs/minigames.md §4 #9): a SINGLE-card word puzzle run as
// a queue-external interstitial. Unscramble the jumbled letters of the
// answer and type it in. It is pure arcade fun — a *different* skill from
// recall — so it NEVER grades: it only ever calls onDone() to dismiss and never
// touches a session RPC (§5.2, §8.2).
function WordScramble({ card, onDone }) {
  const answer = (card.answer_l2 ?? card.answer_en ?? '').trim();
  const prompt = card.prompt_l1 ?? card.prompt_es;
  const sourceLang = getLanguage(card.language_from ?? 'es');
  const sourceLabel = sourceLang?.name ?? 'Prompt';
  // The jumbled letters to display as tiles (letters only; spaces/punctuation are
  // dropped from the jumble but the typed answer is compared whole).
  const jumble = useMemo(() => {
    const letters = [...answer].filter((ch) => /\p{L}/u.test(ch));
    return scramble(letters);
  }, [answer]);

  const [guess, setGuess] = useState('');
  // null while typing; 'correct' | 'revealed' once resolved (drives the reveal).
  const [outcome, setOutcome] = useState(null);
  const inputRef = useRef(null);
  const continueRef = useRef(null);
  const doneRef = useRef(false);

  const isRevealed = outcome !== null;

  useEffect(() => {
    if (isRevealed) {
      continueRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [isRevealed]);

  function handleSubmit(event) {
    event.preventDefault();
    if (isRevealed || !normalizeAnswer(guess)) {
      return;
    }
    // Wrong guesses just stay in "playing" so the learner can try again; there is
    // nothing to grade, so a miss costs nothing.
    if (normalizeAnswer(guess) === normalizeAnswer(answer)) {
      setOutcome('correct');
    }
  }

  function reveal() {
    if (isRevealed) {
      return;
    }
    setOutcome('revealed');
  }

  function finish() {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    onDone();
  }

  const isWrong = Boolean(normalizeAnswer(guess)) && normalizeAnswer(guess) !== normalizeAnswer(answer);

  return (
    <section className="panel scramblegame">
      <p className="flashcard__label">Word scramble</p>
      <p className="scramblegame__prompt">
        <span className="scramblegame__prompt-label">{sourceLabel}</span>
        {prompt}
      </p>

      <div className="scramblegame__tiles" aria-hidden="true">
        {jumble.map((letter, index) => (
          <span key={`${letter}-${index}`} className="scramblegame__tile">{letter}</span>
        ))}
      </div>

      {!isRevealed ? (
        <form className="scramblegame__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={`st-input scramblegame__input${isWrong ? ' scramblegame__input--wrong' : ''}`}
            type="text"
            value={guess}
            onChange={(event) => setGuess(event.target.value)}
            placeholder="Unscramble the word"
            aria-label="Type the unscrambled English word"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
          />
          <div className="scramblegame__actions">
            <button type="submit" className="button button--primary scramblegame__action" disabled={!guess.trim()}>
              Check
            </button>
            <button type="button" className="st-link-button" onClick={reveal}>
              Reveal
            </button>
          </div>
        </form>
      ) : (
        <div className={`scramblegame__feedback scramblegame__feedback--${outcome}`} role="status" aria-live="polite">
          <p className="scramblegame__verdict">{outcome === 'correct' ? 'Solved it! 🎉' : 'Here it is'}</p>
          <p className="scramblegame__answer">{answer}</p>
          <button ref={continueRef} type="button" className="button button--primary scramblegame__action" onClick={finish}>
            Continue
          </button>
        </div>
      )}
    </section>
  );
}

export default WordScramble;
