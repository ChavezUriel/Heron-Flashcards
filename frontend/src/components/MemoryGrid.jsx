import { useEffect, useMemo, useRef, useState } from 'react';
import { getLanguage } from '../languages';

// Fisher–Yates so each column lands in a fresh order every round.
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Tier-C matching grid (docs/minigames.md §4 #8) — a queue-external warm-up /
// cool-down game. Pure spatial matching of prompt_l1 ↔ answer_l2, so it carries
// NO retrieval signal and never counts: it only ever calls onDone() to
// dismiss, and never touches a session RPC (§5.2, §8.2).
//
// Two independently shuffled columns (prompts, answers). Pick one
// tile from either side, then one from the other; a pair matches when both tiles
// carry the same card_id. Every tile is a real <button>, so Tab + Enter/Space
// drives it with no pointer required (§8.4); the host owns Escape-to-dismiss.
function MemoryGrid({ cards, onDone }) {
  const sourceLabel = getLanguage(cards?.[0]?.language_from ?? 'es')?.name ?? 'Prompt';
  const targetLabel = getLanguage(cards?.[0]?.language_to ?? 'en')?.name ?? 'Answer';

  const { l1Tiles, l2Tiles } = useMemo(
    () => ({
      l1Tiles: shuffle(cards.map((card) => ({ id: card.card_id, text: card.prompt_l1 ?? card.prompt_es }))),
      l2Tiles: shuffle(cards.map((card) => ({ id: card.card_id, text: card.answer_l2 ?? card.answer_en }))),
    }),
    [cards],
  );

  // The first tile picked (from either column) while a pair is being formed.
  const [pick, setPick] = useState(null); // { side: 'l1' | 'l2', id } | null
  const [matched, setMatched] = useState(() => new Set());
  // The two ids of a just-missed pair, held briefly so both flash red.
  const [wrongPair, setWrongPair] = useState(null); // { l1Id, l2Id } | null
  const wrongTimeoutRef = useRef(null);
  const doneRef = useRef(false);

  const total = cards.length;
  const allMatched = matched.size === total;

  useEffect(() => () => window.clearTimeout(wrongTimeoutRef.current), []);

  function finish() {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    onDone();
  }

  // Once every pair is found, linger on the win for a beat, then dismiss.
  useEffect(() => {
    if (!allMatched) {
      return undefined;
    }
    const timeout = window.setTimeout(finish, 900);
    return () => window.clearTimeout(timeout);
    // finish is stable enough (guarded by a ref); re-run only on completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMatched]);

  function handlePick(side, id) {
    // Ignore already-matched tiles and clicks during a wrong-pair flash.
    if (matched.has(id) || wrongPair) {
      return;
    }
    if (!pick || pick.side === side) {
      // First pick, or re-picking within the same column.
      setPick({ side, id });
      return;
    }
    // Second pick from the opposite column — evaluate the pair.
    if (pick.id === id) {
      setMatched((current) => {
        const next = new Set(current);
        next.add(id);
        return next;
      });
      setPick(null);
      return;
    }
    const l1Id = (side === 'l1' || side === 'es') ? id : pick.id;
    const l2Id = (side === 'l2' || side === 'en') ? id : pick.id;
    setWrongPair({ l1Id, l2Id });
    setPick(null);
    wrongTimeoutRef.current = window.setTimeout(() => setWrongPair(null), 700);
  }

  function tileClassName(side, tile) {
    let className = 'matchgame__tile';
    const isL1 = side === 'l1' || side === 'es';
    const isL2 = side === 'l2' || side === 'en';
    if (matched.has(tile.id)) {
      className += ' matchgame__tile--matched';
    } else if (wrongPair && ((isL1 && wrongPair.l1Id === tile.id) || (isL2 && wrongPair.l2Id === tile.id))) {
      className += ' matchgame__tile--wrong';
    } else if (pick && pick.side === side && pick.id === tile.id) {
      className += ' matchgame__tile--active';
    }
    return className;
  }

  function renderColumn(side, tiles, label) {
    return (
      <div className="matchgame__col" role="group" aria-label={label}>
        {tiles.map((tile) => (
          <button
            key={`${side}-${tile.id}`}
            type="button"
            className={tileClassName(side, tile)}
            disabled={matched.has(tile.id)}
            aria-pressed={pick?.side === side && pick.id === tile.id}
            aria-label={`${label}: ${tile.text}`}
            onClick={() => handlePick(side, tile.id)}
          >
            {tile.text}
          </button>
        ))}
      </div>
    );
  }

  return (
    <section className="panel matchgame">
      <p className="flashcard__label">Match the pairs</p>
      <p className="matchgame__hint" role="status" aria-live="polite">
        {allMatched ? 'All matched — nice work!' : `${matched.size} of ${total} matched`}
      </p>

      <div className="matchgame__columns">
        {renderColumn('l1', l1Tiles, sourceLabel)}
        {renderColumn('l2', l2Tiles, targetLabel)}
      </div>

      <button type="button" className="button button--primary matchgame__done" onClick={finish}>
        {allMatched ? 'Continue' : 'Skip'}
      </button>
    </section>
  );
}

export default MemoryGrid;
