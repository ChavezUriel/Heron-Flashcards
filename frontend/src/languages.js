// ===========================================================================
// Language registry and language pair configuration (P1)
// ===========================================================================
//
// Authoritative registry defining supported languages, metadata, and language
// pairs across the three independent axes:
//   1. UI locale (profiles.ui_locale) — app chrome language.
//   2. L1 / source (decks.language_from) — learner's native/source language.
//   3. L2 / target (decks.language_to) — target language being studied/tested.
//
// Tier 1 scope:
//   - Targets (L2): en, es, fr (the engine works unmodified).
//   - Sources (L1): en, es, fr, pt-BR, de, it (15 total pairs, es->en ships today).
//   - Tier 2+: pt, it, de, nl, ru, pl, tr, ja, zh, ko, ar, he (stubs included).
//
// Regression contract:
//   For es->en, all parameterizations resolve to today's hardcoded defaults.
// ===========================================================================

// Typo budget profile for Latin / alphabetic scripts:
// <= 3 chars: 0 typos
// 4-7 chars: 1 typo
// >= 8 chars: 2 typos
export function standardTypoBudget(length) {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}
standardTypoBudget.thresholds = [3, 7];
standardTypoBudget.maxBudget = 2;

// Typo budget for scripts where character edits are not typos (CJK / non-alphabetic):
export function zeroTypoBudget(_length) {
  return 0;
}
zeroTypoBudget.thresholds = [0, 0];
zeroTypoBudget.maxBudget = 0;

// Full set of 12 Smart Practice minigames:
const ALL_GAMES = new Set([
  'type_translation',
  'recall_from_definition',
  'cloze_free',
  'multiple_choice',
  'word_bank_cloze',
  'reverse_mc',
  'speed_round',
  'memory_grid',
  'synonym_match',
  'scramble',
  'hangman',
  'listening',
]);

// Non-segmenter / alphabetic games (without scramble and hangman):
const NON_ALPHABETIC_GAMES = new Set([
  'type_translation',
  'recall_from_definition',
  'cloze_free',
  'multiple_choice',
  'word_bank_cloze',
  'reverse_mc',
  'speed_round',
  'memory_grid',
  'synonym_match',
  'listening',
]);

// English function words: exact 25-entry list from frontend/src/minigameText.js
const EN_FUNCTION_WORDS = [
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
  'up', 'out', 'off', 'into', 'onto', 'over', 'under', 'down', 'away', 'back',
  'about', 'around', 'through',
];

// Spanish function words (articles, contractions, high-frequency prepositions)
const ES_FUNCTION_WORDS = [
  'a', 'al', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'los',
  'para', 'por', 'sin', 'sobre', 'un', 'una', 'unas', 'unos',
];

// French function words (articles, contractions, prepositions)
const FR_FUNCTION_WORDS = [
  'à', 'au', 'aux', 'avec', 'dans', 'de', 'des', 'du', 'en',
  'la', 'le', 'les', 'par', 'pour', 'sur', 'un', 'une',
];

// Portuguese (Brazil) function words
const PT_BR_FUNCTION_WORDS = [
  'a', 'ao', 'aos', 'as', 'com', 'da', 'das', 'de', 'do', 'dos',
  'em', 'na', 'nas', 'no', 'nos', 'para', 'por', 'um', 'uma', 'umas', 'uns',
];

// German function words
const DE_FUNCTION_WORDS = [
  'an', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der', 'des', 'die',
  'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'für', 'im', 'in',
  'mit', 'nach', 'von', 'zu', 'zum', 'zur',
];

// Italian function words
const IT_FUNCTION_WORDS = [
  'a', 'al', 'all', 'alla', 'alle', 'allo', 'agli', 'con', 'da', 'dal',
  'dalla', 'dallo', 'dei', 'del', 'dell', 'della', 'delle', 'dello',
  'degli', 'di', 'il', 'in', 'la', 'le', 'lo', 'gli', 'per', 'su',
  'tra', 'fra', 'un', 'una', 'uno',
];

