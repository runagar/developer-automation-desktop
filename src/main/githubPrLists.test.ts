import { describe, it, expect } from 'vitest';
import {
  LIST_CAP, assignLists, buildOtherList, buildSearchQuery, candidateToListItem, emptyLists,
  mergeOutcomes, orderCandidates, sortByUpdatedDesc, toPrState,
} from './githubPrLists';
import { PrCandidate, PrListItem } from './types';

function item(id: string): PrListItem {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `PR ${id}`,
    url: `https://github.com/Nykredit/repo/pull/1`,
    owner: 'Nykredit',
    repo: 'repo',
    nameWithOwner: 'Nykredit/repo',
    baseRefName: 'develop',
    headRefName: `feature/${id}`,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    checks: 'SUCCESS',
    updatedAt: '2026-09-21T00:00:00Z',
    reviewers: [],
  };
}

function byId(...ids: string[]): Map<string, PrListItem> {
  return new Map(ids.map((id) => [id, item(id)]));
}

describe('buildSearchQuery', () => {
  it('ORs every configured org into a single query', () => {
    // `org:A org:B` is an OR in GitHub search, so the request count stays at
    // three regardless of how many orgs are configured.
    expect(buildSearchQuery('created', ['Nykredit', 'Nykredit-Medio']))
      .toBe('is:pr is:open author:@me org:Nykredit org:Nykredit-Medio');
  });

  it('uses the right qualifier for each source', () => {
    expect(buildSearchQuery('reviewing', ['A'])).toContain('review-requested:@me');
    expect(buildSearchQuery('reviewed', ['A'])).toContain('reviewed-by:@me');
  });

  it('restricts to open pull requests', () => {
    const q = buildSearchQuery('created', ['A']);
    expect(q).toContain('is:pr');
    expect(q).toContain('is:open');
  });

  it('drops blank org entries rather than emitting "org:"', () => {
    expect(buildSearchQuery('created', ['  ', 'A', ''])).toBe('is:pr is:open author:@me org:A');
  });

  it('still produces a valid query with no orgs configured', () => {
    expect(buildSearchQuery('created', [])).toBe('is:pr is:open author:@me');
  });
});

