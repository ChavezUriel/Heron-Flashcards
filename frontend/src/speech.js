// Thin wrapper over the Web Speech API, mirroring the approach already used in
// Flashcard.jsx (window.speechSynthesis) so the Phase 4 encoding aids can read a
// word aloud without pulling in a TTS dependency. See docs/minigames.md §4 (#11).

export function canUseSpeechSynthesis() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

// Maps a language code (e.g. 'en', 'es', 'fr', 'pt-BR') to a BCP-47 tag suitable
// for the Web Speech API (speechSynthesis). Defaults to 'en-US' for missing/empty.
export function speechLangFor(langCode) {
  if (!langCode || typeof langCode !== 'string') {
    return 'en-US';
  }
  const normalized = langCode.trim();
  if (!normalized) {
    return 'en-US';
  }
  if (normalized.includes('-')) {
    return normalized;
  }
  const TAG_MAP = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    pt: 'pt-PT',
    nl: 'nl-NL',
    ru: 'ru-RU',
    pl: 'pl-PL',
    tr: 'tr-TR',
    ja: 'ja-JP',
    zh: 'zh-CN',
    ko: 'ko-KR',
    ar: 'ar-SA',
    he: 'he-IL',
  };
  return TAG_MAP[normalized.toLowerCase()] ?? normalized;
}

export const resolveSpeechLang = speechLangFor;

// Speak `text`, cancelling anything already queued so a replay never stacks. Wires
// the caller's onEnd to both `onend` and `onerror` (a cancel fires one of them), so
// UI "speaking" state always clears. Returns the utterance, or null when speech is
// unavailable / the text is empty — callers use that to know a play actually began.
//
// Unlike Flashcard's auto-speech there is no dedupe window here: every call is an
// explicit user tap (Play / replay), so it should always fire.
export function speak(text, { lang = 'en-US', rate = 0.92, onEnd } = {}) {
  const speechText = typeof text === 'string' ? text.trim() : '';
  if (!speechText || !canUseSpeechSynthesis()) {
    return null;
  }

  window.speechSynthesis.cancel();

  const utterance = new window.SpeechSynthesisUtterance(speechText);
  utterance.lang = speechLangFor(lang);
  utterance.rate = rate;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();

  window.speechSynthesis.speak(utterance);
  return utterance;
}

export function cancelSpeech() {
  if (canUseSpeechSynthesis()) {
    window.speechSynthesis.cancel();
  }
}
