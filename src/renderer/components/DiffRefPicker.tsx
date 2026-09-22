import React, { useCallback, useRef, useState } from 'react';
import { DiffRefOption } from '../stores/githubStore';
import { PrDiffRef } from '../../main/types';
import { Dropdown, useDismiss } from './dropdown';
import { cn } from '../utils/cn';

interface Props {
  options: DiffRefOption[];
  /** Key of the option currently shown. */
  activeKey: string;
  onSelect: (ref: PrDiffRef) => void;
}

/**
 * Which diff to show: the whole pull request, a force-push range, or one
 * commit.
 *
 * A custom dropdown rather than a `<select>`: commit subjects are long, and a
 * native `<option>` can neither be ellipsised nor carry a tooltip, so the
 * browser either widens the list past the panel or clips it with no way to
 * read the rest.
 */
export default function DiffRefPicker({ options, activeKey, onSelect }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useDismiss(containerRef, open, close);

  const active = options.find((o) => o.key === activeKey) ?? options[0];

  return (
    <div ref={containerRef} className="pr-diff__ref">
      <button
        className="pr-diff__ref-trigger"
        title={active?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pr-diff__ref-label">{active?.label ?? ''}</span>
        <span className="pr-diff__ref-caret">▾</span>
      </button>

      {open && (
        <Dropdown className="pr-diff__ref-menu">
          {options.map((option) => (
            <button
              key={option.key}
              className={cn('pr-diff__ref-option', option.key === activeKey && 'pr-diff__ref-option--active')}
              // The full subject, for anything the row had to clip.
              title={option.label}
              disabled={option.ref === null}
              onClick={() => {
                if (!option.ref) return;
                close();
                onSelect(option.ref);
              }}
            >
              {option.label}
            </button>
          ))}
        </Dropdown>
      )}
    </div>
  );
}