describe('assignLists', () => {
  const none = { ids: [], totalCount: 0 };

  it('places a pull request in exactly one list, Created first', () => {
    const lists = assignLists({ ids: ['a'], totalCount: 1 }, { ids: ['a'], totalCount: 1 }, byId('a'));
    expect(lists.created.items.map((i) => i.id)).toEqual(['a']);
    expect(lists.reviewing.items).toHaveLength(0);
  });

  it('drops an id with no detail rather than rendering a blank row', () => {
    // The detail query omits pull requests deleted or made inaccessible
    // between the search and the fetch.
    const lists = assignLists({ ids: ['a', 'ghost'], totalCount: 2 }, none, byId('a'));
    expect(lists.created.items.map((i) => i.id)).toEqual(['a']);
  });

  it('caps after precedence, not per source', () => {
    const ids = Array.from({ length: LIST_CAP + 5 }, (_, i) => `pr${i}`);
    const lists = assignLists({ ids, totalCount: ids.length }, { ids, totalCount: ids.length }, byId(...ids));
    expect(lists.created.items).toHaveLength(LIST_CAP);
    expect(lists.created.more).toBe(5);
    expect(lists.reviewing.items).toHaveLength(0);
  });

  it('counts matches the search page never returned as "more"', () => {
    const lists = assignLists({ ids: ['a'], totalCount: 120 }, none, byId('a'));
    expect(lists.created.more).toBe(119);
  });

  it('does not count items moved to another list as missing', () => {
    const lists = assignLists({ ids: ['a'], totalCount: 1 }, { ids: ['a', 'b'], totalCount: 2 }, byId('a', 'b'));
    expect(lists.reviewing.items.map((i) => i.id)).toEqual(['b']);
    expect(lists.reviewing.more).toBe(0);
    expect(lists.reviewing.moreIsApproximate).toBe(false);
  });

  it('marks only the Reviewing remainder approximate', () => {
    const lists = assignLists({ ids: ['a'], totalCount: 9 }, { ids: ['b'], totalCount: 9 }, byId('a', 'b'));
    expect(lists.created.moreIsApproximate).toBe(false);
    expect(lists.reviewing.moreIsApproximate).toBe(true);
  });

  it('preserves search order (updated-descending)', () => {
    const lists = assignLists({ ids: ['c', 'a', 'b'], totalCount: 3 }, none, byId('a', 'b', 'c'));
    expect(lists.created.items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('no longer produces a list from `involves:@me`', () => {
    // Given a pull request that only involves the user
    // When the lists are assigned from the two searches
    const lists = assignLists(none, none, byId('c'));

    // Then nothing is populated automatically
    expect(Object.keys(lists)).toEqual(['created', 'reviewing']);
    expect(lists.created.items).toHaveLength(0);
    expect(lists.reviewing.items).toHaveLength(0);
  });
});

describe('emptyLists', () => {
  it('produces three independent empty lists', () => {
    const lists = emptyLists();
    lists.created.items.push(item('a'));
    expect(lists.reviewing.items).toHaveLength(0);
    expect(lists.other.items).toHaveLength(0);
  });
});

describe('mergeOutcomes', () => {
  it('unions ids, keeping the first search\'s order', () => {
    const merged = mergeOutcomes({ ids: ['a', 'b'], totalCount: 2 }, { ids: ['b', 'c'], totalCount: 2 });
    expect(merged.ids).toEqual(['a', 'b', 'c']);
  });

  it('does not double-count a pull request matching both searches', () => {
    // Adding the totals would report 4 for three distinct pull requests, and
    // the list footer would invent a phantom remainder.
    const merged = mergeOutcomes({ ids: ['a', 'b'], totalCount: 2 }, { ids: ['b', 'c'], totalCount: 2 });
    expect(merged.totalCount).toBe(3);
  });

  it('carries forward what each page left behind', () => {
    const merged = mergeOutcomes({ ids: ['a'], totalCount: 10 }, { ids: ['b'], totalCount: 5 });
    expect(merged.ids).toEqual(['a', 'b']);
    expect(merged.totalCount).toBe(2 + 9 + 4);
  });

  it('handles either side being empty', () => {
    expect(mergeOutcomes({ ids: [], totalCount: 0 }, { ids: ['a'], totalCount: 1 }).ids).toEqual(['a']);
    expect(mergeOutcomes({ ids: ['a'], totalCount: 1 }, { ids: [], totalCount: 0 }).ids).toEqual(['a']);
  });
});

describe('reviewing after a review is submitted', () => {
  it('keeps a reviewed pull request in Reviewing', () => {
    // `review-requested:@me` drops a pull request the moment the review is
    // submitted, because the request is then fulfilled; the `reviewed-by:@me`
    // union keeps it listed.
    const reviewing = mergeOutcomes(
      { ids: [], totalCount: 0 },
      { ids: ['reviewed-pr'], totalCount: 1 }
    );
    const lists = assignLists({ ids: [], totalCount: 0 }, reviewing, byId('reviewed-pr'));
    expect(lists.reviewing.items.map((i) => i.id)).toEqual(['reviewed-pr']);
  });
});

function updated(id: string, at: string): PrListItem {
  return { ...item(id), updatedAt: at };
}

function candidate(id: string, patch: Partial<PrCandidate> = {}): PrCandidate {
  return {
    id,
    number: 1,
    title: `PR ${id}`,
    owner: 'Nykredit',
    repo: 'rs-consent',
    nameWithOwner: 'Nykredit/rs-consent',
    headRefName: `feature/${id}`,
    baseRefName: 'develop',
    isDraft: false,
    state: 'OPEN',
    author: 'RULU_NYK',
    createdAt: '2026-09-01T00:00:00Z',
    closedAt: null,
    updatedAt: '2026-09-01T00:00:00Z',
    ...patch,
  };
}

describe('toPrState', () => {
  it('keeps closed and merged, and resolves anything else to open', () => {
    expect(toPrState('CLOSED')).toBe('CLOSED');
    expect(toPrState('MERGED')).toBe('MERGED');
    expect(toPrState('OPEN')).toBe('OPEN');
    expect(toPrState(undefined)).toBe('OPEN');
    expect(toPrState('SOMETHING_NEW')).toBe('OPEN');
  });
});

describe('sortByUpdatedDesc', () => {
  it('orders newest update first without mutating the input', () => {
    // Given
    const input = [updated('a', '2026-01-01T00:00:00Z'), updated('b', '2026-03-01T00:00:00Z')];

    // When
    const sorted = sortByUpdatedDesc(input);

    // Then
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
    expect(input.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('buildOtherList', () => {
  it('returns the found rows newest first, uncapped, and skips ids that did not resolve', () => {
    // Given
    const ids = Array.from({ length: LIST_CAP + 3 }, (_, i) => `o${i}`);
    const byIdMap = new Map(ids.map((id, i) => [id, updated(id, new Date(2026, 0, i + 1).toISOString())]));
    byIdMap.delete('o0');

    // When
    const list = buildOtherList([...ids, 'o1'], byIdMap);

    // Then
    expect(list.items).toHaveLength(LIST_CAP + 2);
    expect(list.items[0].id).toBe(`o${LIST_CAP + 2}`);
    expect(list.items.some((i) => i.id === 'o0')).toBe(false);
    expect(list.more).toBe(0);
  });
});

describe('candidateToListItem', () => {
  it('builds a provisional row without inventing badges', () => {
    // Given
    const c = candidate('x', { number: 42, state: 'MERGED', isDraft: true });

    // When
    const row = candidateToListItem(c);

    // Then
    expect(row).toMatchObject({
      id: 'x', number: 42, owner: 'Nykredit', repo: 'rs-consent', state: 'MERGED', isDraft: true,
      checks: 'NONE', mergeable: 'UNKNOWN', reviewers: [],
    });
  });
});

describe('orderCandidates', () => {
  const open = [
    candidate('old-ready', { createdAt: '2026-01-01T00:00:00Z' }),
    candidate('new-ready', { createdAt: '2026-03-01T00:00:00Z' }),
    candidate('old-draft', { isDraft: true, createdAt: '2026-01-02T00:00:00Z' }),
    candidate('new-draft', { isDraft: true, createdAt: '2026-03-02T00:00:00Z' }),
  ];
  const closed = [
    candidate('closed-early', { state: 'CLOSED', closedAt: '2026-02-01T00:00:00Z' }),
    candidate('merged-late', { state: 'MERGED', closedAt: '2026-04-01T00:00:00Z' }),
  ];

  it('shows only open non-draft pull requests by default, newest first', () => {
    // When
    const ordered = orderCandidates(open, closed, { showDrafts: false, showClosed: false });

    // Then
    expect(ordered.map((c) => c.id)).toEqual(['new-ready', 'old-ready']);
  });

  it('puts drafts first and closed last, each newest first', () => {
    // When
    const ordered = orderCandidates(open, closed, { showDrafts: true, showClosed: true });

    // Then
    expect(ordered.map((c) => c.id)).toEqual([
      'new-draft', 'old-draft', 'new-ready', 'old-ready', 'merged-late', 'closed-early',
    ]);
  });

  it('shows nothing closed until the closed page has loaded', () => {
    // When
    const ordered = orderCandidates(open, null, { showDrafts: false, showClosed: true });

    // Then
    expect(ordered.map((c) => c.id)).toEqual(['new-ready', 'old-ready']);
  });
});
