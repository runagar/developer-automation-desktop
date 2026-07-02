import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceEntry, WorkspaceGroup } from './types';
import { getDefaultWorkingRoot } from './settings';

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
    fs.writeFileSync(this.configPath, JSON.stringify(groups, null, 2), 'utf-8');
  }
}
