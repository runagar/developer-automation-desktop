import * as fs from 'fs';
import * as path from 'path';
import { DiscoveredWorkspace, WorkspaceEntry, WorkspaceGroup } from './types';
import { getDefaultWorkingRoot } from './settings';
import { isValidKey, KEY_FORMAT_HINT } from './workspaceKeys';

export interface AddWorkspaceOpts {
  key: string;
  repo: string;
  group: string;
  wdr?: string;
  createMissingDir?: boolean;
}

export interface AddWorkspaceResult {
  created: boolean;
  entry?: WorkspaceEntry;
  path?: string;
  error?: string;
}

export interface SaveDiscoveredResult {
  saved: boolean;
  error?: string;
}

export class WorkspaceManager {
  constructor(
    private readonly configPath: string,
    private readonly dataDir: string,
  ) {}

  getGroups(): WorkspaceGroup[] {
    return this.readGroups();
  }

  getEntries(): WorkspaceEntry[] {
    return this.readGroups().flatMap((g) => g.workspaces);
  }

  addWorkspace(opts: AddWorkspaceOpts): AddWorkspaceResult {
    const { key, repo, group, wdr, createMissingDir } = opts;
    const groups = this.readGroups();

    if (groups.some((g) => g.workspaces.some((w) => w.key === key))) {
      return { created: false, error: `Workspace key "${key}" already exists` };
    }
    if (!isValidKey(key)) {
      return { created: false, error: `Key must be ${KEY_FORMAT_HINT}` };
    }
    const targetGroup = groups.find((g) => g.group === group);
    if (!targetGroup) {
      return { created: false, error: `Group "${group}" does not exist` };
    }

    // Reject dangerous repo values
    if (!repo || repo.includes('..') || path.isAbsolute(repo)) {
      return { created: false, error: 'Invalid repository name' };
    }

    const root = wdr || getDefaultWorkingRoot(this.dataDir);
    const workingDir = path.join(root, repo);

    // Validate path
    try {
      const stat = fs.statSync(workingDir);
      if (!stat.isDirectory()) {
        return { created: false, error: `Path exists but is not a directory: ${workingDir}` };
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        if (!createMissingDir) {
          return { created: false, path: workingDir };
        }
        // Create the directory
        try {
          fs.mkdirSync(workingDir, { recursive: true });
        } catch (mkdirErr: any) {
          return { created: false, error: `Failed to create directory: ${mkdirErr?.message ?? 'unknown error'}` };
        }
      } else {
        return { created: false, error: `Cannot access path: ${err?.message ?? 'unknown error'}` };
      }
    }

    const newEntry: WorkspaceEntry = { key, repo, workingDir };
    targetGroup.workspaces.push(newEntry);
    this.writeGroups(groups);
    return { created: true, entry: newEntry };
  }