// Languages registry keyed by BCP-47 tag
export const LANGUAGES = {
  // -------------------------------------------------------------------------
  // Tier 1 Languages
  // -------------------------------------------------------------------------
  en: {
    tag: 'en',
    name: 'English',
    endonym: 'English',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: EN_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'en-US',
    games: ALL_GAMES,
    tier: 1,
    tierL1: 1,
    tierL2: 1,
  },
  es: {
    tag: 'es',
    name: 'Spanish',
    endonym: 'Español',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: ES_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'es-ES',
    games: ALL_GAMES,
    tier: 1,
    tierL1: 1,
    tierL2: 1,
  },
  fr: {
    tag: 'fr',
    name: 'French',
    endonym: 'Français',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: FR_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'fr-FR',
    games: ALL_GAMES,
    tier: 1,
    tierL1: 1,
    tierL2: 1,
  },
  'pt-BR': {
    tag: 'pt-BR',
    name: 'Portuguese (Brazil)',
    endonym: 'Português (Brasil)',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: PT_BR_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'pt-BR',
    games: ALL_GAMES,
    tier: 1,
    tierL1: 1,
    tierL2: 2, // L2 deferred to Tier 2
  },
  de: {
    tag: 'de',
    name: 'German',
    endonym: 'Deutsch',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: DE_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'de-DE',
    games: ALL_GAMES,
    tier: 1,
    tierL1: 1,
    tierL2: 2, // L2 target deferred to Tier 2 (separable verbs)
  },
  it: {
    tag: 'it',
    name: 'Italian',
    endonym: 'Italiano',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: IT_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'it-IT',
    games: ALL_GAMES,
    tier: 1,
    tierL1: 1,
    tierL2: 2, // L2 target deferred to Tier 2
  },

  // -------------------------------------------------------------------------
  // Tier 2 Stubs (pt, it, de, nl as L2)
  // -------------------------------------------------------------------------
  pt: {
    tag: 'pt',
    name: 'Portuguese',
    endonym: 'Português',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: PT_BR_FUNCTION_WORDS,
    typoBudget: standardTypoBudget,
    ttsTag: 'pt-PT',
    games: ALL_GAMES,
    tier: 2,
    tierL1: 1,
    tierL2: 2,
  },
  nl: {
    tag: 'nl',
    name: 'Dutch',
    endonym: 'Nederlands',
    script: 'Latn',
    diacriticsSignificant: false,
    functionWords: ['de', 'het', 'een', 'van', 'in', 'op', 'te', 'met', 'voor'],
    typoBudget: standardTypoBudget,
    ttsTag: 'nl-NL',
    games: ALL_GAMES,
    tier: 2,
    tierL1: 2,
    tierL2: 2,
  },

  // -------------------------------------------------------------------------
  // Tier 3a Stubs (ru, pl, tr)
  // -------------------------------------------------------------------------
  ru: {
    tag: 'ru',
    name: 'Russian',
    endonym: 'Русский',
    script: 'Cyrl',
    diacriticsSignificant: false,
    functionWords: ['в', 'и', 'на', 'с', 'по', 'к', 'о', 'из', 'у', 'за'],
    typoBudget: standardTypoBudget,
    ttsTag: 'ru-RU',
    games: ALL_GAMES,
    tier: '3a',
    tierL1: '3a',
    tierL2: '3a',
  },
  pl: {
    tag: 'pl',
    name: 'Polish',
    endonym: 'Polski',
    script: 'Latn',
    diacriticsSignificant: true,
    functionWords: ['w', 'z', 'do', 'na', 'o', 'po', 'za', 'i'],
    typoBudget: standardTypoBudget,
    ttsTag: 'pl-PL',
    games: ALL_GAMES,
    tier: '3a',
    tierL1: '3a',
    tierL2: '3a',
  },
  tr: {
    tag: 'tr',
    name: 'Turkish',
    endonym: 'Türkçe',
    script: 'Latn',
    diacriticsSignificant: true,
    functionWords: ['bir', 've', 'ile', 'için', 'de', 'da'],
    typoBudget: standardTypoBudget,
    ttsTag: 'tr-TR',
    games: ALL_GAMES,
    tier: '3a',
    tierL1: '3a',
    tierL2: '3a',
  },

  // -------------------------------------------------------------------------
  // Tier 3b Stubs (ja, zh, ko)
  // -------------------------------------------------------------------------
  ja: {
    tag: 'ja',
    name: 'Japanese',
    endonym: '日本語',
    script: 'Jpan',
    diacriticsSignificant: false,
    functionWords: ['の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し'],
    typoBudget: zeroTypoBudget,
    ttsTag: 'ja-JP',
    games: NON_ALPHABETIC_GAMES,
    tier: '3b',
    tierL1: '3b',
    tierL2: '3b',
  },
  zh: {
    tag: 'zh',
    name: 'Chinese',
    endonym: '中文',
    script: 'Hans',
    diacriticsSignificant: false,
    functionWords: ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人'],
    typoBudget: zeroTypoBudget,
    ttsTag: 'zh-CN',
    games: NON_ALPHABETIC_GAMES,
    tier: '3b',
    tierL1: '3b',
    tierL2: '3b',
  },
  ko: {
    tag: 'ko',
    name: 'Korean',
    endonym: '한국어',
    script: 'Kore',
    diacriticsSignificant: false,
    functionWords: ['이', '그', '저', '의', '에', '을', '를', '은', '는', '과'],
    typoBudget: zeroTypoBudget,
    ttsTag: 'ko-KR',
    games: NON_ALPHABETIC_GAMES,
    tier: '3b',
    tierL1: '3b',
    tierL2: '3b',
  },

  // -------------------------------------------------------------------------
  // Tier 4 Stubs (ar, he)
  // -------------------------------------------------------------------------
  ar: {
    tag: 'ar',
    name: 'Arabic',
    endonym: 'العربية',
    script: 'Arab',
    diacriticsSignificant: false,
    functionWords: ['في', 'من', 'إلى', 'على', 'هذا', 'هذه'],
    typoBudget: standardTypoBudget,
    ttsTag: 'ar-SA',
    games: ALL_GAMES,
    tier: 4,
    tierL1: 4,
    tierL2: 4,
  },
  he: {
    tag: 'he',
    name: 'Hebrew',
    endonym: 'עברית',
    script: 'Hebr',
    diacriticsSignificant: false,
    functionWords: ['של', 'את', 'על', 'אל', 'זה', 'עם'],
    typoBudget: standardTypoBudget,
    ttsTag: 'he-IL',
    games: ALL_GAMES,
    tier: 4,
    tierL1: 4,
    tierL2: 4,
  },
};

