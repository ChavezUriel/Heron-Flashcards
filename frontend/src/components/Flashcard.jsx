import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { pickCardExample } from '../minigameText';

const AUTO_SPEECH_DEDUPE_WINDOW_MS = 750;
const TAP_REVEAL_TOLERANCE_PX = 12;
const TOUCH_SWIPE_REVIEW_THRESHOLD_PX = 56;
const POINTER_SWIPE_REVIEW_THRESHOLD_PX = 72;
const TOUCH_HORIZONTAL_SWIPE_RATIO = 0.85;
const POINTER_HORIZONTAL_SWIPE_RATIO = 1.2;
const TOUCH_CLICK_SUPPRESSION_WINDOW_MS = 500;
// Must outlast the --exit transition in styles.css so the fly-out finishes before the swap.
const EXIT_ANIMATION_MS = 400;
let lastAutoSpeech = {
  key: '',
  at: 0,
};

function canUseSpeechSynthesis() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function normalizeSpeechText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'));
}

function clampProgress(value) {
  return Math.min(Math.max(value, 0), 1);
}

function useTwoLineFit(targetRef, dependencies) {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const element = targetRef.current;
    if (!element) {
      return undefined;
    }

    let animationFrameId = 0;

    function countRenderedLines() {
      const computedStyles = window.getComputedStyle(element);
      const lineHeight = parseFloat(computedStyles.lineHeight);

      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        return 1;
      }

      return element.scrollHeight / lineHeight;
    }

    function fitToTwoLines() {
      element.style.removeProperty('--flashcard-fit-font-size');

      const computedStyles = window.getComputedStyle(element);
      const baseFontSize = parseFloat(computedStyles.fontSize);

      if (!Number.isFinite(baseFontSize) || baseFontSize <= 0) {
        return;
      }

      const minimumFontSize = Math.max(baseFontSize * 0.38, 18);
      let nextFontSize = baseFontSize;

      while (countRenderedLines() > 2.05 && nextFontSize > minimumFontSize) {
        nextFontSize = Math.max(nextFontSize - 1, minimumFontSize);
        element.style.setProperty('--flashcard-fit-font-size', `${nextFontSize}px`);
      }

      if (nextFontSize >= baseFontSize - 0.5) {
        element.style.removeProperty('--flashcard-fit-font-size');
      }
    }

    function scheduleFit() {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = window.requestAnimationFrame(fitToTwoLines);
    }

    scheduleFit();

    const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(scheduleFit) : null;
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }

    window.addEventListener('resize', scheduleFit);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      element.style.removeProperty('--flashcard-fit-font-size');
    };
  }, dependencies);
}

function AudioIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__audio-icon" viewBox="0 0 24 24">
      <path d="M3.75 9.5h4.1l4.4-3.55a.75.75 0 0 1 1.22.6v10.9a.75.75 0 0 1-1.22.6L7.85 14.5h-4.1A1.25 1.25 0 0 1 2.5 13.25v-2.5A1.25 1.25 0 0 1 3.75 9.5Z" fill="currentColor" />
      <path d="M16.55 8.2a.75.75 0 0 1 1.06.08 5.63 5.63 0 0 1 0 7.44.75.75 0 1 1-1.14-.98 4.12 4.12 0 0 0 0-5.48.75.75 0 0 1 .08-1.06Z" fill="currentColor" />
      <path d="M18.97 5.74a.75.75 0 0 1 1.06.07 9.38 9.38 0 0 1 0 12.38.75.75 0 1 1-1.14-.97 7.88 7.88 0 0 0 0-10.44.75.75 0 0 1 .08-1.04Z" fill="currentColor" />
    </svg>
  );
}

