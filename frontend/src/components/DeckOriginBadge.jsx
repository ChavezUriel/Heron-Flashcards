import React from 'react';

/**
 * Determine the origin classification for a deck:
 * - 'personal': Private standalone deck created by the user (or AI generated)
 * - 'public': Public market deck subscribed/cloned to the user's home
 * - 'managing': Market deck that the current user maintains/manages (as author/owner)
 */
export function getDeckOriginType(deck) {
  if (!deck) return 'personal';

  // If the backend already classified the deck, prioritize it
  if (deck.deck_type === 'personal' || deck.deck_type === 'public' || deck.deck_type === 'managing') {
    return deck.deck_type;
  }

  // If the deck is owned/maintained by the user on the market
  if (deck.is_owner || deck.is_managing) {
    return 'managing';
  }

  // If it's a clone/copy of a base market deck
  if (deck.base_deck_id != null) {
    return 'public';
  }

  // Otherwise, it's a personal standalone deck
  return 'personal';
}

export function PersonalIcon({ className = '', size = 13 }) {
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
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function PublicIcon({ className = '', size = 13 }) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

export function ManagingIcon({ className = '', size = 13 }) {
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
      <path d="M2 4l3 12h14l3-12-5 4-5-6-5 6-5-4z" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function TrashIcon({ className = '', size = 14 }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export const DECK_ORIGIN_CONFIG = {
  personal: {
    type: 'personal',
    label: 'Personal',
    shortLabel: 'Personal',
    scopeLabel: 'Personal deck',
    tooltip: 'Personal deck (private to your account)',
    icon: PersonalIcon,
    badgeClass: 'deck-type-badge--personal',
    chipClass: 'deck-scope-chip--personal',
  },
  public: {
    type: 'public',
    label: 'Public',
    shortLabel: 'Public',
    scopeLabel: 'Public · Market deck',
    tooltip: 'Public community deck added from Market',
    icon: PublicIcon,
    badgeClass: 'deck-type-badge--public',
    chipClass: 'deck-scope-chip--public',
  },
  managing: {
    type: 'managing',
    label: 'Managing',
    shortLabel: 'Managing',
    scopeLabel: 'Managing · Maintainer',
    tooltip: 'Deck you manage (you are the maintainer/author)',
    icon: ManagingIcon,
    badgeClass: 'deck-type-badge--managing',
    chipClass: 'deck-scope-chip--managing',
  },
};

export function DeckOriginIcon({ type, size = 13, className = '' }) {
  const normalizedType = type === 'market' ? 'public' : (type || 'personal');
  const config = DECK_ORIGIN_CONFIG[normalizedType] || DECK_ORIGIN_CONFIG.personal;
  const IconComponent = config.icon;
  return <IconComponent size={size} className={className} />;
}

export function DeckOriginBadge({
  type,
  deck,
  showLabel = true,
  className = '',
  size = 12,
}) {
  const resolvedType = type || getDeckOriginType(deck);
  const normalizedType = resolvedType === 'market' ? 'public' : resolvedType;
  const config = DECK_ORIGIN_CONFIG[normalizedType] || DECK_ORIGIN_CONFIG.personal;
  const IconComponent = config.icon;

  return (
    <span
      className={`deck-type-badge ${config.badgeClass} ${className}`.trim()}
      title={config.tooltip}
      aria-label={config.tooltip}
    >
      <IconComponent size={size} />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}

export default DeckOriginBadge;
