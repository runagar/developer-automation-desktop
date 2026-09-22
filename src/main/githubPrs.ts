/**
 * "Your Pull Requests" — the list side of the GitHub integration.
 *
 * Three searches (one per source, all configured orgs OR-ed into each), then a
 * chunked GraphQL query for the badge and reviewer fields the search API does
 * not return.
 */

import { ghRest, ghGraphql } from './github';
import { PR_BADGES_QUERY } from './githubQueries';
import {
  SEARCH_PAGE_SIZE, SearchKind, SearchOutcome, assignLists, buildSearchQuery, mergeOutcomes,
} from './githubPrLists';
import { getGitHubOrgs } from './settings';
import {
  PrCheck, PrCheckState, PrListItem, PrLists, PrMergeStateStatus, PrMergeableState, PrReviewer,
  PrReviewerState,
} from './types';

/**
 * Node ids per GraphQL document.
 *
 * One document asking for `statusCheckRollup` across every match can exceed
 * GitHub's node/complexity budget; discovering that ceiling in production is
 * not a plan.
 */
const BADGE_CHUNK = 50;

interface SearchResponse {
  total_count?: number;
  items?: { node_id?: string }[];
}

async function search(kind: SearchKind, orgs: string[]): Promise<SearchOutcome> {
  const query = buildSearchQuery(kind, orgs);
  const path = `search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${SEARCH_PAGE_SIZE}`;
  const response = await ghRest<SearchResponse>(path);
  return {
    ids: (response.items ?? []).map((i) => i.node_id).filter((id): id is string => !!id),
    totalCount: response.total_count ?? 0,
  };
}

interface BadgeNode {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  updatedAt?: string;
  repository?: { nameWithOwner?: string; owner?: { login?: string }; name?: string };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
  reviewRequests?: { nodes?: { requestedReviewer?: RawReviewer | null }[] };
  latestReviews?: { nodes?: { state?: string; author?: { login?: string } | null }[] };
}

interface RawReviewer {
  __typename?: string;
  login?: string;
  slug?: string;
  /** `org/team-slug`; only teams have it. */
  combinedSlug?: string;
}

export function toCheckState(value: string | undefined | null): PrCheckState {
  switch (value) {
    case 'SUCCESS': return 'SUCCESS';
    case 'FAILURE': case 'ERROR': return 'FAILURE';
    case 'PENDING': case 'EXPECTED': return 'PENDING';
    default: return 'NONE';
  }
}

/**
 * `UNKNOWN` is kept as its own state, never folded into conflicting.
 *
 * GitHub computes mergeability lazily and answers `UNKNOWN` while it works, so
 * collapsing it would show "conflicting" for a perfectly healthy pull request.
 */
/**
 * Flatten one rollup context.
 *
 * A `CheckRun` reports `status` (queued/in progress/completed) separately from
 * `conclusion` (how it ended), while a `StatusContext` has only `state`. The
 * two are normalised here so the UI does not have to know which it is looking
 * at — except for SKIPPED, which is kept because "did not run" is genuinely
 * different from "passed".
 */
export function toCheck(raw: any, index: number): PrCheck {
  const isCheckRun = raw?.__typename === 'CheckRun';
  const name = (isCheckRun ? raw?.name : raw?.context) || `check ${index + 1}`;
  const required = raw?.isRequired === true;

  if (!isCheckRun) {
    return { name, state: toCheckState(raw?.state), required };
  }

  // Still running: `conclusion` is null until it finishes.
  if (raw?.status !== 'COMPLETED') return { name, state: 'PENDING', required };
  if (raw?.conclusion === 'SKIPPED') return { name, state: 'SKIPPED', required };
  if (raw?.conclusion === 'SUCCESS' || raw?.conclusion === 'NEUTRAL') {
    return { name, state: 'SUCCESS', required };
  }
  return { name, state: 'FAILURE', required };
}

export function toMergeableState(value: string | undefined | null): PrMergeableState {
  switch (value) {
    case 'MERGEABLE': return 'MERGEABLE';
    case 'CONFLICTING': return 'CONFLICTING';
    default: return 'UNKNOWN';
  }
}

/**
 * Merge readiness.
 *
 * Anything unrecognised resolves to UNKNOWN rather than to CLEAN: claiming a
 * pull request is ready to merge is the one answer that must never be
 * guessed.
 */
