import { RefObject, useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Intra-panel Tab wrapping. Plain Tab / Shift+Tab cycles focusable elements
 * within the panel and wraps at the ends — it never crosses into another panel
 * (cross-panel movement is exclusively Ctrl+Tab, handled by Workspace).
 *
 * Native Tab already only moves within the focused context, so this hook only
 * needs to wrap at the first/last focusable element. It does nothing unless the
 * focus is already inside the panel, which satisfies the "focus-gated" rule.
 */
export function usePanelFocus(containerRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;

      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((n) => n.offsetParent !== null);

      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      // otherwise let native Tab move within the panel
    };

    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [containerRef]);
}
