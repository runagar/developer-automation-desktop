export interface HorizontalSpan {
  left: number;
  right: number;
}

/** Absorbs sub-pixel rounding between a tab's edges and the strip's. */
export const EDGE_TOLERANCE = 0.5;

export function isFullyVisible(tab: HorizontalSpan, viewport: HorizontalSpan): boolean {
  return tab.left >= viewport.left - EDGE_TOLERANCE && tab.right <= viewport.right + EDGE_TOLERANCE;
}

export function firstIndexToReveal(
  firstIndex: number,
  activeIndex: number,
  naturalWidths: number[],
  stripWidth: number,
): number {
  if (activeIndex < firstIndex) return activeIndex;
  let right = naturalWidths.slice(0, activeIndex - firstIndex + 1).reduce((sum, width) => sum + width, 0);
  let index = firstIndex;
  while (right > stripWidth + EDGE_TOLERANCE && index < activeIndex) {
    right -= naturalWidths[index - firstIndex];
    index++;
  }
  return index;
}

export function activeTabCap(left: number, naturalWidth: number, stripWidth: number): number | null {
  if (left >= stripWidth) return null;
  if (left + naturalWidth <= stripWidth + EDGE_TOLERANCE) return null;
  return Math.floor(stripWidth - left);
}
