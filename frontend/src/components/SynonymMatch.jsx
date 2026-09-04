import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeAnswer } from '../minigameText';
import { recordDepthResult } from '../depthStat';
import { logMinigamePlay } from '../api';

// How many synonyms a round shows at most, and the target size of the tile grid.
const MAX_SYNONYMS = 4;
const MIN_DISTRACTORS = 3;

// Fisher–Yates over a copy.
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Build one round: the anchor card's English synonyms (the correct picks) mixed with
// distractor words sampled from OTHER seen cards' answers. Everything is normalized-
// deduped so a distractor can never restate a synonym or the answer itself. No fetch —
// the distractors come straight from the queue-external seen-cards pool.
function buildRound(card, pool) {
  const answer = card?.answer_l2 ?? card?.answer_en;
  const synonyms = card?.l2_synonyms ?? card?.synonyms_en ?? [];
  const seen = new Set([normalizeAnswer(answer)]);

  const correct = [];
  for (const raw of synonyms) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const norm = normalizeAnswer(text);
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    correct.push(text);
    if (correct.length >= MAX_SYNONYMS) {
      break;
    }
  }

  const distractorPool = [];
  for (const other of pool ?? []) {
    const text = (other?.answer_l2 ?? other?.answer_en ?? '').trim();
    const norm = normalizeAnswer(text);
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    distractorPool.push(text);
  }

  // Show at least as many distractors as synonyms (so "select all" is never the
  // answer), capped by what the pool can supply.
  const distractorCount = Math.min(
    Math.max(correct.length, MIN_DISTRACTORS),
    distractorPool.length,
  );
  const distractors = shuffle(distractorPool).slice(0, distractorCount);

  const tiles = shuffle([
    ...correct.map((text) => ({ text, correct: true })),
    ...distractors.map((text) => ({ text, correct: false })),
  ]);
  return { tiles, total: correct.length };
}

// Depth game (docs/minigames.md §11, §4 enrichment aside, §9 Phase 6): pick which
// sibling words share the answer's meaning. It tests a DIFFERENT fact from es→en
// recall (a word's synonyms), so like the other cool-down games it runs entirely
// queue-external — it NEVER grades, never calls a session RPC, and never touches
// due_at or the graduation streak. Wins feed a separate client-side "depth" stat.
function SynonymMatch({ card, pool, onDone }) {
  const { tiles, total } = useMemo(() => buildRound(card, pool), [card, pool]);

  // Indices of the currently selected tiles (multi-select), then frozen on reveal.
  const [selected, setSelected] = useState(() => new Set());
  const [isRevealed, setIsRevealed] = useState(false);
  const [result, setResult] = useState(null); // { matched, total, wrong, stat }
  const doneRef = useRef(false);
  const continueRef = useRef(null);

  useEffect(() => {
    if (isRevealed) {
      continueRef.current?.focus();
    }
  }, [isRevealed]);

  function toggle(index) {
    if (isRevealed || index < 0 || index >= tiles.length) {
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function handleCheck() {
    if (isRevealed) {
      return;
    }
    let matched = 0;
    let wrong = 0;
    tiles.forEach((tile, index) => {
      if (!selected.has(index)) {
        return;
      }
      if (tile.correct) {
        matched += 1;
      } else {
        wrong += 1;
      }
    });
    // Fold the round into the lifetime depth stat and log the play (never counts
    // toward FSRS). Both are best-effort and cannot disrupt the game.
    const stat = recordDepthResult({ matched, total });
    const outcome = matched === total && wrong === 0 ? 'perfect' : matched > 0 ? 'partial' : 'miss';
    logMinigamePlay(card?.card_id, 'synonym_match', outcome, false);
    setResult({ matched, total, wrong, stat });
    setIsRevealed(true);
  }

  function finish() {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    onDone();
  }

  // Number keys 1–9 toggle a tile, mirroring the multiple-choice keyboard story so
  // the game is fully playable without a pointer (§8.4). Tab + Enter/Space already
  // toggle the focused tile natively (they are real buttons).
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isRevealed) {
        return;
      }
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(tiles.length, 9)) {
        event.preventDefault();
        toggle(digit - 1);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // toggle reads only stable refs/state setters; bind to reveal + tile count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevealed, tiles.length]);

  function tileClassName(tile, index) {
    let className = 'synmatch__tile';
    if (isRevealed) {
      if (tile.correct && selected.has(index)) {
        className += ' synmatch__tile--hit';
      } else if (tile.correct) {
        className += ' synmatch__tile--missed';
      } else if (selected.has(index)) {
        className += ' synmatch__tile--wrong';
      } else {
        className += ' synmatch__tile--muted';
      }
    } else if (selected.has(index)) {
      className += ' synmatch__tile--active';
    }
    return className;
  }

  const verdict = !result
    ? ''
    : result.matched === result.total && result.wrong === 0
      ? 'Perfect! 🎉'
      : result.matched > 0
        ? 'Nice — a few of them'
        : 'Here they are';

  return (
    <section className="panel synmatch">
      <p className="flashcard__label">Synonym match</p>
      <p className="synmatch__lead">Pick the words that mean the same as</p>
      <h2 className="synmatch__answer">{card?.answer_l2 ?? card?.answer_en}</h2>
      {card?.prompt_l1 ?? card?.prompt_es ? <p className="synmatch__context">{card.prompt_l1 ?? card.prompt_es}</p> : null}

      <div className="synmatch__tiles" role="group" aria-label="Word options">
        {tiles.map((tile, index) => (
          <button
            key={`${tile.text}-${index}`}
            type="button"
            className={tileClassName(tile, index)}
            onClick={() => toggle(index)}
            disabled={isRevealed}
            aria-pressed={selected.has(index)}
            aria-label={`${tile.text}${isRevealed && tile.correct ? ' — synonym' : ''}`}
          >
            <span className="synmatch__tile-key" aria-hidden="true">{index + 1}</span>
            <span className="synmatch__tile-text">{tile.text}</span>
          </button>
        ))}
      </div>

      {!isRevealed ? (
        <div className="synmatch__actions">
          <button type="button" className="button button--primary synmatch__action" onClick={handleCheck}>
            Check
          </button>
          <button type="button" className="st-link-button" onClick={finish}>
            Skip
          </button>
        </div>
      ) : (
        <div className="synmatch__feedback" role="status" aria-live="polite">
          <p className="synmatch__verdict">{verdict}</p>
          <p className="synmatch__result">
            Matched {result.matched} of {result.total} · depth {result.stat.matched} words
          </p>
          <button ref={continueRef} type="button" className="button button--primary synmatch__action" onClick={finish}>
            Continue
          </button>
        </div>
      )}
    </section>
  );
}

export default SynonymMatch;
