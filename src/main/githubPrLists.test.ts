import { describe, it, expect } from 'vitest';
import { LIST_CAP, assignLists, buildSearchQuery, emptyLists, mergeOutcomes } from './githubPrLists';
import { PrListItem } from './types';

function item(id: string): PrListItem {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `PR ${id}`,
    url: `https://github.com/Nykredit/repo/pull/1`,
    owner: 'Nykredit',
    repo: 'repo',
    nameWithOwner: 'Nykredit/repo',
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
    expect(buildSearchQuery('involves', ['A'])).toContain('involves:@me');
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
    const lists = assignLists(
      { ids: ['a'], totalCount: 1 },
      { ids: ['a'], totalCount: 1 },
      { ids: ['a'], totalCount: 1 },
      byId('a')
    );
    expect(lists.created.items.map((i) => i.id)).toEqual(['a']);
    expect(lists.reviewing.items).toHaveLength(0);
    expect(lists.listening.items).toHaveLength(0);
  });

  it('prefers Reviewing over Listening', () => {
    const lists = assignLists(
      none,
      { ids: ['b'], totalCount: 1 },
      { ids: ['b'], totalCount: 1 },
      byId('b')
    );
    expect(lists.reviewing.items.map((i) => i.id)).toEqual(['b']);
    expect(lists.listening.items).toHaveLength(0);
  });

  it('keeps Listening as involves minus the other two', () => {
    const lists = assignLists(
      { ids: ['a'], totalCount: 1 },
      { ids: ['b'], totalCount: 1 },
      { ids: ['a', 'b', 'c'], totalCount: 3 },
      byId('a', 'b', 'c')
    );
    expect(lists.listening.items.map((i) => i.id)).toEqual(['c']);
  });

  it('drops an id with no detail rather than rendering a blank row', () => {
    // The detail query omits pull requests deleted or made inaccessible
    // between the search and the fetch.
    const lists = assignLists({ ids: ['a', 'ghost'], totalCount: 2 }, none, none, byId('a'));
    expect(lists.created.items.map((i) => i.id)).toEqual(['a']);
  });

  it('caps after precedence, not per source', () => {
    // Capping each source first under-fills the result: `involves` is a
    // superset, so its first page can be consumed entirely by precedence.
    const ids = Array.from({ length: LIST_CAP + 5 }, (_, i) => `pr${i}`);
    const lists = assignLists(
      { ids, totalCount: ids.length },
      none,
      { ids, totalCount: ids.length },
      byId(...ids)
    );
    expect(lists.created.items).toHaveLength(LIST_CAP);
    expect(lists.created.more).toBe(5);
    expect(lists.listening.items).toHaveLength(0);
  });

  it('counts matches the search page never returned as "more"', () => {
    const lists = assignLists({ ids: ['a'], totalCount: 120 }, none, none, byId('a'));
    expect(lists.created.more).toBe(119);
  });

  it('does not count items moved to another list as missing', () => {
    // Regression: one authored and one review-requested PR, both also
    // matching `involves:@me`, made Listening report "≈2 more" when nothing
    // was hidden — they were simply shown under Created and Reviewing.
    const lists = assignLists(
      { ids: ['a'], totalCount: 1 },
      { ids: ['b'], totalCount: 1 },
      { ids: ['a', 'b', 'c'], totalCount: 3 },
      byId('a', 'b', 'c')
    );
    expect(lists.listening.items.map((i) => i.id)).toEqual(['c']);
    expect(lists.listening.more).toBe(0);
    expect(lists.listening.moreIsApproximate).toBe(false);
  });

  it('marks only the Listening count approximate', () => {
    const lists = assignLists(
      { ids: ['a'], totalCount: 9 },
      none,
      { ids: ['a', 'c'], totalCount: 9 },
      byId('a', 'c')
    );
    expect(lists.created.moreIsApproximate).toBe(false);
    // The server cannot subtract Created and Reviewing for us, so the
    // Listening remainder overstates what is genuinely missing.
    expect(lists.listening.moreIsApproximate).toBe(true);
  });

  it('never marks a zero remainder as approximate', () => {
    const lists = assignLists(none, none, { ids: ['c'], totalCount: 1 }, byId('c'));
    expect(lists.listening.more).toBe(0);
    expect(lists.listening.moreIsApproximate).toBe(false);
  });

  it('preserves search order (updated-descending)', () => {
    const lists = assignLists({ ids: ['c', 'a', 'b'], totalCount: 3 }, none, none, byId('a', 'b', 'c'));
    expect(lists.created.items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('emptyLists', () => {
  it('produces three independent empty lists', () => {
    const lists = emptyLists();
    lists.created.items.push(item('a'));
    expect(lists.reviewing.items).toHaveLength(0);
    expect(lists.listening.items).toHaveLength(0);
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
  it('keeps a reviewed pull request in Reviewing rather than Listening', () => {
    // `review-requested:@me` drops a pull request the moment the review is
    // submitted, because the request is then fulfilled. Without the
    // `reviewed-by:@me` union it falls through to Listening — where the user
    // is least likely to look for their own outstanding work.
    const reviewing = mergeOutcomes(
      { ids: [], totalCount: 0 },
      { ids: ['reviewed-pr'], totalCount: 1 }
    );
    const lists = assignLists(
      { ids: [], totalCount: 0 },
      reviewing,
      { ids: ['reviewed-pr'], totalCount: 1 },
      byId('reviewed-pr')
    );
    expect(lists.reviewing.items.map((i) => i.id)).toEqual(['reviewed-pr']);
    expect(lists.listening.items).toHaveLength(0);
  });
});
