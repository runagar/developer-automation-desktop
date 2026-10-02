/**
 * Who owns the repository a pull request lives in.
 *
 * The reviewer picker needs a list of people to choose from, and neither
 * obvious source is one. GitHub's `suggestedReviewers` infers at most a
 * handful of names from blame and often returns two. The full collaborator
 * set is the opposite problem — the organisation repositories here carry over
 * nine hundred, and `collaborators` additionally requires push permission, so
 * it fails outright on exactly the repositories a reviewer is least familiar
 * with.
 *
 * The team named by the `responsible_team` custom repository property is
 * neither: it is the handful of people actually accountable for the
 * repository, and it is the source the auto-generated `CODEOWNERS` file is
 * built from — so it answers "who owns this?" without reading, parsing and
 * resolving a file that only some repositories have.
 */

import { GitHubError, ghGraphql } from './github';
import { REPO_PROPERTIES_QUERY, TEAM_MEMBERS_QUERY } from './githubQueries';
import { PrOwner, PrOwners, PrRef } from './types';

export const OWNER_TEAM_PROPERTY = 'responsible_team';

/**
 * Bounded cursor loop. Five pages is five hundred people — far beyond any
 * team that could meaningfully own a repository — and the bound exists so a
 * server that never reports `hasNextPage: false` cannot spin forever.
 */
const MAX_MEMBER_PAGES = 5;

const EMPTY: PrOwners = { teamKey: null, teamName: null, members: [] };

/**
 * GraphQL error types that describe the *answer*, not a failed request.
 *
 * A personal repository cannot hold custom properties at all, an owner that
 * is a user does not resolve as an organisation, and a property naming a team
 * the viewer cannot read resolves to nothing. All three mean "this repository
 * names no owners I can list", which is a legitimate empty result — the menu
 * keeps its free-text field and GitHub's own suggestions. Anything else, auth
 * and rate limiting in particular, must still surface.
 */
const NO_OWNERS_ERRORS = new Set(['NOT_ORG_OWNED_REPO', 'NOT_FOUND', 'FORBIDDEN']);

/**
 * Per repository, for the process lifetime.
 *
 * Team membership changes far more slowly than a DAD session lives while the
 * menu is re-opened constantly, and two round trips per open is a visible
 * delay on a popover. Empty results are cached too: "this repository names no
 * owning team" is an answer, and re-asking costs the same two round trips to
 * learn it again.
 */
const cache = new Map<string, PrOwners>();

interface PropertyNode {
  propertyName?: string | null;
  value?: string | null;
}

interface PropertiesResponse {
  repository?: {
    repositoryCustomPropertyValues?: { nodes?: (PropertyNode | null)[] | null } | null;
  } | null;
}

interface MemberNode {
  login?: string | null;
  name?: string | null;
}

interface TeamResponse {
  organization?: {
    team?: {
      name?: string | null;
      combinedSlug?: string | null;
      members?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: (MemberNode | null)[] | null;
      } | null;
    } | null;
  } | null;
}

export function ownerTeamSlug(nodes: (PropertyNode | null)[] | null | undefined): string | null {
  for (const node of nodes ?? []) {
    if (node?.propertyName !== OWNER_TEAM_PROPERTY) continue;
    return (node.value ?? '').trim() || null;
  }
  return null;
}

/**
 * Login order, case-insensitively.
 *
 * GitHub returns members in no documented order, so without this the list
 * reshuffles between openings of the same menu.
 */
export function sortOwners(members: PrOwner[]): PrOwner[] {
  return [...members].sort((a, b) =>
    a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
}

export function toOwners(nodes: (MemberNode | null)[] | null | undefined): PrOwner[] {
  const seen = new Set<string>();
  const members: PrOwner[] = [];
  for (const node of nodes ?? []) {
    const login = node?.login;
    if (!login || seen.has(login)) continue;
    seen.add(login);
    members.push({ login, name: node?.name || null });
  }
  return members;
}

async function tolerate<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitHubError && err.type && NO_OWNERS_ERRORS.has(err.type)) return null;
    throw err;
  }
}

async function fetchMembers(org: string, slug: string): Promise<PrOwners> {
  const members: PrOwner[] = [];
  let teamKey: string | null = null;
  let teamName: string | null = null;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    const data: TeamResponse | null = await tolerate(() =>
      ghGraphql<TeamResponse>(TEAM_MEMBERS_QUERY, { org, slug, cursor }));

    const team = data?.organization?.team;
    if (!team) break;

    // `combinedSlug` is `org/team-slug`, which is exactly what
    // `requestReviewsByLogin` demands — a bare slug is rejected.
    teamKey = team.combinedSlug || `${org}/${slug}`;
    teamName = team.name || slug;
    members.push(...toOwners(team.members?.nodes));

    if (team.members?.pageInfo?.hasNextPage !== true) break;
    cursor = team.members.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  if (!teamKey) return EMPTY;
  return { teamKey, teamName, members: sortOwners(members) };
}

async function fetchOwners(ref: PrRef): Promise<PrOwners> {
  const data = await tolerate(() =>
    ghGraphql<PropertiesResponse>(REPO_PROPERTIES_QUERY, { owner: ref.owner, repo: ref.repo }));

  const slug = ownerTeamSlug(data?.repository?.repositoryCustomPropertyValues?.nodes);
  if (!slug) return EMPTY;

  return fetchMembers(ref.owner, slug);
}

export async function getOwners(ref: PrRef): Promise<PrOwners> {
  const key = `${ref.owner}/${ref.repo}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const owners = await fetchOwners(ref);
  cache.set(key, owners);
  return owners;
}

export const __test__ = { cache };
