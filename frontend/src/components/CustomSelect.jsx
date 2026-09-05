import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * CustomSelect - Accessible, styled replacement for native <select>
 *
 * Props:
 * - value: string | number | null
 * - onChange: (value: any, option?: any) => void
 * - options: Array<{ value: any, label: React.ReactNode, sublabel?: string, badge?: string, disabled?: boolean } | string | number>
 * - placeholder?: string
 * - disabled?: boolean
 * - id?: string
 * - name?: string
 * - className?: string
 * - ariaLabel?: string
 */
export default function CustomSelect({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  disabled = false,
  id: explicitId,
  name,
  className = '',
  ariaLabel,
}) {
  const generatedId = useId();
  const selectId = explicitId || generatedId;
  const listboxId = `${selectId}-listbox`;

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [placement, setPlacement] = useState('bottom');

  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const listboxRef = useRef(null);

  // Normalize options into a standard shape
  const normalizedOptions = useMemo(() => {
    return options.map((opt) => {
      if (opt !== null && typeof opt === 'object' && 'value' in opt) {
        return {
          value: opt.value,
          label: opt.label ?? String(opt.value),
          sublabel: opt.sublabel ?? null,
          badge: opt.badge ?? null,
          disabled: Boolean(opt.disabled),
        };
      }
      return {
        value: opt,
        label: String(opt),
        sublabel: null,
        badge: null,
        disabled: false,
      };
    });
  }, [options]);

  const selectedIndex = normalizedOptions.findIndex(
    (opt) => String(opt.value) === String(value)
  );
  const selectedOption = selectedIndex >= 0 ? normalizedOptions[selectedIndex] : null;

  // Position detection (flip to top if close to bottom of screen)
  useEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < 220 && spaceAbove > spaceBelow) {
      setPlacement('top');
    } else {
      setPlacement('bottom');
    }
  }, [isOpen]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0 || !listboxRef.current) return;
    const items = listboxRef.current.querySelectorAll('[role="option"]');
    const target = items[highlightedIndex];
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, isOpen]);

  function handleSelect(opt) {
    if (opt.disabled) return;
    setIsOpen(false);
    if (onChange) {
      const syntheticEvent = {
        target: { value: opt.value, name, id: selectId },
        currentTarget: { value: opt.value, name, id: selectId },
      };
      onChange(opt.value, syntheticEvent);
    }
    triggerRef.current?.focus();
  }

  function handleTriggerClick() {
    if (disabled) return;
    if (isOpen) {
      setIsOpen(false);
    } else {
      setIsOpen(true);
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }

  function handleKeyDown(event) {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
        } else {
          setHighlightedIndex((prev) => {
            let next = prev + 1;
            while (next < normalizedOptions.length && normalizedOptions[next].disabled) {
              next += 1;
            }
            return next < normalizedOptions.length ? next : prev;
          });
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : normalizedOptions.length - 1);
        } else {
          setHighlightedIndex((prev) => {
            let next = prev - 1;
            while (next >= 0 && normalizedOptions[next].disabled) {
              next -= 1;
            }
            return next >= 0 ? next : prev;
          });
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
        } else if (highlightedIndex >= 0 && highlightedIndex < normalizedOptions.length) {
          handleSelect(normalizedOptions[highlightedIndex]);
        }
        break;
      }
      case 'Escape': {
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
          triggerRef.current?.focus();
        }
        break;
      }
      case 'Tab': {
        if (isOpen) {
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
      className={`st-select-wrapper ${className}${disabled ? ' st-select-wrapper--disabled' : ''}`}
    >
      <button
        ref={triggerRef}
        id={selectId}
        type="button"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        className={`st-select__trigger${isOpen ? ' st-select__trigger--open' : ''}${
          !selectedOption ? ' st-select__trigger--placeholder' : ''
        }`}
        onClick={handleTriggerClick}
        onKeyDown={handleKeyDown}
      >
        <span className="st-select__label">
          {selectedOption ? (
            <>
              <span className="st-select__text">{selectedOption.label}</span>
              {selectedOption.sublabel && (
                <span className="st-select__sublabel">{selectedOption.sublabel}</span>
              )}
              {selectedOption.badge && (
                <span className="st-chip st-chip--compact">{selectedOption.badge}</span>
              )}
            </>
          ) : (
            <span className="st-select__placeholder">{placeholder}</span>
          )}
        </span>

        <svg
          className="st-select__chevron"
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

      {isOpen && (
        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel || placeholder}
          className={`st-select__menu st-select__menu--${placement}`}
        >
          {normalizedOptions.length === 0 ? (
            <li className="st-select__empty" role="presentation">
              No options available
            </li>
          ) : (
            normalizedOptions.map((opt, index) => {
              const isSelected = String(opt.value) === String(value);
              const isHighlighted = index === highlightedIndex;
              return (
                <li
                  key={`${opt.value}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled}
                  className={`st-select__option${isSelected ? ' st-select__option--selected' : ''}${
                    isHighlighted ? ' st-select__option--highlighted' : ''
                  }${opt.disabled ? ' st-select__option--disabled' : ''}`}
                  onClick={() => handleSelect(opt)}
                  onMouseEnter={() => !opt.disabled && setHighlightedIndex(index)}
                >
                  <div className="st-select__option-content">
                    <span className="st-select__option-label">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="st-select__option-sublabel">{opt.sublabel}</span>
                    )}
                  </div>

                  <div className="st-select__option-meta">
                    {opt.badge && (
                      <span className="st-chip st-chip--compact">{opt.badge}</span>
                    )}
                    {isSelected && (
                      <svg
                        className="st-select__check"
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
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
