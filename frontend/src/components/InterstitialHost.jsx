import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MemoryGrid from './MemoryGrid';
import SpeedRound from './SpeedRound';
import WordScramble from './WordScramble';
import Hangman from './Hangman';
import SynonymMatch from './SynonymMatch';

// Render the chosen game. Pool-based games (memory_grid / speed_round) take the
// whole sampled pool; single-card cool-down puzzles (scramble / hangman, §4 #9–#10)
// take just the first card of the pool; the depth game (synonym_match, §9 Phase 6)
// takes cards[0] as its anchor and the rest as its distractor pool.
function renderGame(game, cards, onDone) {
  if (game === 'memory_grid') {
    return <MemoryGrid cards={cards} onDone={onDone} />;
  }
  if (game === 'scramble') {
    return <WordScramble card={cards[0]} onDone={onDone} />;
  }
  if (game === 'hangman') {
    return <Hangman card={cards[0]} onDone={onDone} />;
  }
  if (game === 'synonym_match') {
    return <SynonymMatch card={cards[0]} pool={cards.slice(1)} onDone={onDone} />;
  }
  return <SpeedRound cards={cards} onDone={onDone} />;
}

// Renders a queue-external Tier-C interstitial: a warm-up before the first card,
// a break at a block boundary, or a cool-down on the complete screen. It resolves
// entirely locally — the games never call a session RPC (§5.2, §8.2) — and reports
// back only through onDone(). While it is mounted, PracticePage keeps its classic
// arrow / idle-hint handlers inert (§8.4); the host owns Escape-to-dismiss and the
// games own the rest of the keyboard.
function InterstitialHost({ placement, game, cards, onDone }) {
  const { t } = useTranslation();
  const eyebrow =
    placement === 'warmup'
      ? t('games.interstitial.warmup')
      : placement === 'boundary'
        ? t('games.interstitial.break')
        : t('games.interstitial.cooldown');

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onDone();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDone]);

  return (
    <div className="interstitial">
      <div className="interstitial__banner">
        <div className="interstitial__intro">
          <p className="eyebrow">{eyebrow}</p>
          <p className="interstitial__note">{t('games.interstitial.note')}</p>
        </div>
        <button type="button" className="st-link-button interstitial__skip" onClick={onDone}>
          {t('games.interstitial.skip')}
        </button>
      </div>

      <div className="interstitial__game">
        {renderGame(game, cards, onDone)}
      </div>
    </div>
  );
}

export default InterstitialHost;
