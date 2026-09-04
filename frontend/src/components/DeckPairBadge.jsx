import React from 'react';
import { useTranslation } from 'react-i18next';
import { getLanguage } from '../languages';

export function PairIcon({ className = '', size = 12 }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 7h12m0 0l-4-4m4 4l-4 4" />
      <path d="M16 17H4m0 0l4-4m-4 4l4 4" />
    </svg>
  );
}

export function DeckPairBadge({
  deck,
  languageFrom,
  languageTo,
  showLabel = true,
  className = '',
  size = 12,
}) {
  const { t } = useTranslation();
  const l1 = languageFrom ?? deck?.language_from ?? 'es';
  const l2 = languageTo ?? deck?.language_to ?? 'en';

  const l1Lang = getLanguage(l1);
  const l2Lang = getLanguage(l2);
  const l1Name = l1Lang?.name ?? l1;
  const l2Name = l2Lang?.name ?? l2;

  const tooltip = t('deck.pair_badge_tooltip', { from: l1Name, to: l2Name });
  const label = `${String(l1).toUpperCase()} → ${String(l2).toUpperCase()}`;

  return (
    <span
      className={`deck-type-badge deck-type-badge--pair ${className}`.trim()}
      title={tooltip}
      aria-label={tooltip}
    >
      <PairIcon size={size} />
      {showLabel && <span>{label}</span>}
    </span>
  );
}

export default DeckPairBadge;
