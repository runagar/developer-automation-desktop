import React, { useCallback, useRef, useState } from 'react';
import { Dropdown } from './Dropdown';
import { useDismiss } from './useDismiss';
import './SplitButton.css';

export interface SplitButtonOption {
  /** Stable identity, used for the default and as the React key. */
  id: string;
  label: string;
  /** Shown on the menu row when it needs more than its label. */
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface SplitButtonProps {
  options: SplitButtonOption[];
  /** Id of the option the label runs. Falls back to the first option. */
  defaultId: string;
  onDefaultChange: (id: string) => void;
  disabled?: boolean;
  /**
   * Tooltip for the whole control — both halves and the wrapper.
   *
   * Applied to the caret too: with only the default button carrying it, a
   * caller explaining *why* the action is unavailable would lose the
   * explanation the moment the pointer moved a few pixels right.
   */
  title?: string;
  /** Applied to the container. */
  className?: string;
  /** Applied to both halves, e.g. `btn--accent`. */
  buttonClassName?: string;
}

/**
 * A split button: a default action plus a menu.
 *
 * - Clicking the **label** runs the default option.
 * - Clicking the **arrow** opens the menu without running anything.
 * - Clicking a **row** runs that option and closes the menu.
 * - Clicking a row's **checkbox** makes it the default; it neither runs the
 *   option nor closes the menu, so the default can be changed and then
 *   immediately used.
 *
 * The checkbox is deliberately a separate hit target from the row: the two
 * gestures mean different things, and merging them would make "set as default"
 * impossible without also firing the action.
 */
export function SplitButton({
  options, defaultId, onDefaultChange, disabled, title, className, buttonClassName,
}: SplitButtonProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A stale default (an option removed since it was chosen) must not leave the
  // button dead; fall back to the first option.
  const active = options.find((o) => o.id === defaultId) ?? options[0];

  const close = useCallback(() => setOpen(false), []);

  useDismiss(containerRef, open, close);

  if (!active) return null;

  const run = (option: SplitButtonOption): void => {
    if (option.disabled) return;
    close();
    option.onSelect();
  };

  return (
    <div
      ref={containerRef}
      className={`split-button${className ? ` ${className}` : ''}`}
      // Also on the container: a disabled button fires no pointer events in
      // Chromium, so the tooltip has to come from an ancestor.
      title={title}
    >
      <button
        className={`btn btn--micro split-button__default${buttonClassName ? ` ${buttonClassName}` : ''}`}
        disabled={disabled || active.disabled}
        title={title ?? active.label}
        onClick={() => run(active)}
      >
        {active.label}
      </button>

      <button
        className={`btn btn--micro split-button__caret${buttonClassName ? ` ${buttonClassName}` : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title ?? 'More actions'}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>

      {open && (
        <Dropdown className="split-button__menu">
          {options.map((option) => (
            <div key={option.id} className="split-button__row">
              <button
                className="split-button__check"
                // Chromium focuses a clicked button regardless of tab index,
                // and this one sits inside a panel; letting focus escape
                // clears the panel's focus tracking and disables Tab nav.
                onMouseDown={(e) => e.preventDefault()}
                title={
                  option.id === active.id
                    ? `${option.label} is the default action`
                    : `Make ${option.label} the default action`
                }
                aria-pressed={option.id === active.id}
                onClick={() => onDefaultChange(option.id)}
              >
                {option.id === active.id ? '☑' : '☐'}
              </button>
              <button
                className="split-button__option"
                disabled={option.disabled}
                onClick={() => run(option)}
              >
                {option.label}
                {option.hint && <span className="split-button__hint">{option.hint}</span>}
              </button>
            </div>
          ))}
        </Dropdown>
      )}
    </div>
  );
}
