import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';

import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ptBR from './locales/pt-BR.json';
import de from './locales/de.json';
import it from './locales/it.json';

const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  'pt-BR': { translation: ptBR },
  de: { translation: de },
  it: { translation: it },
};

i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    resources,
    lng: 'es',
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

export default i18n;
