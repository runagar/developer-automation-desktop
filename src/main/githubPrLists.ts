/**
 * Search query construction and list assignment for "Your Pull Requests".
 *
 * Pure: no I/O, so precedence and the cap are asserted in tests rather than
 * argued about — and the definition of "Listening" stays a one-line change if
 * `involves:@me` proves too broad in use.
 */

import { PrList, PrListItem, PrLists } from './types';

/**
 * Per-list cap (requirement 2.1, ambiguity 9).
 *
 * Applied *after* merge and precedence. Capping each source first
 * under-fills the result: `involves` is a superset of the other two, so its
 * first page can be consumed entirely by precedence.
 */
export const LIST_CAP = 50;

/** One page is fetched per search; 100 is GitHub's maximum. */
export const SEARCH_PAGE_SIZE = 100;

export type SearchKind = 'created' | 'reviewing' | 'reviewed' | 'involves';

/**
 * Build the search query for one of the three sources.
 *
 * Multiple orgs are OR-ed into a single query (`org:A org:B` is an OR in
 * GitHub search), so the request count is three regardless of how many orgs
 * are configured.
 */
export function buildSearchQuery(kind: SearchKind, orgs: string[]): string {
  const scope = orgs
    .map((org) => org.trim())
    .filter(Boolean)
    .map((org) => `org:${org}`)
    .join(' ');

  const who =
    kind === 'created' ? 'author:@me'
      // Only *outstanding* requests. Submitting a review fulfils the request
      // and the pull request leaves this result set, which is why `reviewed`
      // exists alongside it.
      : kind === 'reviewing' ? 'review-requested:@me'
        : kind === 'reviewed' ? 'reviewed-by:@me'
          : 'involves:@me';

  // Open only, drafts included and badged (ambiguity 9).
  return ['is:pr', 'is:open', who, scope].filter(Boolean).join(' ');
}

export interface SearchOutcome {
  /** Node ids in search order (updated-descending). */
  ids: string[];
  /** GitHub's total match count, used for the "N more" footer. */
  totalCount: number;
}

/**
 * Assign every matched pull request to exactly one list.
 *
 * A pull request can legitimately match more than one source — authored *and*
 * review-requested, or reviewing *and* commented — and appears once, under
 * the first of Created > Reviewing > Listening (ambiguity 8).
 *
 * Listening is `involves` minus the other two (ambiguity 7). GitHub has no
 * `subscribed:` qualifier: an unrecognised qualifier is not an error, it
 * silently matches nothing, so subscription state is simply not searchable.
 */
/**
 * Union two searches, preserving the order of the first.
 *
 * `totalCount` becomes "what these pages returned, plus what each page left
 * behind". Adding the two totals instead would double-count every pull
 * request matching both.
 */
export function mergeOutcomes(a: SearchOutcome, b: SearchOutcome): SearchOutcome {
  const ids = [...a.ids];
  const seen = new Set(ids);
  for (const id of b.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const beyond = Math.max(0, a.totalCount - a.ids.length) + Math.max(0, b.totalCount - b.ids.length);
  return { ids, totalCount: ids.length + beyond };
}

export function assignLists(
  created: SearchOutcome,
  reviewing: SearchOutcome,
  involves: SearchOutcome,
  byId: Map<string, PrListItem>
): PrLists {
  const claimed = new Set<string>();

  const take = (ids: string[]): PrListItem[] => {
    const items: PrListItem[] = [];
    for (const id of ids) {
      if (claimed.has(id)) continue;
      const item = byId.get(id);
      if (!item) continue; // detail fetch dropped it (deleted, or no access)
      claimed.add(id);
      items.push(item);
    }
    return items;
  };

  const createdItems = take(created.ids);
  const reviewingItems = take(reviewing.ids);
  const listeningItems = take(involves.ids);

  return {
    created: capList(createdItems, created, false),
    // Approximate for the same reason as Listening: it is a union of two
    // searches, so a remainder beyond either page cannot be de-duplicated
    // without fetching it.
    reviewing: capList(reviewingItems, reviewing, true),
    // Approximate only because matches *beyond the fetched page* cannot be
    // classified without fetching them; everything on the page is exact.
    listening: capList(listeningItems, involves, true),
  };
}

/**
 * Count what the user genuinely cannot see.
 *
 * `more` is measured against the number of results the search **returned**,
 * not against the list after precedence. Subtracting the post-precedence
 * length instead counts every pull request that moved to another list as
 * "missing" — so a user with one authored and one review-requested PR, both
 * also matching `involves:@me`, saw "≈2 more" under Listening when in fact
 * nothing was hidden at all.
 */
function capList(items: PrListItem[], outcome: SearchOutcome, approximate: boolean): PrList {
  const visible = items.slice(0, LIST_CAP);
  const beyondCap = Math.max(0, items.length - visible.length);
  // Matches the single search page never returned.
  const beyondPage = Math.max(0, outcome.totalCount - outcome.ids.length);
  const more = beyondCap + beyondPage;
  return { items: visible, more, moreIsApproximate: approximate && beyondPage > 0 };
}

/**
 * An empty result, used as the initial state and after a failure.
 *
 * Each list gets its own `items` array: spreading a shared literal would give
 * all three the same array, so pushing into one would mutate the others.
 */
export function emptyLists(): PrLists {
  const empty = (): PrList => ({ items: [], more: 0, moreIsApproximate: false });
  return { created: empty(), reviewing: empty(), listening: empty() };
}
