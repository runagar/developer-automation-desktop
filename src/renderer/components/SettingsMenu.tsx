import React, { useEffect, useRef, useState } from 'react';
import { ZoomControls } from './ZoomControl';
import { getCrtEffects, setCrtEffect, setAllCrtEffects, CrtEffectState } from './crtEffects';
import { Dropdown, DropdownItem, DropdownSection, DropdownSubmenu } from './dropdown';
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
  const ref = useRef<HTMLDivElement>(null);

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
        <Dropdown className="settings-menu__menu" onMouseDown={(e) => e.stopPropagation()}>
          <DropdownSection label="Display">
            <div className="dropdown__item settings-menu__zoom-row">
              <span className="dropdown__check"></span>
              <span className="settings-menu__zoom-label">Zoom</span>
              <ZoomControls onReset={closeMenu} />
            </div>
            <DropdownSubmenu
              label="Theme"
              open={themeOpen}
              onOpen={() => setThemeOpen(true)}
              onClose={() => setThemeOpen(false)}
            >
              {THEMES.map((t) => (
                <DropdownItem
                  key={t.id}
                  check={t.id === currentTheme ? '✓' : ' '}
                  onClick={() => selectTheme(t.id)}
                >
                  {t.label}
                </DropdownItem>
              ))}
            </DropdownSubmenu>
            <DropdownItem
              check={crtMasterIcon}
              className={crtMixed ? 'settings-menu__item--mixed' : undefined}
              onClick={toggleCrtMaster}
            >
              CRT Effects
            </DropdownItem>
            <DropdownItem check={crt.scanlines ? '✓' : '✕'} onClick={() => toggleCrt('scanlines')}>
              Scanlines
            </DropdownItem>
            <DropdownItem check={crt.sweep ? '✓' : '✕'} onClick={() => toggleCrt('sweep')}>
              Rolling Scan
            </DropdownItem>
            <DropdownItem check={crt.bloom ? '✓' : '✕'} onClick={() => toggleCrt('bloom')}>
              Bloom
            </DropdownItem>
          </DropdownSection>

          <DropdownSection label="Misc.">
            <DropdownItem onClick={() => { closeMenu(); onOpenWorkspaces(); }}>
              Workspaces
            </DropdownItem>
            <DropdownItem onClick={() => { closeMenu(); onOpenJira(); }}>
              Jira
            </DropdownItem>
            <DropdownItem onClick={() => { closeMenu(); onOpenNotes(); }}>
              Notes
            </DropdownItem>
          </DropdownSection>
        </Dropdown>
      )}
    </div>
  );
}