export function toMergeState(value: string | undefined | null): PrMergeStateStatus {
  switch (value) {
    case 'CLEAN': return 'CLEAN';
    case 'DIRTY': return 'DIRTY';
    case 'BLOCKED': return 'BLOCKED';
    case 'BEHIND': return 'BEHIND';
    case 'UNSTABLE': return 'UNSTABLE';
    case 'HAS_HOOKS': return 'HAS_HOOKS';
    default: return 'UNKNOWN';
  }
}

function reviewStateFor(value: string | undefined): PrReviewerState {
  switch (value) {
    case 'APPROVED': return 'APPROVED';
    case 'CHANGES_REQUESTED': return 'CHANGES_REQUESTED';
    case 'COMMENTED': return 'COMMENTED';
    case 'DISMISSED': return 'DISMISSED';
    default: return 'PENDING_REQUEST';
  }
}

/**
 * Merge outstanding review requests with the latest submitted reviews.
 *
 * A requested *team* has no per-user state until one of its members reviews,
 * so it renders as its slug in `PENDING_REQUEST`. A person who has both
 * reviewed and been re-requested shows the outstanding request, because that
 * is the actionable fact — but `requested` records the distinction, because
 * only outstanding requests may be sent back to `requestReviewsByLogin`.
 */
export function buildReviewers(
  requests: { requestedReviewer?: RawReviewer | null }[] | undefined,
  reviews: { state?: string; author?: { login?: string } | null }[] | undefined
): PrReviewer[] {
  const byName = new Map<string, PrReviewer>();

  for (const review of reviews ?? []) {
    const name = review.author?.login;
    if (!name) continue;
    byName.set(name, {
      name,
      requestKey: name,
      isTeam: false,
      isBot: false,
      state: reviewStateFor(review.state),
      requested: false,
    });
  }

  for (const request of requests ?? []) {
    const reviewer = request.requestedReviewer;
    if (!reviewer) continue;
    const isTeam = reviewer.__typename === 'Team';
    const isBot = reviewer.__typename === 'Bot';
    const name = isTeam ? reviewer.slug : reviewer.login;
    if (!name) continue;
    // A team must go back as `org/team-slug`; falling back to the bare slug
    // only matters for a payload that predates the field being requested.
    const requestKey = isTeam ? (reviewer.combinedSlug ?? name) : name;
    byName.set(name, { name, requestKey, isTeam, isBot, state: 'PENDING_REQUEST', requested: true });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function toListItem(node: BadgeNode): PrListItem | null {
  if (!node?.id || node.number === undefined) return null;
  const owner = node.repository?.owner?.login ?? '';
  const repo = node.repository?.name ?? '';
  return {
    id: node.id,
    number: node.number,
    title: node.title ?? '',
    url: node.url ?? '',
    owner,
    repo,
    nameWithOwner: node.repository?.nameWithOwner ?? `${owner}/${repo}`,
    isDraft: node.isDraft === true,
    mergeable: toMergeableState(node.mergeable),
    mergeState: toMergeState(node.mergeStateStatus),
    checks: toCheckState(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    updatedAt: node.updatedAt ?? '',
    reviewers: buildReviewers(node.reviewRequests?.nodes, node.latestReviews?.nodes),
  };
}

async function fetchBadges(ids: string[]): Promise<Map<string, PrListItem>> {
  const byId = new Map<string, PrListItem>();
  for (let i = 0; i < ids.length; i += BADGE_CHUNK) {
    const chunk = ids.slice(i, i + BADGE_CHUNK);
    const data = await ghGraphql<{ nodes: (BadgeNode | null)[] }>(PR_BADGES_QUERY, { ids: chunk });
    for (const node of data.nodes ?? []) {
      if (!node) continue;
      const item = toListItem(node);
      if (item) byId.set(item.id, item);
    }
  }
  return byId;
}

export async function listPullRequests(dataDir: string): Promise<PrLists> {
  const orgs = getGitHubOrgs(dataDir);

  // Four searches, not three: "reviewing" is the union of outstanding review
  // requests and reviews already submitted. Without the second, submitting a
  // review drops the pull request out of Reviewing and it reappears under
  // Listening — which is where the user is least likely to look for it.
  const [created, requested, reviewed, involves] = await Promise.all([
    search('created', orgs),
    search('reviewing', orgs),
    search('reviewed', orgs),
    search('involves', orgs),
  ]);

  const reviewing = mergeOutcomes(requested, reviewed);
  const ids = [...new Set([...created.ids, ...reviewing.ids, ...involves.ids])];
  const byId = ids.length > 0 ? await fetchBadges(ids) : new Map<string, PrListItem>();

  return assignLists(created, reviewing, involves, byId);
}