  /**
   * Append a batch of discovered workspaces to `group` in a single write.
   *
   * All-or-nothing: every entry is validated first and nothing is written if
   * any check fails. Every `await` deliberately happens *before* readGroups()
   * so there is no suspension point between reading and writing the file — a
   * concurrent mutation can never be clobbered by a stale snapshot.
   */
  async saveDiscovered(
    entries: DiscoveredWorkspace[],
    group: string,
  ): Promise<SaveDiscoveredResult> {
    const groupName = group.trim();
    if (!groupName) return { saved: false, error: 'Group name is required' };
    if (entries.length === 0) return { saved: false, error: 'No workspaces to save' };

    // --- Async validation (must complete before touching the file) ---
    for (const entry of entries) {
      try {
        const stat = await fs.promises.stat(entry.workingDir);
        if (!stat.isDirectory()) {
          return { saved: false, error: `Not a directory: ${entry.workingDir}` };
        }
      } catch {
        return { saved: false, error: `Directory no longer exists: ${entry.workingDir}` };
      }
    }

    // --- Synchronous read → validate → write ---
    const groups = this.readGroups();
    const existingKeys = new Set(groups.flatMap((g) => g.workspaces.map((w) => w.key)));
    const existingDirs = new Set(
      groups.flatMap((g) => g.workspaces.map((w) => path.resolve(w.workingDir))),
    );
    const batchKeys = new Set<string>();
    const batchDirs = new Set<string>();

    for (const entry of entries) {
      if (!isValidKey(entry.key)) {
        return { saved: false, error: `Invalid key "${entry.key}" — ${KEY_FORMAT_HINT}` };
      }
      if (batchKeys.has(entry.key)) {
        return { saved: false, error: `Duplicate key "${entry.key}" in the list` };
      }
      if (existingKeys.has(entry.key)) {
        return { saved: false, error: `Key "${entry.key}" already exists` };
      }
      if (!entry.repo || !path.isAbsolute(entry.workingDir)
          || path.basename(entry.workingDir) !== entry.repo) {
        return { saved: false, error: `Invalid workspace path for "${entry.repo}"` };
      }

      const resolved = path.resolve(entry.workingDir);
      if (batchDirs.has(resolved)) {
        return { saved: false, error: `Duplicate directory in the list: ${resolved}` };
      }
      if (existingDirs.has(resolved)) {
        return { saved: false, error: `Workspace already exists for ${resolved}` };
      }

      batchKeys.add(entry.key);
      batchDirs.add(resolved);
    }

    let target = groups.find((g) => g.group.toLowerCase() === groupName.toLowerCase());
    if (!target) {
      target = { group: groupName, workspaces: [] };
      groups.push(target);
    }
    for (const entry of entries) {
      target.workspaces.push({ key: entry.key, repo: entry.repo, workingDir: entry.workingDir });
    }

    try {
      this.writeGroups(groups);
    } catch (err: any) {
      return { saved: false, error: `Failed to save workspaces: ${err?.message ?? 'unknown error'}` };
    }
    return { saved: true };
  }

  removeWorkspace(key: string): void {
    const groups = this.readGroups();
    for (const g of groups) {
      g.workspaces = g.workspaces.filter((w) => w.key !== key);
    }
    this.writeGroups(groups);
  }

  addGroup(name: string): void {
    const groups = this.readGroups();
    if (groups.some((g) => g.group === name)) {
      throw new Error(`Group "${name}" already exists`);
    }
    groups.push({ group: name, workspaces: [] });
    this.writeGroups(groups);
  }

  removeGroup(name: string): void {
    const groups = this.readGroups();
    const target = groups.find((g) => g.group === name);
    if (!target) return;
    if (target.workspaces.length > 0) {
      throw new Error(`Group "${name}" still has workspaces`);
    }
    this.writeGroups(groups.filter((g) => g.group !== name));
  }

  reorderGroup(name: string, toIndex: number): void {
    const groups = this.readGroups();
    const fromIndex = groups.findIndex((g) => g.group === name);
    if (fromIndex === -1) return;
    const [group] = groups.splice(fromIndex, 1);
    groups.splice(Math.min(toIndex, groups.length), 0, group);
    this.writeGroups(groups);
  }

  moveWorkspace(key: string, toGroup: string, toIndex: number): void {
    const groups = this.readGroups();
    let workspace: WorkspaceEntry | undefined;
    for (const g of groups) {
      const idx = g.workspaces.findIndex((w) => w.key === key);
      if (idx !== -1) {
        [workspace] = g.workspaces.splice(idx, 1);
        break;
      }
    }
    if (!workspace) return;
    const target = groups.find((g) => g.group === toGroup);
    if (!target) return;
    target.workspaces.splice(Math.min(toIndex, target.workspaces.length), 0, workspace);
    this.writeGroups(groups);
  }

  private readGroups(): WorkspaceGroup[] {
    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(content) as WorkspaceGroup[];
    } catch {
      return [];
    }
  }

  private writeGroups(groups: WorkspaceGroup[]): void {
    // Atomic write: tmp file + rename, so a crash mid-write can never truncate
    // the user's workspace list.
    const tmpPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(groups, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.configPath);
  }
}
