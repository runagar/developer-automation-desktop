import { useEffect, useRef } from 'react';

/**
 * Run a handler when Escape is pressed, while `active`.
 *
 * Listens in the **capture** phase and stops propagation, so the key is
 * consumed by the thing that is actually on top: a dialog or popover should
 * swallow Escape rather than let it reach panel-level key handling behind it.
 *
 * The handler is held in a ref, so callers may pass an inline arrow without
 * the listener being torn down and re-registered on every render.
 */
export function useEscape(active: boolean, onEscape: () => void): void {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      handlerRef.current();
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
