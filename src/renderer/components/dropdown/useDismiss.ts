import { RefObject, useEffect, useRef } from 'react';
import { useEscape } from '../../hooks/useEscape';

/**
 * Close a popover on an outside click or Escape.
 *
 * `containerRef` must wrap **both** the trigger and the popover. Watching the
 * popover alone is the classic trap: `mousedown` on the trigger would close
 * the menu, and the trigger's own `click` would then immediately reopen it,
 * so it would appear never to close.
 *
 * `close` is held in a ref, so callers may pass an inline arrow without the
 * listeners being torn down and re-registered on every render.
 */
export function useDismiss(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void
): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEscape(open, close);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(e: MouseEvent): void {
      if (!containerRef.current?.contains(e.target as Node)) closeRef.current();
    }

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, containerRef]);
}
