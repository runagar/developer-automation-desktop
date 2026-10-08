/**
 * Search query construction and list assignment for "Your Pull Requests".
 *
 * Pure: no I/O, so precedence and the cap are asserted in tests rather than
 * argued about. Also imported by the renderer.
 */

import { PrCandidate, PrList, PrListItem, PrLists, PrState } from './types';

/** Every workspace is assumed to live under this owner (GIT4, ambiguity 1). */
export const OPEN_PR_OWNER = 'Nykredit';

/**
 * Per-list cap for the searched lists (requirement 2.1, ambiguity 9).
 * Applied *after* merge and precedence; `OTHER` is never capped.
 */
export const LIST_CAP = 50;

/** One page is fetched per search; 100 is GitHub's maximum. */
export const SEARCH_PAGE_SIZE = 100;

export type SearchKind = 'created' | 'reviewing' | 'reviewed';

/**
 * Build the search query for one of the three sources.
 *
 * Multiple orgs are OR-ed into a single query (`org:A org:B` is an OR in
 * GitHub search), so the request count does not grow with the org count.
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
        : 'reviewed-by:@me';

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

/**
 * Assign every matched pull request to exactly one of the searched lists,
 * precedence Created > Reviewing (ambiguity 8). `OTHER` is built separately by
 * `buildOtherList` and ignores this precedence (GIT4, ambiguity 9).
 */
export function assignLists(
  created: SearchOutcome,
  reviewing: SearchOutcome,
  byId: Map<string, PrListItem>
): Pick<PrLists, 'created' | 'reviewing'> {
  const claimed = new Set<string>();

  const take = (ids: string[]): PrListItem[] => {
    const items: PrListItem[] = [];
    for (const id of ids) {
      if (claimed.has(id)) continue;
      const item = byId.get(id);
      if (!item) continue;
      claimed.add(id);
      items.push(item);
    }
    return items;
  };

  const createdItems = take(created.ids);
  const reviewingItems = take(reviewing.ids);

  return {
    created: capList(createdItems, created, false),
    // Approximate: a union of two searches, so a remainder beyond either page
    // cannot be de-duplicated without fetching it.
    reviewing: capList(reviewingItems, reviewing, true),
  };
}

/**
 * Count what the user genuinely cannot see.
 *
 * `more` is measured against the number of results the search **returned**,
 * not against the list after precedence. Subtracting the post-precedence
 * length instead counts every pull request that moved to another list as
 * "missing".
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
  return { created: empty(), reviewing: empty(), other: empty() };
}

export function toPrState(value: string | undefined | null): PrState {
  if (value === 'CLOSED' || value === 'MERGED') return value;
  return 'OPEN';
}

export function sortByUpdatedDesc(items: PrListItem[]): PrListItem[] {
  return [...items].sort((a, b) => compareDesc(a.updatedAt, b.updatedAt));
}

/** The `OTHER` rows that were found, in update order; ids that did not resolve are absent. */
export function buildOtherList(ids: string[], byId: Map<string, PrListItem>): PrList {
  const seen = new Set<string>();
  const items: PrListItem[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    if (item) items.push(item);
  }
  return { items: sortByUpdatedDesc(items), more: 0, moreIsApproximate: false };
}

/**
 * The row shown the moment a pull request is added, before its badges are
 * known. The viewer's load (`syncListRow`) and the next list refresh replace it.
 */
export function candidateToListItem(candidate: PrCandidate): PrListItem {
  return {
    id: candidate.id,
    number: candidate.number,
    title: candidate.title,
    url: '',
    owner: candidate.owner,
    repo: candidate.repo,
    nameWithOwner: candidate.nameWithOwner,
    baseRefName: candidate.baseRefName,
    headRefName: candidate.headRefName,
    state: candidate.state,
    isDraft: candidate.isDraft,
    mergeable: 'UNKNOWN',
    mergeState: 'UNKNOWN',
    checks: 'NONE',
    updatedAt: candidate.updatedAt,
    reviewers: [],
  };
}

export interface CandidateFilter {
  showDrafts: boolean;
  showClosed: boolean;
}

/**
 * The Open Pull Request dialog's list: drafts, then open, then closed/merged,
 * each newest first (requirements 2.2.2.1 and 2.2.2.3).
 */
export function orderCandidates(
  open: PrCandidate[],
  closed: PrCandidate[] | null,
  filter: CandidateFilter
): PrCandidate[] {
  const byCreated = (a: PrCandidate, b: PrCandidate): number => compareDesc(a.createdAt, b.createdAt);
  const byClosed = (a: PrCandidate, b: PrCandidate): number =>
    compareDesc(a.closedAt ?? a.updatedAt, b.closedAt ?? b.updatedAt);

  const openOnly = open.filter((c) => c.state === 'OPEN');
  const drafts = filter.showDrafts ? openOnly.filter((c) => c.isDraft).sort(byCreated) : [];
  const ready = openOnly.filter((c) => !c.isDraft).sort(byCreated);
  const done = filter.showClosed && closed
    ? closed.filter((c) => c.state !== 'OPEN').sort(byClosed)
    : [];

  return [...drafts, ...ready, ...done];
}

function compareDesc(a: string, b: string): number {
  return (Date.parse(b) || 0) - (Date.parse(a) || 0);
}
