import { describe, it, expect } from 'vitest';
import {
  ACTIVE_MS,
  TERMINAL_MS,
  VaultNoteMeta,
  isStale,
  tierForCategory,
} from './vaultFreshness';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

/** Build note metadata stamped `msAgo` before NOW. */
function meta(category: string | null, msAgo: number): VaultNoteMeta {
  return {
    statusCategory: category,
    fetched: new Date(NOW - msAgo).toISOString(),
  };
}

describe('tierForCategory', () => {
  it('maps the three categories in use', () => {
    expect(tierForCategory('done')).toBe('terminal');
    expect(tierForCategory('indeterminate')).toBe('active');
    expect(tierForCategory('new')).toBe('always');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(tierForCategory('  DONE  ')).toBe('terminal');
    expect(tierForCategory('Indeterminate')).toBe('active');
  });

  it("treats Jira's fourth key `undefined` as always-refetch", () => {
    // A status with no category says nothing about whether the issue is active.
    expect(tierForCategory('undefined')).toBe('always');
  });

  it('treats a missing category as always-refetch', () => {
    expect(tierForCategory(null)).toBe('always');
    expect(tierForCategory(undefined)).toBe('always');
    expect(tierForCategory('')).toBe('always');
  });

  it('never lets an unrecognised category inherit the longest tier', () => {
    // The one failure mode that is silent in production: guessing `terminal`
    // would hide a stale note for a month with no signal.
    expect(tierForCategory('a-category-atlassian-added-later')).toBe('always');
  });
});

describe('isStale', () => {
  it('treats a missing note as stale', () => {
    expect(isStale(null, NOW)).toBe(true);
  });

  it('treats a null fetched (legacy note) as expired', () => {
    expect(isStale({ statusCategory: 'done', fetched: null }, NOW)).toBe(true);
  });

  it('treats an unparseable fetched as expired', () => {
    expect(isStale({ statusCategory: 'done', fetched: 'not a date' }, NOW)).toBe(true);
  });

  it('rejects a timestamp with no timezone', () => {
    // Date.parse would read this as local time, so the age would shift by the
    // offset. Only hand-edited notes can produce it.
    expect(isStale({ statusCategory: 'done', fetched: '2026-09-10T11:00:00' }, NOW)).toBe(true);
  });

  it('accepts a numeric offset as well as Z', () => {
    expect(isStale({ statusCategory: 'done', fetched: '2026-09-10T13:00:00+01:00' }, NOW)).toBe(false);
  });

  it('treats a stamp from the future as stale', () => {
    // A clock briefly set forward would otherwise read as fresh for a month.
    const future = new Date(NOW + 60 * 60_000).toISOString();
    expect(isStale({ statusCategory: 'done', fetched: future }, NOW)).toBe(true);
  });

  it('tolerates trivial clock skew', () => {
    const barelyAhead = new Date(NOW + 5_000).toISOString();
    expect(isStale({ statusCategory: 'done', fetched: barelyAhead }, NOW)).toBe(false);
  });

  it('always refetches the `new` category however recent the note', () => {
    expect(isStale(meta('new', 1_000), NOW)).toBe(true);
  });

  it('always refetches an unrecognised category however recent the note', () => {
    expect(isStale(meta('undefined', 1_000), NOW)).toBe(true);
  });

  it('keeps an active note inside the 8 hour window', () => {
    expect(isStale(meta('indeterminate', ACTIVE_MS - 60_000), NOW)).toBe(false);
  });

  it('refetches an active note past the 8 hour window', () => {
    expect(isStale(meta('indeterminate', ACTIVE_MS + 60_000), NOW)).toBe(true);
  });

  it('keeps a terminal note inside the 30 day window', () => {
    expect(isStale(meta('done', TERMINAL_MS - 60_000), NOW)).toBe(false);
  });

  it('refetches a terminal note past the 30 day window', () => {
    expect(isStale(meta('done', TERMINAL_MS + 60_000), NOW)).toBe(true);
  });

  it('does not refetch exactly at the boundary', () => {
    // Strictly greater than the window, matching archivePolicy's convention.
    expect(isStale(meta('done', TERMINAL_MS), NOW)).toBe(false);
    expect(isStale(meta('indeterminate', ACTIVE_MS), NOW)).toBe(false);
  });

  it('applies the terminal window to Closed as well as Done', () => {
    // Both map to the `done` category despite being different workflows.
    expect(isStale(meta('done', 20 * 24 * 60 * 60 * 1000), NOW)).toBe(false);
  });
});
