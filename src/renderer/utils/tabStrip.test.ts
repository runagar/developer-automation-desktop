import { describe, it, expect } from 'vitest';
import { activeTabCap, firstIndexToReveal, isFullyVisible } from './tabStrip';

describe('isFullyVisible', () => {
  const viewport = { left: 100, right: 300 };

  it('accepts a tab inside the viewport, edges included', () => {
    // Given
    const tab = { left: 100, right: 300 };
    // When
    const visible = isFullyVisible(tab, viewport);
    // Then
    expect(visible).toBe(true);
  });

  it('rejects a tab cut off at either edge', () => {
    // Given
    const cutLeft = { left: 90, right: 150 };
    const cutRight = { left: 250, right: 310 };
    // When
    const visible = [isFullyVisible(cutLeft, viewport), isFullyVisible(cutRight, viewport)];
    // Then
    expect(visible).toEqual([false, false]);
  });

  it('rejects a tab scrolled entirely out of view', () => {
    // Given
    const tab = { left: 320, right: 400 };
    // When
    const visible = isFullyVisible(tab, viewport);
    // Then
    expect(visible).toBe(false);
  });

  it('tolerates sub-pixel overshoot from rounding', () => {
    // Given
    const tab = { left: 99.7, right: 300.3 };
    // When
    const visible = isFullyVisible(tab, viewport);
    // Then
    expect(visible).toBe(true);
  });
});

describe('firstIndexToReveal', () => {
  const widths = [100, 80, 120, 60];

  it('keeps the first tab when the active tab already fits', () => {
    // Given
    const stripWidth = 300;
    // When
    const first = firstIndexToReveal(0, 2, widths.slice(0, 3), stripWidth);
    // Then
    expect(first).toBe(0);
  });

  it('jumps back to an active tab hidden on the left', () => {
    // Given
    const firstIndex = 3;
    // When
    const first = firstIndexToReveal(firstIndex, 1, [], 300);
    // Then
    expect(first).toBe(1);
  });

  it('hides whole tabs on the left until the active tab ends inside the strip', () => {
    // Given
    const stripWidth = 250;
    // When
    const first = firstIndexToReveal(0, 3, widths, stripWidth);
    // Then
    expect(first).toBe(2);
  });

  it('stops at the active tab when it is wider than the strip on its own', () => {
    // Given
    const stripWidth = 100;
    // When
    const first = firstIndexToReveal(0, 2, widths.slice(0, 3), stripWidth);
    // Then
    expect(first).toBe(2);
  });
});

describe('activeTabCap', () => {
  it('leaves a tab that fits uncapped', () => {
    // Given
    const left = 100;
    // When
    const cap = activeTabCap(left, 150, 300);
    // Then
    expect(cap).toBeNull();
  });

  it('caps a tab running past the right edge to the room left after it starts', () => {
    // Given
    const left = 180;
    // When
    const cap = activeTabCap(left, 300, 300.6);
    // Then
    expect(cap).toBe(120);
  });

  it('leaves a tab starting beyond the right edge alone', () => {
    // Given
    const left = 300;
    // When
    const cap = activeTabCap(left, 80, 300);
    // Then
    expect(cap).toBeNull();
  });
});
