import { useEffect, useRef, useState } from 'react';
import { ToolTabId } from '../dashboard/layout';
import { useLayoutStore } from '../stores/layoutStore';

export type PollReason = 'activate' | 'interval';

/**
 * Run `onTick` while a given tool tab is the active one and the window has
 * focus: once on becoming active, then every `intervalMs`.
 *
 * Driven by the tab rather than by a panel, because panels can be closed,
 * hidden or replaced within a tab and the data should stay current regardless
 * of which of them happen to be open.
 *
 * Both conditions matter. Tool tabs never unmount their panels, so a timer
 * owned by a panel would keep running on every other tab; and polling while
 * DAD sits behind another window spends rate limit on data nobody is looking
 * at. Going inactive clears the timer, so a machine that slept for hours
 * performs exactly one catch-up tick rather than a backlog.
 *
 * The handler is held in a ref, as in `useEscape`, so callers may pass an
 * inline arrow without the timer being torn down and restarted every render.
 */
export function useTabPolling(
  tabId: ToolTabId, intervalMs: number, onTick: (reason: PollReason) => void
): void {
  const activeTab = useLayoutStore((s) => s.activeTab);
  const [focused, setFocused] = useState(() => document.hasFocus());

  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const active = activeTab === tabId && focused;

  useEffect(() => {
    if (!active) return undefined;

    // Whether this activation is due is the handler's call, not the timer's:
    // returning to the tab seconds after a manual refresh must not refetch.
    tickRef.current('activate');
    const timer = window.setInterval(() => tickRef.current('interval'), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
}