function SwipeDirectionIcon({ direction }) {
  const isLeft = direction === 'left';

  return (
    <svg aria-hidden="true" className="flashcard__swipe-icon" viewBox="0 0 20 20">
      <path
        d={isLeft ? 'M11.5 4.5 6 10l5.5 5.5' : 'M8.5 4.5 14 10l-5.5 5.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={isLeft ? 'M14.25 10H6.5' : 'M5.75 10H13.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TapRevealIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__tap-icon" viewBox="0 0 38 38" stroke="currentColor" fill="currentColor">
        <g id="SVGRepo_bgCarrier" strokeWidth="0"></g>
        <g
          id="SVGRepo_tracerCarrier"
          strokeLinecap="round"
          strokeLinejoin="round"
          stroke="currentColor"
          strokeWidth="1.2"
        ></g>
        <g id="SVGRepo_iconCarrier">
          <path d="M33 38H21c-.6 0-1-.4-1-1 0-1.5-.7-2.4-1.8-3.8-.6-.7-1.3-1.6-2-2.7-1.9-3-3.6-6.6-4-7.9-.4-1.3-.1-2.2.3-2.7.4-.6 1.2-.9 2.1-.9 1.2 0 2.4 1 3.5 2.3V11c0-1.7 1.3-3 3-3s3 1.3 3 3v4.2c.3-.1.6-.2 1-.2 1.1 0 2 .6 2.5 1.4.4-.3.9-.4 1.4-.4 1.4 0 2.5.9 2.9 2.2.3-.1.7-.2 1.1-.2 1.7 0 3 1.3 3 3v3c0 2.6-.5 4.7-1 6.7s-1 3.9-1 6.3c0 .6-.4 1-1 1zm-11.1-2H32c.1-2.2.6-4 1-5.8.5-2 1-3.9 1-6.2v-3c0-.6-.4-1-1-1s-1 .4-1 1v1c0 .6-.4 1-1 1s-1-.4-1-1v-3c0-.6-.4-1-1-1s-1 .4-1 1v2c0 .6-.4 1-1 1s-1-.4-1-1v-3c0-.6-.4-1-1-1s-1 .4-1 1v2c0 .6-.4 1-1 1s-1-.4-1-1v-9c0-.6-.4-1-1-1s-1 .4-1 1v15c0 .6-.4 1-1 1s-1-.4-1-1v-.8c-.9-2.3-2.8-4.2-3.5-4.2-.2 0-.4 0-.5.1-.1.1-.1.4 0 .9.3 1.1 1.8 4.3 3.8 7.5.6 1 1.2 1.7 1.8 2.5 1.1 1.2 2.1 2.3 2.3 4z"></path>
        </g>
    </svg>
  );
}

function Flashcard({
  card,
  isAnswerVisible,
  isSubmitting,
  hideRevealButton = false,
  hideRevealButtonOnMobile = false,
  isIdleHintVisible = false,
  actionsRef,
  onReveal,
  onToggleReveal,
  onOpenDetails,
  onReviewKnown,
  onReviewUnknown,
}) {
  const activeUtteranceRef = useRef(null);
  const previousAnswerVisibleRef = useRef(isAnswerVisible);
  const hasAutoSpokenAnswerRef = useRef(false);
  const promptHeadingRef = useRef(null);
  const answerHeadingRef = useRef(null);
  const lastTouchInteractionAtRef = useRef(0);
  const suppressSurfaceClickRef = useRef(false);
  const gestureStateRef = useRef({
    pointerId: null,
    pointerType: '',
    touchIdentifier: null,
    startX: 0,
    startY: 0,
    tracking: false,
  });
  const [dragOffsetX, setDragOffsetX] = useState(0);
  // While a review commits, the leaving card is frozen here so the fly-out keeps
  // showing it even after the parent swaps `card` to the next one.
  const exitCardRef = useRef(null);
  const exitTimeoutRef = useRef(null);
  const [exitDirection, setExitDirection] = useState(null);
  const [isExitSettled, setIsExitSettled] = useState(false);
  const [enterGeneration, setEnterGeneration] = useState(0);

  const displayCard = exitCardRef.current ?? card;
  const activeExample = pickCardExample(displayCard);
  const isBackVisible = exitDirection ? true : isAnswerVisible;
  const hasAnswerSpeech = canUseSpeechSynthesis() && Boolean(normalizeSpeechText(displayCard.answer_en));
  const knownSwipeProgress = clampProgress(dragOffsetX / TOUCH_SWIPE_REVIEW_THRESHOLD_PX);
  const unknownSwipeProgress = clampProgress(-dragOffsetX / TOUCH_SWIPE_REVIEW_THRESHOLD_PX);
  const showRevealHint = isIdleHintVisible && !isBackVisible;
  const showSwipeHint = isIdleHintVisible && isBackVisible && !exitDirection;

  useTwoLineFit(promptHeadingRef, [displayCard.card_id, displayCard.prompt_es]);
  useTwoLineFit(answerHeadingRef, [displayCard.card_id, displayCard.answer_en, isBackVisible]);

  function resetGesture() {
    gestureStateRef.current = {
      pointerId: null,
      pointerType: '',
      touchIdentifier: null,
      startX: 0,
      startY: 0,
      tracking: false,
    };
    setDragOffsetX(0);
  }

  function commitReview(direction) {
    const submitReview = direction === 'right' ? onReviewKnown : onReviewUnknown;

    if (exitDirection || isSubmitting || !isAnswerVisible || typeof submitReview !== 'function') {
      return false;
    }

    exitCardRef.current = card;
    setExitDirection(direction);
    setIsExitSettled(false);
    window.clearTimeout(exitTimeoutRef.current);
    exitTimeoutRef.current = window.setTimeout(() => {
      setIsExitSettled(true);
    }, EXIT_ANIMATION_MS);
    submitReview();
    return true;
  }

  useImperativeHandle(actionsRef, () => ({
    triggerReview: commitReview,
  }));

  useEffect(() => {
    if (!exitDirection || !isExitSettled || isSubmitting) {
      return;
    }

    exitCardRef.current = null;
    setExitDirection(null);
    setEnterGeneration((generation) => generation + 1);
  }, [exitDirection, isExitSettled, isSubmitting]);

  useEffect(() => () => {
    window.clearTimeout(exitTimeoutRef.current);
  }, []);

  function stopSpeech() {
    if (!canUseSpeechSynthesis()) {
      activeUtteranceRef.current = null;
      return;
    }

    window.speechSynthesis.cancel();
    activeUtteranceRef.current = null;
  }

  function speakText(text, lang, key) {
    const speechText = normalizeSpeechText(text);
    if (!speechText || !canUseSpeechSynthesis()) {
      return;
    }

    const now = Date.now();
    if (lastAutoSpeech.key === key && now - lastAutoSpeech.at < AUTO_SPEECH_DEDUPE_WINDOW_MS) {
      return;
    }

    lastAutoSpeech = { key, at: now };
    stopSpeech();

    const utterance = new window.SpeechSynthesisUtterance(speechText);
    utterance.lang = lang;
    utterance.rate = 0.92;
    utterance.onend = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
      }
    };
    utterance.onerror = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
      }
    };

    activeUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  useEffect(() => {
    stopSpeech();
    hasAutoSpokenAnswerRef.current = false;
  }, [card.card_id]);

  useEffect(() => {
    speakText(card.prompt_es, 'es-ES', `prompt:${card.card_id}:${card.prompt_es}`);
  }, [card.card_id, card.prompt_es]);

  useEffect(() => {
    const wasAnswerVisible = previousAnswerVisibleRef.current;
    previousAnswerVisibleRef.current = isAnswerVisible;

    if (!isAnswerVisible || wasAnswerVisible || hasAutoSpokenAnswerRef.current) {
      return;
    }

    hasAutoSpokenAnswerRef.current = true;
    speakText(card.answer_en, 'en-US', `answer:${card.card_id}:${card.answer_en}`);
  }, [card.answer_en, card.card_id, isAnswerVisible]);

  useEffect(() => () => {
    stopSpeech();
  }, []);

  useEffect(() => {
    resetGesture();
    suppressSurfaceClickRef.current = false;
  }, [card.card_id, isAnswerVisible]);

  function handlePlayAnswerSpeech() {
    if (!hasAnswerSpeech) {
      return;
    }

    speakText(displayCard.answer_en, 'en-US', `manual-answer:${displayCard.card_id}:${Date.now()}`);
  }

  function handlePointerDown(event) {
    if (event.pointerType === 'touch') {
      return;
    }

    if (!event.isPrimary || isSubmitting || isInteractiveTarget(event.target)) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    if (event.pointerType === 'mouse' && !isAnswerVisible) {
      return;
    }

    gestureStateRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      touchIdentifier: null,
      startX: event.clientX,
      startY: event.clientY,
      tracking: true,
    };

    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const gestureState = gestureStateRef.current;

    if (!gestureState.tracking || gestureState.pointerId !== event.pointerId || gestureState.pointerType === 'touch' || !isAnswerVisible) {
      return;
    }

    const deltaX = event.clientX - gestureState.startX;
    const deltaY = event.clientY - gestureState.startY;

    if (Math.abs(deltaX) < TAP_REVEAL_TOLERANCE_PX && Math.abs(deltaY) < TAP_REVEAL_TOLERANCE_PX) {
      return;
    }

    if (Math.abs(deltaX) <= Math.abs(deltaY) * POINTER_HORIZONTAL_SWIPE_RATIO) {
      return;
    }

    event.preventDefault();
    setDragOffsetX(deltaX);
  }

  function handlePointerEnd(event) {
    const gestureState = gestureStateRef.current;

    if (!gestureState.tracking || gestureState.pointerId !== event.pointerId || gestureState.pointerType === 'touch') {
      return;
    }

    const deltaX = event.clientX - gestureState.startX;
    const deltaY = event.clientY - gestureState.startY;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);
    const isTapGesture = absoluteX <= TAP_REVEAL_TOLERANCE_PX && absoluteY <= TAP_REVEAL_TOLERANCE_PX;
    const isMousePointer = gestureState.pointerType === 'mouse';

    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!isAnswerVisible) {
      resetGesture();
      if (isTapGesture && !isMousePointer) {
        if (typeof onToggleReveal === 'function') {
          onToggleReveal();
          return;
        }

        onReveal();
      }
      return;
    }

    const isHorizontalSwipe = absoluteX >= POINTER_SWIPE_REVIEW_THRESHOLD_PX && absoluteX > absoluteY * POINTER_HORIZONTAL_SWIPE_RATIO;
    resetGesture();

    if (!isHorizontalSwipe) {
      if (isTapGesture && !isMousePointer && typeof onToggleReveal === 'function') {
        onToggleReveal();
      }
      return;
    }

    suppressSurfaceClickRef.current = true;
    commitReview(deltaX > 0 ? 'right' : 'left');
  }

  function handlePointerCancel(event) {
    if (gestureStateRef.current.pointerId !== event.pointerId || gestureStateRef.current.pointerType === 'touch') {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    resetGesture();
  }

  function findTrackedTouch(touchList) {
    const trackedIdentifier = gestureStateRef.current.touchIdentifier;

    if (trackedIdentifier === null) {
      return null;
    }

    return Array.from(touchList).find((touch) => touch.identifier === trackedIdentifier) ?? null;
  }

  function handleTouchStart(event) {
    if (isSubmitting || isInteractiveTarget(event.target) || event.touches.length !== 1) {
      return;
    }

    const [touch] = event.touches;
    lastTouchInteractionAtRef.current = Date.now();
    gestureStateRef.current = {
      pointerId: null,
      pointerType: 'touch',
      touchIdentifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      tracking: true,
    };
  }

  function handleTouchMove(event) {
    const gestureState = gestureStateRef.current;

    if (!gestureState.tracking || gestureState.pointerType !== 'touch' || !isAnswerVisible) {
      return;
    }

    const trackedTouch = findTrackedTouch(event.touches);
    if (!trackedTouch) {
      return;
    }

    const deltaX = trackedTouch.clientX - gestureState.startX;
    const deltaY = trackedTouch.clientY - gestureState.startY;

    if (Math.abs(deltaX) < TAP_REVEAL_TOLERANCE_PX && Math.abs(deltaY) < TAP_REVEAL_TOLERANCE_PX) {
      return;
    }

    if (Math.abs(deltaX) <= Math.abs(deltaY) * TOUCH_HORIZONTAL_SWIPE_RATIO) {
      return;
    }

    event.preventDefault();
    lastTouchInteractionAtRef.current = Date.now();
    setDragOffsetX(deltaX);
  }

  function handleTouchEnd(event) {
    const gestureState = gestureStateRef.current;

    if (!gestureState.tracking || gestureState.pointerType !== 'touch') {
      return;
    }

    const trackedTouch = findTrackedTouch(event.changedTouches);
    if (!trackedTouch) {
      resetGesture();
      return;
    }

    const deltaX = trackedTouch.clientX - gestureState.startX;
    const deltaY = trackedTouch.clientY - gestureState.startY;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);
    const isTapGesture = absoluteX <= TAP_REVEAL_TOLERANCE_PX && absoluteY <= TAP_REVEAL_TOLERANCE_PX;
    const isHorizontalSwipe =
      absoluteX >= TOUCH_SWIPE_REVIEW_THRESHOLD_PX && absoluteX > absoluteY * TOUCH_HORIZONTAL_SWIPE_RATIO;

    lastTouchInteractionAtRef.current = Date.now();

    if (!isAnswerVisible) {
      resetGesture();
      if (isTapGesture) {
        if (typeof onToggleReveal === 'function') {
          onToggleReveal();
          return;
        }

        onReveal();
      }
      return;
    }

    resetGesture();

    if (isHorizontalSwipe) {
      suppressSurfaceClickRef.current = true;
      commitReview(deltaX > 0 ? 'right' : 'left');
      return;
    }

    if (isTapGesture && typeof onToggleReveal === 'function') {
      onToggleReveal();
    }
  }

  function handleTouchCancel() {
    if (gestureStateRef.current.pointerType !== 'touch') {
      return;
    }

    resetGesture();
  }

  function handleSurfaceClick(event) {
    if (suppressSurfaceClickRef.current) {
      suppressSurfaceClickRef.current = false;
      return;
    }

    if (
      isSubmitting ||
      isInteractiveTarget(event.target) ||
      event.nativeEvent?.pointerType === 'touch' ||
      Date.now() - lastTouchInteractionAtRef.current < TOUCH_CLICK_SUPPRESSION_WINDOW_MS
    ) {
      return;
    }

    if (typeof onToggleReveal === 'function') {
      onToggleReveal();
      return;
    }

    onReveal();
  }

  const gestureSurfaceClassName = [
    'flashcard__gesture-surface',
    !exitDirection && dragOffsetX !== 0 ? 'flashcard__gesture-surface--dragging' : '',
    exitDirection ? `flashcard__gesture-surface--exit flashcard__gesture-surface--exit-${exitDirection}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const flipperClassName = ['flashcard__flipper', isBackVisible ? 'flashcard__flipper--flipped' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <section className="panel flashcard">
      <div
        aria-label={
          isBackVisible
            ? 'Flashcard answer shown. Swipe left for unknown or right for known on touch devices.'
            : 'Flashcard prompt. Tap to reveal the answer on touch devices.'
        }
        className={gestureSurfaceClassName}
        key={`${displayCard.card_id}:${enterGeneration}`}
        onClick={handleSurfaceClick}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onTouchCancel={handleTouchCancel}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        role="presentation"
        style={{
          '--flashcard-swipe-rotate': `${dragOffsetX / 18}deg`,
          '--flashcard-swipe-x': `${dragOffsetX}px`,
          '--flashcard-swipe-known': knownSwipeProgress,
          '--flashcard-swipe-unknown': unknownSwipeProgress,
        }}
      >
        <div className={flipperClassName}>
          <div aria-hidden={isBackVisible} className="flashcard__face flashcard__face--front" inert={isBackVisible}>
            {displayCard.section_name ? (
              <div className="flashcard__meta-row">
                <span className="flashcard__meta-pill">{displayCard.section_name}</span>
              </div>
            ) : null}
            <p className="flashcard__label">Spanish</p>
            <div className="flashcard__prompt-row">
              <h2 className="flashcard__inline-audio-heading flashcard__fit-heading" ref={promptHeadingRef}>
                <span>{displayCard.prompt_es}</span>
              </h2>
            </div>
            {activeExample.example_es ?? activeExample.es ? <p className="flashcard__example">{activeExample.example_es ?? activeExample.es}</p> : null}

            {showRevealHint ? (
              <div className="flashcard__reveal-hint" aria-hidden="true">
                <span className="flashcard__reveal-pill">
                  <TapRevealIcon />
                  <span>Tap to reveal</span>
                </span>
              </div>
            ) : null}
          </div>

          <div aria-hidden={!isBackVisible} className="flashcard__face flashcard__face--back" inert={!isBackVisible}>
            {displayCard.section_name ? (
              <div className="flashcard__meta-row">
                <span className="flashcard__meta-pill flashcard__meta-pill--secondary">{displayCard.section_name}</span>
              </div>
            ) : null}
            <p className="flashcard__label">English</p>
            <div className="flashcard__prompt-row flashcard__prompt-row--answer">
              <h3 className="flashcard__inline-audio-heading flashcard__fit-heading flashcard__fit-heading--answer" ref={answerHeadingRef}>
                <span>{displayCard.answer_en}</span>
                <button
                  aria-label={hasAnswerSpeech ? 'Replay English audio' : 'English audio unavailable'}
                  className="flashcard__audio-button"
                  type="button"
                  onClick={handlePlayAnswerSpeech}
                  disabled={!hasAnswerSpeech}
                  title={hasAnswerSpeech ? 'Replay English audio' : 'English audio unavailable'}
                >
                  <AudioIcon />
                </button>
              </h3>
            </div>
            {activeExample.example_en ?? activeExample.en ? <p className="flashcard__example flashcard__example--answer">{activeExample.example_en ?? activeExample.en}</p> : null}
            <button
              aria-label="Show flashcard metadata"
              className="info-button"
              type="button"
              onClick={onOpenDetails}
            >
              i
            </button>

            <div className={`flashcard__swipe-feedback${showSwipeHint ? ' flashcard__swipe-feedback--visible' : ''}`} aria-hidden="true">
              <span className="flashcard__swipe-pill flashcard__swipe-pill--unknown">
                <SwipeDirectionIcon direction="left" />
                <span>I didn't know it</span>
              </span>
              <span className="flashcard__swipe-pill flashcard__swipe-pill--known">
                <span>I knew it</span>
                <SwipeDirectionIcon direction="right" />
              </span>
            </div>
          </div>
        </div>
      </div>

      {!hideRevealButton ? (
        <button
          className={`button button--secondary flashcard__reveal${hideRevealButtonOnMobile ? ' flashcard__reveal--mobile-hidden' : ''}`}
          type="button"
          onClick={onToggleReveal}
          disabled={Boolean(exitDirection) || isSubmitting}
        >
          {isAnswerVisible ? 'Hide answer' : 'Reveal answer'}
        </button>
      ) : null}
    </section>
  );
}

export default Flashcard;
