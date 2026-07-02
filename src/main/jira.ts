import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { JiraIssue, JiraLinkedIssue } from './types';
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

export function clearCredentialCache(): void {
  cachedPat = null;
  cachedBaseUrl = null;
}

function loadCredentials(): { pat: string; baseUrl: string } {
  if (cachedPat && cachedBaseUrl) {
    return { pat: cachedPat, baseUrl: cachedBaseUrl };
  }

  const dataDir = path.join(app.getPath('userData'), 'agent-smith');
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
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
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
    __schemaVersion: 3,
    key: data.key ?? key,
    summary,
    description,
    status: f.status?.name ?? '',
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
  const headers = { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };
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
}

function matchesWhitelist(key: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  const prefix = key.replace(/-\d+$/, '');
  return whitelist.includes(prefix);
}

export async function fetchIssueGraph(
  key: string,
  opts: FetchGraphOpts
): Promise<{ primary: JiraIssue; related: JiraIssue[]; filtered: number }> {
  const { linkedDepth, linkLimit, maxIssues, whitelist, maintenanceEpic } = opts;
  const visited = new Set<string>();
  const related: JiraIssue[] = [];
  let filtered = 0;

  // Fetch primary
  const primary = await fetchJiraIssue(key);
  visited.add(primary.key);

  // BFS linked issues
  type QueueEntry = { key: string; depth: number };
  const queue: QueueEntry[] = primary.linkedIssues
    .slice(0, linkLimit)
    .map((li) => ({ key: li.key, depth: 1 }));

  while (queue.length > 0 && visited.size < maxIssues) {
    const entry = queue.shift()!;
    if (visited.has(entry.key)) continue;
    if (entry.key === maintenanceEpic) { visited.add(entry.key); continue; }
    if (!matchesWhitelist(entry.key, whitelist)) { filtered++; continue; }

    visited.add(entry.key);
    try {
      const issue = await fetchJiraIssue(entry.key);
      related.push(issue);

      if (entry.depth < linkedDepth) {
        for (const li of issue.linkedIssues.slice(0, linkLimit)) {
          if (!visited.has(li.key)) {
            queue.push({ key: li.key, depth: entry.depth + 1 });
          }
        }
      }
    } catch (err) {
      console.log(`[jira] Skipping linked issue ${entry.key}: ${(err as Error).message}`);
    }
  }

  // Epic awareness — primary issue's parent only (per decision)
  if (
    primary.parentKey &&
    primary.parentKey !== maintenanceEpic &&
    !visited.has(primary.parentKey) &&
    matchesWhitelist(primary.parentKey, whitelist) &&
    visited.size < maxIssues
  ) {
    visited.add(primary.parentKey);
    try {
      const epic = await fetchJiraIssue(primary.parentKey);
      related.push(epic);

      // Fetch epic children belonging to the same project as the primary issue
      const primaryProject = primary.key.replace(/-\d+$/, '');
      try {
        const children = await fetchEpicChildren(primary.parentKey, primaryProject, maxIssues - visited.size);
        for (const child of children) {
          if (!visited.has(child.key)) {
            visited.add(child.key);
            related.push(child);
          }
        }
      } catch (err) {
        console.log(`[jira] Skipping epic children for ${primary.parentKey}: ${(err as Error).message}`);
      }
    } catch (err) {
      console.log(`[jira] Skipping parent epic ${primary.parentKey}: ${(err as Error).message}`);
    }
  }

  return { primary, related, filtered };
}

/**
 * Fetch children of an epic filtered to a specific project via JQL.
 */
async function fetchEpicChildren(epicKey: string, project: string, limit: number): Promise<JiraIssue[]> {
  if (limit <= 0) return [];
  const { pat, baseUrl } = loadCredentials();

  // Try "Epic Link" = KEY first (standard name), fall back to parent = KEY
  const jql = `("Epic Link" = "${epicKey}" OR parent = "${epicKey}") AND project = "${project}" ORDER BY key ASC`;

  const url = `${baseUrl}/rest/api/latest/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(limit, 50)}&fields=key`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    console.log(`[jira] Epic children JQL failed: ${response.status}`);
    return [];
  }

  const data = await response.json() as any;
  const keys: string[] = (data.issues ?? []).map((i: any) => i.key);

  const results: JiraIssue[] = [];
  for (const key of keys) {
    try {
      results.push(await fetchJiraIssue(key));
    } catch (err) {
      console.log(`[jira] Skipping epic child ${key}: ${(err as Error).message}`);
    }
  }
  return results;
}
