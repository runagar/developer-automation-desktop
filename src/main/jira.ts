import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { JiraIssue, JiraLinkedIssue } from './types';
import { RefreshOutcome } from './jiraRefresh';
import { convertWikiToMarkdown } from './wikiToMarkdown';
import { resolveCredential } from './credentials';

let cachedPat: string | null = null;
let cachedBaseUrl: string | null = null;

// In-memory cache: discovered custom epic-link field ID, keyed by base URL
const epicFieldCache = new Map<string, string | null>();

const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'priority', 'issuetype',
  'assignee', 'reporter', 'labels', 'fixVersions', 'components',
  'issuelinks', 'parent',
].join(',');

function jiraHeaders(pat: string): Record<string, string> {
  return { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };
}

export function clearCredentialCache(): void {
  cachedPat = null;
  cachedBaseUrl = null;
}

function loadCredentials(): { pat: string; baseUrl: string } {
  if (cachedPat && cachedBaseUrl) {
    return { pat: cachedPat, baseUrl: cachedBaseUrl };
  }

  const dataDir = path.join(app.getPath('userData'), 'dad');
  const pat = resolveCredential(dataDir, 'ATLASSIAN_PAT');
  const baseUrl = resolveCredential(dataDir, 'ATLASSIAN_BASE_URL');

  if (!pat || !baseUrl) {
    throw new Error(
      'Missing Jira credentials. Configure them in Settings → Credentials, ' +
      'or set ATLASSIAN_PAT and ATLASSIAN_BASE_URL as environment variables.'
    );
  }

  cachedPat = pat;
  cachedBaseUrl = baseUrl.replace(/\/$/, '');
  return { pat: cachedPat, baseUrl: cachedBaseUrl };
}

