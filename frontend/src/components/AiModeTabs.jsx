// Segmented mode switcher rendered at the top of AI workflow pages:
// /decks/new ("Build a new deck") vs /decks/complete ("Complete a deck").
//
// Kept as direct Link tabs (rather than a dropdown on the home CTA):
// deep-linkable, keyboard accessible, mobile friendly, and state-preserving.

import { Link, useLocation } from 'react-router-dom';

export default function AiModeTabs() {
  const location = useLocation();
  const isComplete = location.pathname.startsWith('/decks/complete');

  return (
    <nav className="ai-tabs ai-mode-tabs" aria-label="AI Mode Navigation">
      <Link
        to="/decks/new"
        className={`ai-tab ${!isComplete ? 'ai-tab--active' : ''}`}
        aria-current={!isComplete ? 'page' : undefined}
      >
        Build a new deck
      </Link>
      <Link
        to="/decks/complete"
        className={`ai-tab ${isComplete ? 'ai-tab--active' : ''}`}
        aria-current={isComplete ? 'page' : undefined}
      >
        Complete a deck
      </Link>
    </nav>
  );
}
