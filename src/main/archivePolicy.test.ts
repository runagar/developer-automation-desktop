import { describe, it, expect } from 'vitest';
import { selectDemotionCandidates, ArchivedRow } from './archivePolicy';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const MINUTE = 60_000;

/** Build a warm row archived `minutesAgo` minutes before NOW. */
function row(id: string, minutesAgo: number, state = 'idle'): ArchivedRow {
  return {
    id,
    state,
    archived_at: new Date(NOW - minutesAgo * MINUTE).toISOString(),
  };
}

describe('selectDemotionCandidates', () => {
  it('returns nothing for an empty input', () => {
    expect(selectDemotionCandidates([], NOW)).toEqual([]);
  });

  it('keeps a session warm inside the grace period', () => {
    expect(selectDemotionCandidates([row('a', 29)], NOW)).toEqual([]);
  });

  it('demotes a session past the grace period', () => {
    expect(selectDemotionCandidates([row('a', 31)], NOW)).toEqual(['a']);
  });

  it('does not demote exactly at the boundary', () => {
    // Strictly greater than the window, so 30m00s stays warm.
    expect(selectDemotionCandidates([row('a', 30)], NOW)).toEqual([]);
  });

  it('never demotes a busy session, however old', () => {
    const rows = [row('a', 600, 'running'), row('b', 600, 'awaiting')];
    expect(selectDemotionCandidates(rows, NOW)).toEqual([]);
  });

  it('demotes a previously busy session once it goes idle', () => {
    expect(selectDemotionCandidates([row('a', 600, 'idle')], NOW)).toEqual(['a']);
  });

  it('demotes suspended sessions (not considered busy)', () => {
    expect(selectDemotionCandidates([row('a', 31, 'suspended')], NOW)).toEqual(['a']);
  });

  it('treats a null archived_at (legacy row) as expired', () => {
    const legacy: ArchivedRow = { id: 'a', state: 'idle', archived_at: null };
    expect(selectDemotionCandidates([legacy], NOW)).toEqual(['a']);
  });

  it('treats an unparseable archived_at as expired', () => {
    const broken: ArchivedRow = { id: 'a', state: 'idle', archived_at: 'not-a-date' };
    expect(selectDemotionCandidates([broken], NOW)).toEqual(['a']);
  });

  it('enforces the warm cap even inside the grace period', () => {
    // Newest first; the 4th and beyond exceed ARCHIVE_WARM_MAX = 3.
    const rows = [row('a', 1), row('b', 2), row('c', 3), row('d', 4), row('e', 5)];
    expect(selectDemotionCandidates(rows, NOW)).toEqual(['d', 'e']);
  });

  it('does not count cold sessions against the cap', () => {
    // The caller passes warm rows only, so a single warm row inside its grace
    // period survives no matter how many cold rows exist alongside it.
    expect(selectDemotionCandidates([row('warm-one', 5)], NOW)).toEqual([]);
  });

  it('keeps a busy session warm even when it exceeds the cap', () => {
    const rows = [row('a', 1), row('b', 2), row('c', 3), row('d', 4, 'running')];
    expect(selectDemotionCandidates(rows, NOW)).toEqual([]);
  });
});
