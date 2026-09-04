import { useEffect, useRef, useState } from 'react';
import { cancelSpeech, canUseSpeechSynthesis, speak, speechLangFor } from '../speech';
import { pickCardExample } from '../minigameText';
import { getLanguage } from '../languages';

// Tier-C encoding aid (docs/minigames.md §3.1, §4 #11) shown on a NEW card's very
// first exposure. It is PASSIVE "listen then reveal": the learner hears the
// word, then reveals how it is spelled. It is a *different skill* from recall
// (and at first exposure the word is brand-new, so "type what you hear" would be a
// guess, not encoding), so it NEVER grades regardless — Continue advances via
// onResolve({ skip: true }), deferring the real free-recall rep to a later cycle
// (§3.4, §6.1). Active dictation is left for a later phase.
//
// Audio does NOT autoplay on mount (browsers block it and it's jarring); the Play
// button is focused instead, and the flow still completes with speech unavailable —
// reveal + Continue never depend on audio.
function Listening({ card, onResolve, onOpenDetails, languageTo }) {
  const [isRevealed, setIsRevealed] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const activeExample = pickCardExample(card);
  const playRef = useRef(null);
  const continueRef = useRef(null);
  const hasResolvedRef = useRef(false);
  const speakTokenRef = useRef(0);

  const answer = card.answer_l2 ?? card.answer_en;
  const prompt = card.prompt_l1 ?? card.prompt_es;
  const targetLanguage = getLanguage(languageTo ?? card?.language_to ?? card?.deck?.language_to ?? 'en');
  const targetLabel = targetLanguage?.name ?? 'Answer';
  const targetLang = speechLangFor(languageTo ?? card?.language_to ?? card?.deck?.language_to ?? 'en');
  const hasSpeech = canUseSpeechSynthesis() && Boolean((answer ?? '').trim());

  // Focus the primary control for the current stage so Enter/Space always has a
  // target (§8.4): Play while listening, Continue once revealed. When audio is
  // unavailable there's nothing to play, so start focus on the revealed/Continue
  // flow via the reveal button.
  useEffect(() => {
    if (isRevealed) {
      continueRef.current?.focus();
    } else {
      playRef.current?.focus();
    }
  }, [isRevealed]);

  // Stop any in-flight audio when the aid unmounts, so speech never bleeds into the
  // next card after a skip.
  useEffect(() => () => cancelSpeech(), []);

  function play() {
    if (!hasSpeech) {
      return;
    }
    const token = (speakTokenRef.current += 1);
    const utterance = speak(answer, {
      lang: targetLang,
      onEnd: () => {
        if (speakTokenRef.current === token) {
          setIsSpeaking(false);
        }
      },
    });
    setIsSpeaking(Boolean(utterance));
  }

  function reveal() {
    if (isRevealed) {
      return;
    }
    setIsRevealed(true);
    // Revealing is a user gesture, so an auto-replay here isn't blocked and helps
    // bind the sound to the spelling the learner is now seeing.
    play();
  }

  // Idempotent: guards a double-tap / rapid Enter from double-firing the skip.
  function handleContinue() {
    if (hasResolvedRef.current) {
      return;
    }
    hasResolvedRef.current = true;
    onResolve({ skip: true });
  }

  // Listening owns one extra key beyond the focused button's native Enter/Space:
  // "R" replays the audio at any stage (§8.4). Native focus handles Play (listening)
  // and Continue (revealed); we don't intercept those to avoid double-firing.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      // The metadata modal opens on top of this aid while it stays mounted, so a
      // focused field there owns every printable key — "R" must type an "r".
      if (isTypingTarget(event.target)) {
        return;
      }
      if ((event.key === 'r' || event.key === 'R') && hasSpeech) {
        event.preventDefault();
        play();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // `play` reads only refs/props that are stable for this card; bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSpeech]);

  return (
    <section className="panel listengame">
      {card.section_name ? (
        <div className="listengame__meta-row">
          <span className="flashcard__meta-pill">{card.section_name}</span>
        </div>
      ) : null}

      <div className="listengame__body">
        <p className="flashcard__label">New word · listen</p>
        <h2 className="listengame__prompt">{prompt}</h2>

        {!isRevealed ? (
          <>
            <button
              ref={playRef}
              type="button"
              className={`listengame__play${isSpeaking ? ' listengame__play--speaking' : ''}`}
              onClick={play}
              disabled={!hasSpeech}
              aria-label="Play the word"
            >
              <PlayIcon />
              <span>{isSpeaking ? 'Playing…' : 'Play the word'}</span>
            </button>
            <p className="listengame__hint">
              {hasSpeech
                ? `Listen to the ${targetLabel} word, then reveal how it’s spelled. Press R to replay.`
                : 'Audio isn’t available in this browser — reveal the word to continue.'}
            </p>
            <button
              type="button"
              className="button button--secondary listengame__reveal-button"
              onClick={reveal}
            >
              Reveal word
            </button>
          </>
        ) : (
          <div className="listengame__reveal" role="status" aria-live="polite">
            <p className="listengame__answer">
              <span className="listengame__answer-label">{targetLabel}</span>
              <span className="listengame__answer-text">
                {answer}
                <button
                  type="button"
                  className={`flashcard__audio-button${isSpeaking ? ' flashcard__audio-button--playing' : ''}`}
                  onClick={play}
                  disabled={!hasSpeech}
                  aria-label={hasSpeech ? 'Replay the word' : 'Audio unavailable'}
                  title={hasSpeech ? 'Replay the word' : 'Audio unavailable'}
                >
                  <AudioIcon />
                </button>
              </span>
            </p>
            {activeExample.example_l2 ?? activeExample.l2 ?? activeExample.example_en ?? activeExample.en ? (
              <p className="listengame__example">{activeExample.example_l2 ?? activeExample.l2 ?? activeExample.example_en ?? activeExample.en}</p>
            ) : null}
            <button
              ref={continueRef}
              type="button"
              className="button button--primary listengame__action"
              onClick={handleContinue}
            >
              Continue
            </button>
          </div>
        )}
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

function isTypingTarget(target) {
  if (!target || typeof target.tagName !== 'string') {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" className="listengame__play-icon" viewBox="0 0 24 24">
      <path d="M8 5.5v13a.75.75 0 0 0 1.14.64l10.5-6.5a.75.75 0 0 0 0-1.28L9.14 4.86A.75.75 0 0 0 8 5.5Z" fill="currentColor" />
    </svg>
  );
}

// Inline copy of Flashcard's speaker glyph so this aid stays self-contained.
function AudioIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__audio-icon" viewBox="0 0 24 24">
      <path d="M3.75 9.5h4.1l4.4-3.55a.75.75 0 0 1 1.22.6v10.9a.75.75 0 0 1-1.22.6L7.85 14.5h-4.1A1.25 1.25 0 0 1 2.5 13.25v-2.5A1.25 1.25 0 0 1 3.75 9.5Z" fill="currentColor" />
      <path d="M16.55 8.2a.75.75 0 0 1 1.06.08 5.63 5.63 0 0 1 0 7.44.75.75 0 1 1-1.14-.98 4.12 4.12 0 0 0 0-5.48.75.75 0 0 1 .08-1.06Z" fill="currentColor" />
      <path d="M18.97 5.74a.75.75 0 0 1 1.06.07 9.38 9.38 0 0 1 0 12.38.75.75 0 1 1-1.14-.97 7.88 7.88 0 0 0 0-10.44.75.75 0 0 1 .08-1.04Z" fill="currentColor" />
    </svg>
  );
}

export default Listening;
