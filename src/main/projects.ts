import * as fs from 'fs';
import { ProjectEntry, ProjectGroup } from './types';

export class ProjectManager {
  constructor(private readonly configPath: string) {}

  getGroups(): ProjectGroup[] {
    return this.getProjectGroups();
  }

  getEntries(): ProjectEntry[] {
    return this.getProjectEntries();
  }

  getProjectGroups(): ProjectGroup[] {
    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(content) as ProjectGroup[];
    } catch {
      return [];
    }
  }

  getProjectEntries(): ProjectEntry[] {
    return this.getProjectGroups().flatMap((g) => g.workspaces);
  }

  addProject(key: string, repo: string, group: string): ProjectEntry {
    const groups = this.getProjectGroups();
    if (groups.some((g) => g.workspaces.some((w) => w.key === key))) {
      throw new Error(`Workspace key "${key}" already exists`);
    }
    const targetGroup = groups.find((g) => g.group === group);
    if (!targetGroup) {
      throw new Error(`Group "${group}" does not exist`);
    }
    const newEntry: ProjectEntry = {
      key,
      repo,
      workingDir: `/home/rulu/projects/${repo}`,
    };
    targetGroup.workspaces.push(newEntry);
    fs.writeFileSync(this.configPath, JSON.stringify(groups, null, 2), 'utf-8');
    return newEntry;
  }

  removeProject(key: string): void {
    const groups = this.getProjectGroups();
    for (const g of groups) {
      g.workspaces = g.workspaces.filter((w) => w.key !== key);
    }
    fs.writeFileSync(this.configPath, JSON.stringify(groups, null, 2), 'utf-8');
  }

  addGroup(name: string): void {
    const groups = this.getProjectGroups();
    if (groups.some((g) => g.group === name)) {
      throw new Error(`Group "${name}" already exists`);
    }
    groups.push({ group: name, workspaces: [] });
    fs.writeFileSync(this.configPath, JSON.stringify(groups, null, 2), 'utf-8');
  }

  removeGroup(name: string): void {
    const groups = this.getProjectGroups();
    const target = groups.find((g) => g.group === name);
    if (!target) return;
    if (target.workspaces.length > 0) {
      throw new Error(`Group "${name}" still has workspaces`);
    }
    const filtered = groups.filter((g) => g.group !== name);
    fs.writeFileSync(this.configPath, JSON.stringify(filtered, null, 2), 'utf-8');
  }

  reorderGroup(name: string, toIndex: number): void {
    const groups = this.getProjectGroups();
    const fromIndex = groups.findIndex((g) => g.group === name);
    if (fromIndex === -1) return;
    const [group] = groups.splice(fromIndex, 1);
    const clampedIndex = Math.min(toIndex, groups.length);
    groups.splice(clampedIndex, 0, group);
    fs.writeFileSync(this.configPath, JSON.stringify(groups, null, 2), 'utf-8');
  }

  moveWorkspace(key: string, toGroup: string, toIndex: number): void {
    const groups = this.getProjectGroups();
    let workspace: ProjectEntry | undefined;
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
    const clampedIndex = Math.min(toIndex, target.workspaces.length);
    target.workspaces.splice(clampedIndex, 0, workspace);
    fs.writeFileSync(this.configPath, JSON.stringify(groups, null, 2), 'utf-8');
  }
}
