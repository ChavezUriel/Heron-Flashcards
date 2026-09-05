import { useTranslation } from 'react-i18next';
import MultipleChoice from './MultipleChoice';
import { getLanguage } from '../languages';

// Tier-B recognition game (docs/minigames.md §4 #5): the reverse of Multiple choice
// — show the answer and have the learner pick the matching prompt
// from sibling prompt tiles. Like every Tier-B game a win never counts (skip),
// only a clean wrong pick records a lapse; it reuses MultipleChoice's tile/keyboard
// engine with the prompt and correct answer swapped to the prompt side.
function ReverseMultipleChoice({ card, distractors, onResolve, onOpenDetails }) {
  const { t } = useTranslation();
  const sourceLang = getLanguage(card?.language_from ?? 'es');
  const sourceLabel = sourceLang?.name ?? t('deck.source_prompt_fallback');
  return (
    <MultipleChoice
      card={card}
      distractors={distractors}
      onResolve={onResolve}
      onOpenDetails={onOpenDetails}
      answer={card.prompt_l1 ?? card.prompt_es}
      answerLabel={sourceLabel}
      label={t('games.reverse_mc.label')}
      promptNode={<h2 className="mcgame__prompt">{card.answer_l2 ?? card.answer_en}</h2>}
    />
  );
}

export default ReverseMultipleChoice;
