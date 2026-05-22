import React, { useState, useEffect, useRef } from 'react';
import './ThemeSelector.css';

export interface Theme {
  id: string;
  label: string;
}

const THEMES: Theme[] = [
  { id: 'pipboy-3000',  label: 'Pip-boy 3000'  },
  { id: 'pipboy-3000a', label: 'Pip-boy 3000a' },
];

const STORAGE_KEY = 'agent-smith-theme';
const DEFAULT_THEME = 'pipboy-3000';

function applyTheme(id: string): void {
  if (id === DEFAULT_THEME) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', id);
  }
}

export function initTheme(): void {
  const saved = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME;
  applyTheme(saved);
}

export default function ThemeSelector(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME
  );
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function select(id: string): void {
    setCurrent(id);
    localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
    setOpen(false);
  }

  const currentLabel = THEMES.find((t) => t.id === current)?.label ?? current;

  return (
    <div className="theme-selector" ref={ref}>
      <button
        className="theme-selector__btn"
        onClick={() => setOpen((v) => !v)}
        title="Switch theme"
      >
        <span className="theme-selector__icon">◈</span>
        <span className="theme-selector__label">{currentLabel}</span>
        <span className="theme-selector__caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <ul className="theme-selector__menu">
          {THEMES.map((t) => (
            <li key={t.id}>
              <button
                className={`theme-selector__item${t.id === current ? ' theme-selector__item--active' : ''}`}
                onClick={() => select(t.id)}
              >
                {t.id === current && <span className="theme-selector__check">✔</span>}
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
