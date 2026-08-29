import React, { useEffect } from 'react';
import { TrashIcon } from './DeckOriginBadge';

function DeckDeleteModal({
  deck,
  isPending = false,
  onClose,
  onConfirm,
}) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape' && !isPending) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPending, onClose]);

  if (!deck) return null;

  const cardCount = deck.total_cards ?? (deck.cards?.length ?? 0);
  const cardText = `${cardCount} card${cardCount === 1 ? '' : 's'}`;

  return (
    <div
      className="details-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-deck-modal-title"
    >
      <button
        aria-label="Close dialog"
        className="details-modal__backdrop"
        type="button"
        disabled={isPending}
        onClick={onClose}
      />
      <div className="details-modal__panel details-modal__panel--confirm">
        <button
          aria-label="Close dialog"
          className="details-modal__close"
          type="button"
          disabled={isPending}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>

        <div className="details-modal__header">
          <p className="flashcard__label">Delete Deck</p>
          <h3 id="delete-deck-modal-title">Delete “{deck.title || deck.deck_title}”?</h3>
        </div>

        <div className="bulk-delete-dialog__body">
          <p>
            Are you sure you want to delete <strong>{deck.title || deck.deck_title}</strong>? All {cardText} and your study progress will be permanently deleted from your account.
          </p>
          <p className="bulk-delete-dialog__note">
            This action cannot be undone.
          </p>
        </div>

        <div className="details-modal__actions">
          <span />
          <div className="details-modal__actions-group">
            <button
              className="button button--secondary"
              type="button"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              className="button button--danger"
              type="button"
              onClick={() => onConfirm(deck)}
              disabled={isPending}
            >
              {isPending ? 'Deleting deck…' : 'Delete deck'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DeckDeleteModal;
