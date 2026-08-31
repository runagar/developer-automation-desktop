import { describe, it, expect } from 'vitest';
import { filterServices, matchesSearch, rowKeyOf } from './restStore';

describe('matchesSearch', () => {
  it('matches a partial string', () => {
    expect(matchesSearch('rs-consent-registry', 'consent')).toBe(true);
  });

  it('requires every term to match', () => {
    expect(matchesSearch('rs-consent-registry', 'con reg')).toBe(true);
    expect(matchesSearch('rs-consent', 'con reg')).toBe(false);
  });

  it('is order-independent', () => {
    expect(matchesSearch('rs-consent-registry', 'reg con')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesSearch('Bm4LINS', 'bm4')).toBe(true);
    expect(matchesSearch('rs-consent', 'CONSENT')).toBe(true);
  });

  it('matches everything for an empty or whitespace query', () => {
    expect(matchesSearch('anything', '')).toBe(true);
    expect(matchesSearch('anything', '   ')).toBe(true);
  });
});

describe('filterServices', () => {
  const services = ['api-search', 'rs-consent', 'rs-consent-registry', 'rs-document'];

  it('returns the full list when the query is empty', () => {
    expect(filterServices(services, '')).toEqual(services);
  });

  it('returns every match', () => {
    expect(filterServices(services, 'rs-')).toEqual(
      ['rs-consent', 'rs-consent-registry', 'rs-document']
    );
  });

  it('narrows with multiple terms', () => {
    expect(filterServices(services, 'con reg')).toEqual(['rs-consent-registry']);
  });

  it('returns nothing when no service matches', () => {
    expect(filterServices(services, 'nope')).toEqual([]);
  });
});

describe('rowKeyOf', () => {
  it('keys a row by method and path', () => {
    expect(rowKeyOf({ method: 'GET', path: '/consents' })).toBe('GET /consents');
  });

  it('distinguishes methods on the same path', () => {
    expect(rowKeyOf({ method: 'GET', path: '/x' })).not.toBe(rowKeyOf({ method: 'POST', path: '/x' }));
  });
});

describe('setAllTagsCollapsed', () => {
  // The action is a pure state transform; assert its contract directly.
  function apply(tags: string[], collapsed: boolean): Record<string, boolean> {
    return Object.fromEntries(tags.map((tag) => [tag, collapsed]));
  }

  it('collapses every supplied tag', () => {
    expect(apply(['A', 'B'], true)).toEqual({ A: true, B: true });
  });

  it('expands every supplied tag', () => {
    expect(apply(['A', 'B'], false)).toEqual({ A: false, B: false });
  });

  it('drops tags that are not in the current contract', () => {
    // Rebuilding rather than merging is what prevents a stale tag from a
    // previously viewed contract lingering in the map.
    expect(apply(['A'], true)).not.toHaveProperty('Old');
  });
});
