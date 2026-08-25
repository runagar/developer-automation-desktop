import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredWorkspace, WorkspaceEntry } from './types';
import { abbreviateRepo, uniqueKey } from './workspaceKeys';

/**
 * Scan `root` one level deep and return every directory that is not already a
 * saved workspace, with a suggested key assigned to each.
 *
 * A missing or unreadable root is a normal state (the user may not have created
 * it yet), so all errors resolve to an empty list rather than surfacing.
 */
export async function discoverWorkspaces(
  root: string,
  existing: WorkspaceEntry[],
): Promise<DiscoveredWorkspace[]> {
  if (!root) return [];

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (name.startsWith('.')) continue;

    if (dirent.isDirectory()) {
      candidates.push(name);
    } else if (dirent.isSymbolicLink()) {
      try {
        const stat = await fs.promises.stat(path.join(root, name));
        if (stat.isDirectory()) candidates.push(name);
      } catch {
        // Broken symlink — skip it.
      }
    }
  }

  candidates.sort((a, b) => a.localeCompare(b));

  const existingDirs = new Set(existing.map((w) => path.resolve(w.workingDir)));
  const taken = new Set(existing.map((w) => w.key));

  const results: DiscoveredWorkspace[] = [];
  for (const repo of candidates) {
    const workingDir = path.resolve(root, repo);
    if (existingDirs.has(workingDir)) continue;

    const key = uniqueKey(abbreviateRepo(repo), taken);
    taken.add(key);
    results.push({ key, repo, workingDir });
  }

  return results;
}
