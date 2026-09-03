import { useLayoutEffect } from 'react';

/** Monotonic source for the unique anchor names generated below. */
let anchorSeq = 0;

/**
 * The Popover API shipped in Chromium 114 but is missing from the DOM types
 * bundled with TypeScript 5.0. Declared narrowly here rather than bumping the
 * compiler for two methods; remove once the toolchain provides them.
 */
interface PopoverElement extends HTMLElement {
  showPopover(): void;
  hidePopover(): void;
}

interface TopLayerOptions {
  /**
   * Anchor the menu to its DOM parent so CSS `anchor()` can position it.
   * Pass `false` for menus that position themselves with explicit viewport
   * coordinates (context menus opened at the pointer).
   */
  anchorToParent?: boolean;
}

/**
 * Promotes a menu element into the browser's top layer for as long as it is
 * mounted, so it paints above every panel.
 *
 * `WorkspacePanel` sets `z-index` on each `.workspace-panel`, which makes every
 * panel its own stacking context. A menu rendered inside a panel is therefore
 * clamped to that panel's context and can never out-stack a *sibling* panel by
 * raising its own `z-index` — no value is large enough. The top layer sits
 * above all stacking contexts, so this is the only fix that always holds.
 *
 * Two properties of the Popover API make this safe to apply to existing menus:
 *
 * - `popover="manual"` adds no light-dismiss and no Esc handling of its own,
 *   so each menu keeps the open/close logic it already had.
 * - A popover keeps its position in the DOM and is only *painted* elsewhere,
 *   so `wrapper.contains(event.target)` click-outside checks, event bubbling,
 *   and inherited theme variables all keep working.
 */
export function useTopLayer(
  ref: React.RefObject<HTMLElement | null>,
  { anchorToParent = true }: TopLayerOptions = {},
): void {
  useLayoutEffect(() => {
    const el = ref.current as PopoverElement | null;
    if (!el) return;

    // Set imperatively rather than as a JSX prop: React 18 does not know the
    // `popover` attribute, and this keeps the contract inside the hook.
    el.setAttribute('popover', 'manual');

    const anchor = anchorToParent ? el.parentElement : null;
    const anchorName = `--dad-menu-anchor-${++anchorSeq}`;
    if (anchor) {
      anchor.style.setProperty('anchor-name', anchorName);
      el.style.setProperty('position-anchor', anchorName);
    }

    // showPopover() throws if the element is already in the top layer.
    if (!el.matches(':popover-open')) el.showPopover();

    return () => {
      if (el.isConnected && el.matches(':popover-open')) el.hidePopover();
      anchor?.style.removeProperty('anchor-name');
    };
  }, [ref, anchorToParent]);
}