export async function fetchJiraIssue(key: string): Promise<JiraIssue> {
  const { pat, baseUrl } = loadCredentials();

  // Try to discover the custom epic-link field on first call
  if (!epicFieldCache.has(baseUrl)) {
    await discoverEpicField(baseUrl, pat);
  }
  const epicFieldId = epicFieldCache.get(baseUrl) ?? null;

  const fields = epicFieldId ? `${ISSUE_FIELDS},${epicFieldId}` : ISSUE_FIELDS;
  const url = `${baseUrl}/rest/api/latest/issue/${encodeURIComponent(key)}?fields=${fields}`;

  const response = await fetch(url, {
    headers: jiraHeaders(pat),
  });

  if (!response.ok) {
    if (response.status === 404) throw new Error(`Issue ${key} not found`);
    throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  const f = data.fields ?? {};
  const summary: string = f.summary ?? '';
  const rawDesc: string = f.description ?? '';
  const description = convertWikiToMarkdown(rawDesc);

  // Determine parent/epic key
  let parentKey: string | null = f.parent?.key ?? null;
  if (!parentKey && epicFieldId && f[epicFieldId]) {
    parentKey = typeof f[epicFieldId] === 'string' ? f[epicFieldId] : f[epicFieldId]?.key ?? null;
  }

  const linkedIssues: JiraLinkedIssue[] = (f.issuelinks ?? [])
    .map((link: any): JiraLinkedIssue | null => {
      if (link.outwardIssue) {
        return {
          key: link.outwardIssue.key,
          summary: link.outwardIssue.fields?.summary ?? '',
          relation: link.type?.outward ?? '',
        };
      }
      if (link.inwardIssue) {
        return {
          key: link.inwardIssue.key,
          summary: link.inwardIssue.fields?.summary ?? '',
          relation: link.type?.inward ?? '',
        };
      }
      return null;
    })
    .filter(Boolean) as JiraLinkedIssue[];

  return {
    __schemaVersion: 4,
    key: data.key ?? key,
    summary,
    description,
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? '',
    priority: f.priority?.name ?? '',
    issueType: f.issuetype?.name ?? '',
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    labels: f.labels ?? [],
    fixVersions: (f.fixVersions ?? []).map((v: any) => v.name),
    components: (f.components ?? []).map((c: any) => c.name),
    parentKey,
    linkedIssues,
  };
}

// --- Epic field discovery ---

async function discoverEpicField(baseUrl: string, pat: string): Promise<void> {
  const headers = jiraHeaders(pat);
  // Try multiple API versions — Jira Server uses v2, Jira Cloud uses v3
  for (const ver of ['latest', '3', '2']) {
    try {
      const response = await fetch(`${baseUrl}/rest/api/${ver}/field`, { headers });
      if (!response.ok) continue;
      const fields = await response.json() as any[];
      const epicField = fields.find((f: any) =>
        f.custom && typeof f.name === 'string' && /epic link/i.test(f.name)
      );
      epicFieldCache.set(baseUrl, epicField?.id ?? null);
      if (epicField) console.log(`[jira] Discovered custom epic field: ${epicField.id} (${epicField.name}) via api/${ver}`);
      return;
    } catch {
      continue;
    }
  }
  epicFieldCache.set(baseUrl, null);
}

// --- Recursive issue-graph fetcher ---

export interface FetchGraphOpts {
  linkedDepth: number;
  linkLimit: number;
  maxIssues: number;
  whitelist: string[];
  maintenanceEpic: string;
  /**
   * Resolve one issue: fetch and write it, or skip it as already fresh.
   *
   * Injected so this module stays a Jira API client with no knowledge of the
   * vault or the filesystem, and so the traversal can be unit tested.
   */
  resolve: (key: string, kind: 'primary' | 'secondary') => Promise<RefreshOutcome>;
}

function matchesWhitelist(key: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  const prefix = key.replace(/-\d+$/, '');
  return whitelist.includes(prefix);
}

export async function fetchIssueGraph(
  key: string,
  opts: FetchGraphOpts
): Promise<{ primary: JiraIssue; refreshed: string[] }> {
  const { linkedDepth, linkLimit, maxIssues, whitelist, maintenanceEpic, resolve } = opts;
  const visited = new Set<string>();
  /**
   * Keys actually refetched during this crawl, tracked separately from
   * `visited`: an epic reached first through the BFS is visited but must still
   * have its children rediscovered, which a `visited` check alone would skip.
   */
  const refreshed = new Set<string>();

  // The primary is never subject to the freshness windows — the user named it.
  const primaryOutcome = await resolve(key, 'primary');
  if (!primaryOutcome.issue) throw (primaryOutcome as { error: Error }).error;
  const primary = primaryOutcome.issue;
  visited.add(primary.key);
  if (primaryOutcome.status === 'refreshed') refreshed.add(primary.key);

  // BFS linked issues
  type QueueEntry = { key: string; depth: number };
  const queue: QueueEntry[] = primary.linkedIssues
    .slice(0, linkLimit)
    .map((li) => ({ key: li.key, depth: 1 }));

  while (queue.length > 0 && visited.size < maxIssues) {
    const entry = queue.shift()!;
    if (visited.has(entry.key)) continue;
    if (entry.key === maintenanceEpic) { visited.add(entry.key); continue; }
    if (!matchesWhitelist(entry.key, whitelist)) continue;

    visited.add(entry.key);
    const outcome = await resolve(entry.key, 'secondary');
    if (outcome.status === 'failed') {
      console.log(`[jira] Skipping linked issue ${entry.key}: ${outcome.error.message}`);
      continue;
    }
    if (outcome.status === 'refreshed') refreshed.add(entry.key);

    // A note skipped as fresh contributes no links to the queue. Unreachable
    // at linkedDepth 1 (1 < 1 is false); if depth is ever raised, seed the
    // queue from the cached note's links instead.
    if (entry.depth < linkedDepth) {
      for (const li of outcome.issue.linkedIssues.slice(0, linkLimit)) {
        if (!visited.has(li.key)) {
          queue.push({ key: li.key, depth: entry.depth + 1 });
        }
      }
    }
  }

  // --- Epic awareness ---
  // Children are discovered by a separate query, so an active epic can gain
  // children without any of its own fields changing. Rediscovery is therefore
  // tied to whether the epic was refreshed, not to whether it was visited.
  const epicKey = await selectEpicForChildren(primary, {
    visited, refreshed, related: null, maxIssues, whitelist, maintenanceEpic, resolve,
  });

  if (epicKey) {
    const primaryProject = primary.key.replace(/-\d+$/, '');
    try {
      const childKeys = await fetchEpicChildKeys(epicKey, primaryProject, maxIssues - visited.size);
      for (const childKey of childKeys) {
        if (visited.has(childKey) || visited.size >= maxIssues) continue;
        visited.add(childKey);
        const outcome = await resolve(childKey, 'secondary');
        if (outcome.status === 'failed') {
          console.log(`[jira] Skipping epic child ${childKey}: ${outcome.error.message}`);
          continue;
        }
        if (outcome.status === 'refreshed') refreshed.add(childKey);
      }
    } catch (err) {
      console.log(`[jira] Skipping epic children for ${epicKey}: ${(err as Error).message}`);
    }
  }

  return { primary, refreshed: [...refreshed] };
}

/**
 * Decide which epic, if any, should have its children rediscovered, refreshing
 * the parent epic on the way if it has not been seen yet.
 *
 * Returns null when there is no epic, when it is excluded, or when the epic's
 * note is still fresh — in which case its children keep their cached state.
 */
async function selectEpicForChildren(
  primary: JiraIssue,
  ctx: {
    visited: Set<string>;
    refreshed: Set<string>;
    related: null;
    maxIssues: number;
    whitelist: string[];
    maintenanceEpic: string;
    resolve: FetchGraphOpts['resolve'];
  }
): Promise<string | null> {
  const { visited, refreshed, maxIssues, whitelist, maintenanceEpic, resolve } = ctx;

  // A directly named epic is always refreshed as the primary, so its children
  // are always rediscovered.
  if (primary.issueType === 'Epic') {
    return primary.key === maintenanceEpic ? null : primary.key;
  }

  const parentKey = primary.parentKey;
  if (!parentKey || parentKey === maintenanceEpic) return null;
  if (!matchesWhitelist(parentKey, whitelist)) return null;

  // Reached through the BFS already. It was refreshed there, so its children
  // still need discovery — the old `!visited.has(...)` guard skipped this case
  // entirely whenever the parent epic was also a linked issue.
  if (visited.has(parentKey)) {
    return refreshed.has(parentKey) ? parentKey : null;
  }

  if (visited.size >= maxIssues) return null;

  visited.add(parentKey);
  const outcome = await resolve(parentKey, 'secondary');
  if (outcome.status === 'failed') {
    console.log(`[jira] Skipping parent epic ${parentKey}: ${outcome.error.message}`);
    return null;
  }
  if (outcome.status !== 'refreshed') return null;

  refreshed.add(parentKey);
  return parentKey;
}

/**
 * Fetch the keys of an epic's children, filtered to a specific project via JQL.
 *
 * Returns keys rather than issues so the caller can skip a child that is still
 * fresh *before* paying for its request.
 *
 * Throws on a failed query. Returning an empty list would be indistinguishable
 * from an epic that genuinely has no children, which would let a transient JQL
 * failure stamp the epic fresh and suppress rediscovery for up to a month.
 */
async function fetchEpicChildKeys(epicKey: string, project: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const { pat, baseUrl } = loadCredentials();

  // Try "Epic Link" = KEY first (standard name), fall back to parent = KEY
  const jql = `("Epic Link" = "${epicKey}" OR parent = "${epicKey}") AND project = "${project}" ORDER BY key ASC`;

  const url = `${baseUrl}/rest/api/latest/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(limit, 50)}&fields=key`;
  const response = await fetch(url, {
    headers: jiraHeaders(pat),
  });

  if (!response.ok) {
    throw new Error(`Epic children JQL failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  return (data.issues ?? []).map((i: any) => i.key);
}
