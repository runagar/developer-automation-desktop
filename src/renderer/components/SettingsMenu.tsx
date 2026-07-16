import React, { useEffect, useRef, useState } from 'react';
import { ZoomControls } from './ZoomControl';
import { getCrtEffects, setCrtEffect, setAllCrtEffects, CrtEffectState } from './crtEffects';
import './SettingsMenu.css';

// Theme definitions (source of truth for theme IDs and labels)
export const THEMES = [
  { id: 'phosphor-green', label: 'Phosphor Green' },
  { id: 'amber-orange',   label: 'Amber Orange'   },
] as const;

const THEME_STORAGE_KEY = 'agent-smith-theme';
const DEFAULT_THEME = 'phosphor-green';

// Migration map for old theme IDs
const THEME_MIGRATION: Record<string, string> = {
  'pipboy-3000':  'phosphor-green',
  'pipboy-3000a': 'amber-orange',
};

function applyTheme(id: string): void {
  if (id === DEFAULT_THEME) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', id);
  }
}

function readTheme(): string {
  return localStorage.getItem(THEME_STORAGE_KEY) ?? DEFAULT_THEME;
}

/** Apply saved theme on startup, migrating old IDs if needed. */
export function initTheme(): void {
  let saved = readTheme();
  if (THEME_MIGRATION[saved]) {
    saved = THEME_MIGRATION[saved];
    localStorage.setItem(THEME_STORAGE_KEY, saved);
  }
  applyTheme(saved);
}

interface Props {
  onOpenWorkspaces: () => void;
  onOpenJira: () => void;
  onOpenNotes: () => void;
}

export default function SettingsMenu({ onOpenWorkspaces, onOpenJira, onOpenNotes }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<string>(readTheme);
  const [crt, setCrt] = useState<CrtEffectState>(getCrtEffects);
  const [themeOpenLeft, setThemeOpenLeft] = useState(false);
  const [themeMeasured, setThemeMeasured] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const themeSubRef = useRef<HTMLUListElement>(null);

  // Close dropdown(s) on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setThemeOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Close theme sub-dropdown when main dropdown closes
  useEffect(() => {
    if (!open) setThemeOpen(false);
  }, [open]);

  // Detect if theme sub-dropdown overflows the right edge of the viewport.
  // Render hidden first, measure, then reveal in the correct position.
  useEffect(() => {
    if (!themeOpen) {
      setThemeOpenLeft(false);
      setThemeMeasured(false);
      return;
    }
    // Defer measurement to next frame so the element renders (hidden) at right position first
    requestAnimationFrame(() => {
      if (!themeSubRef.current) return;
      const rect = themeSubRef.current.getBoundingClientRect();
      setThemeOpenLeft(rect.right > window.innerWidth);
      setThemeMeasured(true);
    });
  }, [themeOpen]);

  function closeMenu(): void {
    setOpen(false);
    setThemeOpen(false);
  }

  function selectTheme(id: string): void {
    setCurrentTheme(id);
    localStorage.setItem(THEME_STORAGE_KEY, id);
    applyTheme(id);
    closeMenu();
  }

  function toggleCrt(effect: 'scanlines' | 'sweep' | 'bloom'): void {
    const next = !crt[effect];
    setCrtEffect(effect, next);
    setCrt((prev) => ({ ...prev, [effect]: next }));
  }

  // CRT master toggle logic
  const crtOnCount = [crt.scanlines, crt.sweep, crt.bloom].filter(Boolean).length;
  const crtAllOn = crtOnCount === 3;
  const crtAllOff = crtOnCount === 0;
  const crtMixed = !crtAllOn && !crtAllOff;

  function toggleCrtMaster(): void {
    // Most-different heuristic: toggle to the state that changes the most items.
    // If more are on → toggle all off; if more are off → toggle all on; tie → off.
    const targetOn = crtOnCount < (3 - crtOnCount);
    setAllCrtEffects(targetOn);
    setCrt({ scanlines: targetOn, sweep: targetOn, bloom: targetOn });
  }

  const crtMasterIcon = crtAllOn ? '✓' : crtAllOff ? '✕' : '−';

  return (
    <div className="settings-menu" ref={ref}>
      <button
        className="settings-menu__btn"
        onClick={() => setOpen((v) => !v)}
        title="Settings"
      >
        <span className="settings-menu__icon">⚙</span>
        <span className="settings-menu__label">SETTINGS</span>
        <span className="settings-menu__caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="settings-menu__dropdown" onMouseDown={(e) => e.stopPropagation()}>
          {/* ── Display ── */}
          <div className="settings-menu__header">Display</div>

          {/* Zoom controls */}
          <div className="settings-menu__zoom-row">
            <ZoomControls onReset={closeMenu} />
          </div>

          {/* Theme with sub-dropdown */}
          <div className="settings-menu__theme-row">
            <button
              className="settings-menu__item"
              onClick={() => setThemeOpen((v) => !v)}
            >
              Theme
              <span className="settings-menu__arrow">▸</span>
            </button>
            {themeOpen && (
              <ul
                ref={themeSubRef}
                className={`settings-menu__sub-dropdown${themeOpenLeft ? ' settings-menu__sub-dropdown--left' : ''}${!themeMeasured ? ' settings-menu__sub-dropdown--measuring' : ''}`}
              >
                {THEMES.map((t) => (
                  <li key={t.id}>
                    <button
                      className={`settings-menu__item${t.id === currentTheme ? ' settings-menu__item--active' : ''}`}
                      onClick={() => selectTheme(t.id)}
                    >
                      <span className="settings-menu__check">{t.id === currentTheme ? '✓' : ' '}</span>
                      {t.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* CRT Effects master toggle */}
          <button className="settings-menu__item settings-menu__item--toggle" onClick={toggleCrtMaster}>
            <span className={`settings-menu__check${crtMixed ? ' settings-menu__check--mixed' : ''}`}>{crtMasterIcon}</span>
            CRT Effects
          </button>

          {/* Scanlines toggle */}
          <button className="settings-menu__item settings-menu__item--toggle" onClick={() => toggleCrt('scanlines')}>
            <span className="settings-menu__check">{crt.scanlines ? '✓' : '✕'}</span>
            Scanlines
          </button>

          {/* Rolling Scan toggle */}
          <button className="settings-menu__item settings-menu__item--toggle" onClick={() => toggleCrt('sweep')}>
            <span className="settings-menu__check">{crt.sweep ? '✓' : '✕'}</span>
            Rolling Scan
          </button>

          {/* Bloom toggle */}
          <button className="settings-menu__item settings-menu__item--toggle" onClick={() => toggleCrt('bloom')}>
            <span className="settings-menu__check">{crt.bloom ? '✓' : '✕'}</span>
            Bloom
          </button>

          {/* ── Misc ── */}
          <div className="settings-menu__header">Misc.</div>

          <button
            className="settings-menu__item"
            onClick={() => { closeMenu(); onOpenWorkspaces(); }}
          >
            Workspaces
          </button>
          <button
            className="settings-menu__item"
            onClick={() => { closeMenu(); onOpenJira(); }}
          >
            Jira
          </button>
          <button
            className="settings-menu__item"
            onClick={() => { closeMenu(); onOpenNotes(); }}
          >
            Notes
          </button>
        </div>
      )}
    </div>
  );
}