// ===========================================================================
// PAIRS matrix
// ===========================================================================
// Tier 1 language pairs:
// Sources (L1): en, es, fr, pt-BR, de, it
// Targets (L2): en, es, fr
// 15 total pairs (es->en already ships today, 14 new pairs in Tier 1 scope).

const TIER_1_PAIRS = [
  // Target: en (L2)
  { l1: 'es', l2: 'en', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'fr', l2: 'en', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'pt-BR', l2: 'en', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'de', l2: 'en', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'it', l2: 'en', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },

  // Target: es (L2)
  { l1: 'en', l2: 'es', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'fr', l2: 'es', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'pt-BR', l2: 'es', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'de', l2: 'es', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'it', l2: 'es', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },

  // Target: fr (L2)
  { l1: 'en', l2: 'fr', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'es', l2: 'fr', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'pt-BR', l2: 'fr', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'de', l2: 'fr', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
  { l1: 'it', l2: 'fr', tier: 1, clozeStrategy: 'verbatim', minModelTier: 'tier1' },
];

// Export PAIRS as an array with key-based indexing support ('es->en', 'es:en')
export const PAIRS = [...TIER_1_PAIRS];
for (const p of TIER_1_PAIRS) {
  PAIRS[`${p.l1}->${p.l2}`] = p;
  PAIRS[`${p.l1}:${p.l2}`] = p;
}

// Return array of currently supported Tier 1 pairs
export function supportedPairs() {
  return PAIRS.filter((p) => p.tier === 1);
}

// Lookup language metadata by BCP-47 tag with fallback resolution
export function getLanguage(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const clean = tag.trim();
  if (LANGUAGES[clean]) return LANGUAGES[clean];

  // Case-insensitive match (e.g. 'pt-br' -> 'pt-BR')
  const lower = clean.toLowerCase();
  for (const [key, lang] of Object.entries(LANGUAGES)) {
    if (key.toLowerCase() === lower) return lang;
  }

  // Primary subtag fallback (e.g. 'en-US' -> 'en', 'es-MX' -> 'es')
  const primary = clean.split('-')[0].toLowerCase();
  for (const [key, lang] of Object.entries(LANGUAGES)) {
    if (key.toLowerCase() === primary) return lang;
  }

  return null;
}

// Lookup a specific language pair { l1, l2 }
export function getPair(l1, l2) {
  if (!l1) return null;
  if (typeof l1 === 'object' && l1 !== null && 'l1' in l1) {
    l2 = l1.l2;
    l1 = l1.l1;
  }
  if (!l1 || !l2) return null;
  const match = PAIRS.find((p) => p.l1 === l1 && p.l2 === l2);
  return match ?? null;
}

// Check whether a pair is supported in Tier 1
export function isPairSupported(l1, l2) {
  const pair = getPair(l1, l2);
  return Boolean(pair && pair.tier === 1);
}

// Default language pair for Heron (regression contract)
export function defaultPair() {
  return { l1: 'es', l2: 'en' };
}

// Check whether a minigame is supported for a given language tag or card/deck object (P5)
export function isGameSupportedForLanguage(game, langOrCard) {
  const tag = typeof langOrCard === 'string'
    ? langOrCard
    : (langOrCard?.language_to ?? langOrCard?.l2 ?? 'en');
  const lang = getLanguage(tag);
  return !lang?.games || lang.games.has(game);
}

// ===========================================================================
// Language-aware validation rules and script/n-gram heuristics (P4)
// ===========================================================================

// Unicode script matchers for script-range checks
export const SCRIPT_MATCHERS = {
  Latn: /\p{sc=Latin}/u,
  Cyrl: /\p{sc=Cyrillic}/u,
  Arab: /\p{sc=Arabic}/u,
  Hebr: /\p{sc=Hebrew}/u,
  Hans: /\p{sc=Han}/u,
  Jpan: /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/u,
  Kore: /[\p{sc=Hangul}\p{sc=Han}]/u,
};

// Check whether text contains any letter character outside the expected script
export function hasDisallowedScriptLetter(text, expectedScript) {
  if (!text || typeof text !== 'string') return false;
  const matcher = SCRIPT_MATCHERS[expectedScript];
  if (!matcher) return false;
  const letters = text.match(/[\p{L}]+/gu);
  if (!letters) return false;
  for (const token of letters) {
    for (const ch of token) {
      if (!matcher.test(ch)) return true;
    }
  }
  return false;
}

// Distinctive stopwords and character n-grams for Tier 1 languages (Latin script).
// Used by the lightweight in-repo n-gram heuristic when comparing L1 vs L2.
export const LANGUAGE_PROFILES = {
  en: {
    words: new Set(['the', 'is', 'are', 'was', 'were', 'have', 'has', 'had', 'with', 'that', 'this', 'from', 'which', 'will', 'would', 'their', 'there', 'they', 'what', 'when', 'where', 'who', 'how', 'been', 'into', 'about', 'than', 'them', 'these', 'those', 'each', 'other', 'some', 'only', 'your', 'our', 'its']),
    charNgrams: ['the', ' th', 'he ', 'ing', 'ng ', 'wit', 'ith', 'tha', 'hat', 'for', 'you', 'whi', 'sho', 'oul', 'uld'],
  },
  es: {
    punct: /[¿¡]/,
    words: new Set(['el', 'la', 'los', 'las', 'del', 'al', 'por', 'para', 'con', 'sin', 'sobre', 'este', 'esta', 'estos', 'estas', 'como', 'pero', 'muy', 'más', 'cuando', 'donde', 'son', 'fue', 'sus', 'nos', 'les', 'una', 'unos', 'unas']),
    charNgrams: [' de ', ' el ', ' la ', ' los', ' las', 'ción', 'ión ', 'que', 'ue ', 'ado ', 'ada ', 'ido ', 'ida ', 'nte ', 'ara ', 'est', ' con', ' por', ' par'],
  },
  fr: {
    chars: /[«»œæ]/,
    words: new Set(['le', 'la', 'les', 'des', 'du', 'dans', 'pour', 'avec', 'sur', 'par', 'est', 'sont', 'cette', 'ces', 'ce', 'qui', 'mais', 'plus', 'pas', 'son', 'sa', 'ses', 'leur', 'leurs', 'aux', 'sans', 'sous', 'comme', 'tout', 'faire', 'une']),
    charNgrams: [' de ', ' le ', ' la ', ' les', ' des', ' dans', ' avec', ' pour', ' qu\'', ' d\'', ' l\'', ' c\'', 'tion', 'ment', 'eaux', 'euse', 'ique', 'est ', 'ont ', 'ait '],
  },
  de: {
    chars: /[ß]/,
    words: new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'und', 'ist', 'sind', 'war', 'in', 'mit', 'von', 'zu', 'für', 'auf', 'nach', 'bei', 'aus', 'nicht', 'wie', 'aber', 'auch', 'sich', 'dass']),
    charNgrams: ['der', 'die', 'das', 'den', 'dem', 'des', 'und', 'ein', 'sch', 'cht', 'ung', 'ten ', 'gen ', 'für', 'bei', 'aus', 'nach', 'nich'],
  },
  it: {
    words: new Set(['il', 'lo', 'gli', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle', 'con', 'per', 'su', 'tra', 'fra', 'non', 'che', 'come', 'anche', 'sono', 'stato', 'una', 'uno']),
    charNgrams: [' di ', ' il ', ' la ', ' che', ' non', ' per', ' con', 'zione', 'ell', 'ato ', 'ita ', 'uto '],
  },
  'pt-BR': {
    chars: /[ãõ]/,
    words: new Set(['os', 'as', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'com', 'para', 'por', 'como', 'mais', 'não', 'está', 'são', 'foi', 'seu', 'sua', 'seus', 'suas', 'uma', 'uns', 'umas']),
    charNgrams: [' de ', ' do ', ' da ', ' dos', ' das', 'ção', 'não', ' que', ' com', ' para', 'ando', 'endo'],
  },
  pt: {
    chars: /[ãõ]/,
    words: new Set(['os', 'as', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'com', 'para', 'por', 'como', 'mais', 'não', 'está', 'são', 'foi', 'seu', 'sua', 'seus', 'suas', 'uma', 'uns', 'umas']),
    charNgrams: [' de ', ' do ', ' da ', ' dos', ' das', 'ção', 'não', ' que', ' com', ' para', 'ando', 'endo'],
  },
  nl: {
    words: new Set(['de', 'het', 'een', 'van', 'in', 'op', 'te', 'met', 'voor', 'is', 'en', 'niet', 'dat', 'die', 'maar', 'om', 'ook', 'aan']),
    charNgrams: ['van', 'het', 'een', 'der', 'den', 'ing', 'en ', 'ij', 'cht'],
  },
};

// Supply per-pair validation rules to enforce target language constraints
// and prevent L1 leakage into L2 fields.
export function getPairValidationRule(pair) {
  const l1 = typeof pair === 'object' && pair ? (pair.l1 || pair.language_from || 'es') : 'es';
  const l2 = typeof pair === 'object' && pair ? (pair.l2 || pair.language_to || 'en') : 'en';
  const l1Lang = getLanguage(l1) || { name: 'Spanish', script: 'Latn' };
  const l2Lang = getLanguage(l2) || { name: 'English', script: 'Latn' };
  const l1Profile = LANGUAGE_PROFILES[l1] || LANGUAGE_PROFILES[l1.split('-')[0]];
  const l2Profile = LANGUAGE_PROFILES[l2] || LANGUAGE_PROFILES[l2.split('-')[0]];

  const isDefault = l1 === 'es' && l2 === 'en';
  // Spanish inverted punctuation rule: ¿ and ¡ only apply when L1 is Spanish and L2 is not.
  const disallowedPunctuation = (l1 === 'es' && l2 !== 'es') ? /[¿¡]/ : null;
  const disallowedChars = (l1Profile?.chars && l2Lang.script === 'Latn' && !l2Profile?.chars?.test(l1Profile.chars.source))
    ? l1Profile.chars
    : null;

  return {
    l1,
    l2,
    l1Name: l1Lang.name,
    l2Name: l2Lang.name,
    expectedScript: l2Lang.script,
    isDefault,
    disallowedPunctuation,
    disallowedChars,
    isInvalidTargetText(text) {
      if (!text || typeof text !== 'string') return false;
      const str = text.trim();
      if (!str) return false;

      // 1. Script range check: any letter character belonging to a non-target script
      if (hasDisallowedScriptLetter(str, l2Lang.script)) {
        return true;
      }

      // 2. Disallowed punctuation / characters
      if (disallowedPunctuation && disallowedPunctuation.test(str)) {
        return true;
      }
      if (disallowedChars && disallowedChars.test(str)) {
        return true;
      }

      // 3. Lightweight n-gram / function word heuristic for same-script pairs
      if (l1Profile && l2Profile && l1Lang.script === l2Lang.script) {
        const clean = str.toLowerCase();
        const words = clean.match(/[\p{L}']+/gu) || [];
        if (words.length >= 2) {
          const l1Words = l1Profile.words || new Set();
          const l2Words = l2Profile.words || new Set();

          let l1WordMatches = 0;
          let l2WordMatches = 0;
          for (const w of words) {
            if (l1Words.has(w) && !l2Words.has(w)) l1WordMatches++;
            if (l2Words.has(w) && !l1Words.has(w)) l2WordMatches++;
          }

          let l1NgramMatches = 0;
          let l2NgramMatches = 0;
          const padded = ' ' + clean.replace(/\s+/g, ' ').trim() + ' ';
          for (const ng of (l1Profile.charNgrams || [])) {
            if (padded.includes(ng)) l1NgramMatches++;
          }
          for (const ng of (l2Profile.charNgrams || [])) {
            if (padded.includes(ng)) l2NgramMatches++;
          }

          if ((l1WordMatches >= 2 && l1WordMatches > l2WordMatches) ||
              (l1WordMatches >= 1 && l1NgramMatches >= 2 && l1NgramMatches > l2NgramMatches)) {
            return true;
          }
        }
      }

      return false;
    },
  };
}
