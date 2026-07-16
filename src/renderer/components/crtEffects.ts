export type CrtEffect = 'scanlines' | 'sweep' | 'bloom';

export interface CrtEffectState {
  scanlines: boolean;
  sweep: boolean;
  bloom: boolean;
}

const STORAGE_KEYS: Record<CrtEffect, string> = {
  scanlines: 'agent-smith-scanlines',
  sweep:     'agent-smith-sweep',
  bloom:     'agent-smith-bloom',
};

const CSS_CLASSES: Record<CrtEffect, string> = {
  scanlines: 'no-scanlines',
  sweep:     'no-sweep',
  bloom:     'no-bloom',
};

function readEffect(effect: CrtEffect): boolean {
  return localStorage.getItem(STORAGE_KEYS[effect]) !== 'off';
}

function applyClass(effect: CrtEffect, on: boolean): void {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  shell.classList.toggle(CSS_CLASSES[effect], !on);
}

/**
 * Apply saved CRT effect state to the DOM.
 * Safe to call before .app-shell exists — will no-op silently.
 * Should also be called once from App.tsx on mount.
 */
export function initCrtEffects(): void {
  for (const effect of Object.keys(STORAGE_KEYS) as CrtEffect[]) {
    applyClass(effect, readEffect(effect));
  }
}

export function getCrtEffects(): CrtEffectState {
  return {
    scanlines: readEffect('scanlines'),
    sweep:     readEffect('sweep'),
    bloom:     readEffect('bloom'),
  };
}

export function setCrtEffect(effect: CrtEffect, on: boolean): void {
  localStorage.setItem(STORAGE_KEYS[effect], on ? 'on' : 'off');
  applyClass(effect, on);
}

export function setAllCrtEffects(on: boolean): void {
  for (const effect of Object.keys(STORAGE_KEYS) as CrtEffect[]) {
    setCrtEffect(effect, on);
  }
}
