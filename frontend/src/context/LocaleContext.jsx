import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import i18n from '../i18n';
import { fetchMe, updateUiLocale } from '../api';

export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'pt-BR', 'de', 'it'];

export const LocaleContext = createContext({
  currentLocale: 'es',
  profileLocale: null,
  deckL1: null,
  setDeckL1: () => {},
  setProfileLocale: async () => {},
  formatDate: (date) => String(date),
  formatNumber: (num) => String(num),
  localeCompare: (a, b) => String(a).localeCompare(String(b)),
});

function resolveSupportedLocale(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (SUPPORTED_LOCALES.includes(trimmed)) return trimmed;
  // Handle case-insensitive or base language matching (e.g., pt -> pt-BR)
  const lower = trimmed.toLowerCase();
  if (lower === 'pt' || lower === 'pt-br') return 'pt-BR';
  const match = SUPPORTED_LOCALES.find(loc => loc.toLowerCase() === lower || loc.toLowerCase().startsWith(lower + '-'));
  return match || null;
}

export function LocaleProvider({ children }) {
  const [profileLocale, setProfileLocaleState] = useState(null);
  const [deckL1, setDeckL1State] = useState(null);

  // Initialize profileLocale from backend if user is authenticated
  useEffect(() => {
    let isMounted = true;
    fetchMe()
      .then(user => {
        if (isMounted && user?.ui_locale) {
          const resolved = resolveSupportedLocale(user.ui_locale);
          if (resolved) {
            setProfileLocaleState(resolved);
          }
        }
      })
      .catch(() => {
        // Not authenticated or network error; keep null (follow L1)
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const currentLocale = useMemo(() => {
    // 1. Explicit profile UI locale takes precedence if set
    if (profileLocale && SUPPORTED_LOCALES.includes(profileLocale)) {
      return profileLocale;
    }
    // 2. Default: follow deck L1 if valid Tier 1 locale
    if (deckL1) {
      const resolvedL1 = resolveSupportedLocale(deckL1);
      if (resolvedL1) return resolvedL1;
    }
    // 3. Fallback: default to 'es' (historical app baseline)
    return 'es';
  }, [profileLocale, deckL1]);

  // Synchronize i18next language with effective currentLocale
  useEffect(() => {
    if (i18n.language !== currentLocale) {
      i18n.changeLanguage(currentLocale);
    }
    document.documentElement.lang = currentLocale;
  }, [currentLocale]);

  const setDeckL1 = useCallback((l1) => {
    setDeckL1State(l1);
  }, []);

  const setProfileLocale = useCallback(async (newLocale) => {
    const resolved = resolveSupportedLocale(newLocale);
    setProfileLocaleState(resolved);
    try {
      await updateUiLocale(resolved);
    } catch (err) {
      console.error('Failed to update UI locale in profile:', err);
    }
  }, []);

  const formatDate = useCallback((date, options) => {
    if (!date) return '';
    try {
      const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
      return new Intl.DateTimeFormat(currentLocale, options).format(d);
    } catch (_e) {
      return String(date);
    }
  }, [currentLocale]);

  const formatNumber = useCallback((number, options) => {
    if (number === null || number === undefined || isNaN(number)) return '';
    try {
      return new Intl.NumberFormat(currentLocale, options).format(number);
    } catch (_e) {
      return String(number);
    }
  }, [currentLocale]);

  const localeCompare = useCallback((a, b, options) => {
    return String(a ?? '').localeCompare(String(b ?? ''), currentLocale, options);
  }, [currentLocale]);

  const value = useMemo(() => ({
    currentLocale,
    profileLocale,
    deckL1,
    setDeckL1,
    setProfileLocale,
    formatDate,
    formatNumber,
    localeCompare,
  }), [currentLocale, profileLocale, deckL1, setDeckL1, setProfileLocale, formatDate, formatNumber, localeCompare]);

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
