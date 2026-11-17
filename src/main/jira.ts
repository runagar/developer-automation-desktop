import { JiraClient } from '@rulu/jira-tools';
import { JiraIssue } from './types';
import { RefreshOutcome } from './jiraRefresh';

const client = new JiraClient();

export async function fetchJiraIssue(key: string): Promise<JiraIssue> {
  return client.fetchIssue(key);
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
      const childKeys = await client.fetchEpicChildKeys(epicKey, primaryProject, maxIssues - visited.size);
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
