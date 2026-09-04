import { useMemo } from 'react';
import MultipleChoice from './MultipleChoice';
import { locateAnswerInExample } from '../minigameText';

// Tier-B recognition game (docs/minigames.md §4 #6): blank the answer out of an
// English example sentence and have the learner pick the missing word from a bank
// of tiles (the real answer + curated cloze distractors, sibling English answers
// as fallback — migration 0018). Because the word is chosen from options, a win
// could come from elimination, so — like every Tier-B game — a win never counts
// (skip) and only a clean wrong pick records a lapse. It reuses MultipleChoice's
// tile/keyboard engine, swapping the prompt for the cloze sentence.
//
// Selected only when the answer is locatable in one of the card's example
// sentences and distractors are available (see selectModality/resolveModality);
// MinigameHost picks WHICH sentence this presentation blanks (`clozeExample`,
// migration 0019) and passes it down with its span.
function WordBankCloze({ card, clozeExample, distractors, onResolve, onOpenDetails }) {
  const example = clozeExample?.l2 ?? clozeExample?.en ?? card.example_l2 ?? card.example_en ?? '';
  const answer = card.answer_l2 ?? card.answer_en;
  const span = useMemo(
    () => clozeExample?.span ?? locateAnswerInExample(example, answer),
    [clozeExample, example, answer],
  );
  const before = span ? example.slice(0, span.start) : '';
  const after = span ? example.slice(span.end) : '';

  const promptNode = (
    <p className="clozegame__sentence wordbankgame__sentence">
      {before}
      <span className="clozegame__slot clozegame__slot--blank clozegame__slot--line" aria-label="missing word" />
      {after}
    </p>
  );

  return (
    <MultipleChoice
      card={card}
      distractors={distractors}
      onResolve={onResolve}
      onOpenDetails={onOpenDetails}
      answer={answer}
      label="Fill the gap"
      promptNode={promptNode}
    />
  );
}

export default WordBankCloze;
