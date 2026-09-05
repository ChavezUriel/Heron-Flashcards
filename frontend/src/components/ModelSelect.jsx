import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEL_TIERS } from '../ai/providers';

/**
 * ModelSelect - Advanced combobox and dropdown for AI model selection.
 *
 * Supports:
 * - Freeform model entry (custom model names)
 * - Real-time filtering / search
 * - Provider suggested models & API fetched models
 * - Default & tier badges
 * - Keyboard navigation (Arrows, Enter, Escape, Tab)
 * - Custom scrollable menu with backdrop / click-outside handling
 */
export default function ModelSelect({
  value,
  onChange,
  suggestedModels = [],
  models = null,
  defaultModel = '',
  providerId = '',
  placeholder = '',
  disabled = false,
  onLoadModels,
  modelsLoading = false,
  hasKey = false,
}) {
  const { t } = useTranslation();
  const id = useId();
  const listboxId = `${id}-listbox`;

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [hasTypedQuery, setHasTypedQuery] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [placement, setPlacement] = useState('bottom');

  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listboxRef = useRef(null);

  // Sync internal search input with value when closed
  useEffect(() => {
    if (!isOpen) {
      setSearch(value || '');
      setHasTypedQuery(false);
    }
  }, [value, isOpen]);

  // Combined options: suggested + fetched
  const allModels = useMemo(() => {
    const list = [...new Set([...(suggestedModels ?? []), ...(models ?? [])])];
    if (value && !list.includes(value)) {
      list.unshift(value);
    }
    return list;
  }, [models, suggestedModels, value]);

  // Filtered options based on user input
  const filteredModels = useMemo(() => {
    if (!hasTypedQuery) return allModels;
    const q = search.trim().toLowerCase();
    if (!q) return allModels;
    return allModels.filter((m) => m.toLowerCase().includes(q));
  }, [allModels, hasTypedQuery, search]);

  const hasExactMatch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return allModels.some((m) => m.toLowerCase() === q);
  }, [allModels, search]);

  // Option list including a "custom model" option if user types something new
  const visibleOptions = useMemo(() => {
    const q = search.trim();
    const items = [];

    // If active query doesn't match any model in the list, offer it as a custom model option
    if (hasTypedQuery && q && !hasExactMatch) {
      items.push({
        type: 'custom',
        value: q,
        label: q,
      });
    }

    filteredModels.forEach((m) => {
      items.push({
        type: 'model',
        value: m,
        label: m,
        isDefault: m === defaultModel,
        tier: MODEL_TIERS[m] || (m.includes('lite') || m.includes('nano') ? 'tier2' : 'tier1'),
        isSuggested: (suggestedModels ?? []).includes(m),
      });
    });

    return items;
  }, [search, hasTypedQuery, hasExactMatch, filteredModels, defaultModel, suggestedModels]);

  // Position detection (flip to top if near bottom)
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < 250 && spaceAbove > spaceBelow) {
      setPlacement('top');
    } else {
      setPlacement('bottom');
    }
  }, [isOpen]);

  // Click outside to close and commit typed value
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        commitCurrentInput();
        setIsOpen(false);
        setHasTypedQuery(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen, search]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0 || !listboxRef.current) return;
    const items = listboxRef.current.querySelectorAll('[role="option"]');
    const target = items[highlightedIndex];
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, isOpen]);

  function commitCurrentInput() {
    const nextVal = search.trim() || defaultModel;
    if (nextVal !== value) {
      onChange(nextVal);
    }
    setSearch(nextVal);
    setHasTypedQuery(false);
  }

  function handleSelectOption(option) {
    onChange(option.value);
    setSearch(option.value);
    setHasTypedQuery(false);
    setIsOpen(false);
    inputRef.current?.focus();
  }

  function handleInputChange(event) {
    const nextText = event.target.value;
    setSearch(nextText);
    setHasTypedQuery(true);
    if (!isOpen) setIsOpen(true);
    setHighlightedIndex(0);
    onChange(nextText);
  }

  function handleClear(event) {
    event.stopPropagation();
    onChange('');
    setSearch('');
    setHasTypedQuery(true);
    inputRef.current?.focus();
    if (!isOpen) setIsOpen(true);
    setHighlightedIndex(0);
  }

  function handleToggleOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    if (isOpen) {
      commitCurrentInput();
      setIsOpen(false);
    } else {
      setIsOpen(true);
      setHasTypedQuery(false);
      const currentIndex = visibleOptions.findIndex((o) => o.value === value);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(event) {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          const idx = visibleOptions.findIndex((o) => o.value === value);
          setHighlightedIndex(idx >= 0 ? idx : 0);
        } else {
          setHighlightedIndex((prev) =>
            prev + 1 < visibleOptions.length ? prev + 1 : prev
          );
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          const idx = visibleOptions.findIndex((o) => o.value === value);
          setHighlightedIndex(idx >= 0 ? idx : visibleOptions.length - 1);
        } else {
          setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : 0));
        }
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (isOpen && highlightedIndex >= 0 && highlightedIndex < visibleOptions.length) {
          handleSelectOption(visibleOptions[highlightedIndex]);
        } else {
          commitCurrentInput();
          setIsOpen(false);
        }
        break;
      }
      case 'Escape': {
        if (isOpen) {
          event.preventDefault();
          setSearch(value || '');
          setHasTypedQuery(false);
          setIsOpen(false);
        }
        break;
      }
      case 'Tab': {
        if (isOpen) {
          commitCurrentInput();
          setIsOpen(false);
        }
        break;
      }
      default:
        break;
    }
  }

  return (
    <div
      ref={containerRef}
      className={`model-select${isOpen ? ' model-select--open' : ''}${
        disabled ? ' model-select--disabled' : ''
      }`}
    >
      <div
        className={`model-select__control${isOpen ? ' model-select__control--focused' : ''}`}
        onClick={() => {
          if (!isOpen && !disabled) {
            setIsOpen(true);
            setHasTypedQuery(false);
            const idx = visibleOptions.findIndex((o) => o.value === value);
            setHighlightedIndex(idx >= 0 ? idx : 0);
            inputRef.current?.focus();
          }
        }}
      >
        <span className="model-select__icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
          </svg>
        </span>

        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={handleInputChange}
          onFocus={() => {
            if (!isOpen) {
              setIsOpen(true);
              setHasTypedQuery(false);
              const idx = visibleOptions.findIndex((o) => o.value === value);
              setHighlightedIndex(idx >= 0 ? idx : 0);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || defaultModel}
          disabled={disabled}
          autoComplete="off"
          spellCheck="false"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          className="model-select__input"
        />

        {/* Action pills & buttons on the right side of the control */}
        <div className="model-select__actions">
          {search && (
            <button
              type="button"
              className="model-select__clear"
              onClick={handleClear}
              aria-label="Clear input"
              title="Clear input"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className="model-select__chevron-btn"
            onClick={handleToggleOpen}
            aria-label={isOpen ? 'Close model menu' : 'Open model menu'}
            tabIndex={-1}
          >
            <svg
              className={`model-select__chevron${isOpen ? ' model-select__chevron--open' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className={`model-select__menu model-select__menu--${placement}`}
        >
          <div className="model-select__menu-header">
            <span className="model-select__count">
              {visibleOptions.filter((o) => o.type === 'model').length}{' '}
              {t('provider.models_count_label', { defaultValue: 'available models' })}
            </span>
            {hasKey && onLoadModels && (
              <button
                type="button"
                className="ai-link model-select__load-link"
                onClick={onLoadModels}
                disabled={modelsLoading}
              >
                {modelsLoading
                  ? t('provider.loading_models', { defaultValue: 'Loading…' })
                  : t('provider.refresh_models', { defaultValue: 'Refresh from API' })}
              </button>
            )}
          </div>

          <div className="model-select__list">
            {visibleOptions.length === 0 ? (
              <div className="model-select__empty">
                {t('provider.no_models_found', { defaultValue: 'No models found matching your search.' })}
              </div>
            ) : (
              visibleOptions.map((opt, index) => {
                const isSelected = opt.value === value;
                const isHighlighted = index === highlightedIndex;

                if (opt.type === 'custom') {
                  return (
                    <div
                      key="custom-model-entry"
                      role="option"
                      aria-selected={false}
                      className={`model-select__option model-select__option--custom${
                        isHighlighted ? ' model-select__option--highlighted' : ''
                      }`}
                      onClick={() => handleSelectOption(opt)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                    >
                      <div className="model-select__option-left">
                        <span className="model-select__custom-icon" aria-hidden="true">
                          +
                        </span>
                        <div>
                          <div className="model-select__custom-label">
                            {t('provider.model_custom_tag', { defaultValue: 'Use custom model' })}
                          </div>
                          <div className="model-select__name font-mono">{opt.value}</div>
                        </div>
                      </div>
                      <span className="st-chip st-chip--compact">Custom</span>
                    </div>
                  );
                }

                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    className={`model-select__option${isSelected ? ' model-select__option--selected' : ''}${
                      isHighlighted ? ' model-select__option--highlighted' : ''
                    }`}
                    onClick={() => handleSelectOption(opt)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  >
                    <div className="model-select__option-left">
                      <span className="model-select__name font-mono">{opt.value}</span>
                    </div>

                    <div className="model-select__option-badges">
                      {opt.isDefault && (
                        <span className="st-chip st-chip--compact model-select__badge-default">
                          {t('provider.model_default_badge', { defaultValue: 'Default' })}
                        </span>
                      )}
                      {opt.tier && (
                        <span
                          className={`st-chip st-chip--compact ${
                            opt.tier === 'tier1' ? 'st-chip--accent' : 'st-chip--muted'
                          }`}
                        >
                          {opt.tier === 'tier1' ? 'Tier 1' : 'Tier 2'}
                        </span>
                      )}
                      {isSelected && (
                        <svg
                          className="model-select__check"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
