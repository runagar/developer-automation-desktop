import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceManager } from './workspaces';
import { WorkspaceGroup } from './types';

let tmpDir: string;
let configPath: string;

const SEED: WorkspaceGroup[] = [
  {
    group: 'Alpha',
    workspaces: [
      { key: 'AAA', repo: 'repo-a', workingDir: '/tmp/repo-a' },
      { key: 'BBB', repo: 'repo-b', workingDir: '/tmp/repo-b' },
      { key: 'CCC', repo: 'repo-c', workingDir: '/tmp/repo-c' },
    ],
  },
  {
    group: 'Beta',
    workspaces: [
      { key: 'DDD', repo: 'repo-d', workingDir: '/tmp/repo-d' },
    ],
  },
];

function makeManager(): WorkspaceManager {
  return new WorkspaceManager(configPath, tmpDir);
}

function readFileGroups(): WorkspaceGroup[] {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-workspaces-'));
  configPath = path.join(tmpDir, 'workspaces.json');
  fs.writeFileSync(configPath, JSON.stringify(SEED, null, 2), 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WorkspaceManager.renameWorkspace', () => {
  it('is a no-op when the key is unchanged, and does not rewrite the file', () => {
    const before = fs.readFileSync(configPath, 'utf-8');
    const result = makeManager().renameWorkspace('AAA', 'AAA');
    expect(result).toEqual({ renamed: true });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('renames the entry', () => {
    const result = makeManager().renameWorkspace('BBB', 'ZZZ');
    expect(result).toEqual({ renamed: true });
    expect(readFileGroups()[0].workspaces.map((w) => w.key)).toEqual(['AAA', 'ZZZ', 'CCC']);
  });

  it('preserves group membership and position within the group', () => {
    makeManager().renameWorkspace('BBB', 'ZZZ');
    const groups = readFileGroups();

    expect(groups.map((g) => g.group)).toEqual(['Alpha', 'Beta']);
    expect(groups[0].workspaces[1]).toEqual({
      key: 'ZZZ', repo: 'repo-b', workingDir: '/tmp/repo-b',
    });
    // Every other entry is untouched.
    expect(groups[0].workspaces[0]).toEqual(SEED[0].workspaces[0]);
    expect(groups[0].workspaces[2]).toEqual(SEED[0].workspaces[2]);
    expect(groups[1]).toEqual(SEED[1]);
  });

  it('rejects an invalid key and leaves the file unchanged', () => {
    const before = fs.readFileSync(configPath, 'utf-8');
    const result = makeManager().renameWorkspace('AAA', 'lower case');

    expect(result.renamed).toBe(false);
    expect(result.error).toMatch(/Key must be/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects an empty key', () => {
    expect(makeManager().renameWorkspace('AAA', '').renamed).toBe(false);
  });

  it('rejects a collision within the same group', () => {
    const before = fs.readFileSync(configPath, 'utf-8');
    const result = makeManager().renameWorkspace('AAA', 'CCC');

    expect(result.renamed).toBe(false);
    expect(result.error).toContain('already exists');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects a collision with a workspace in a different group', () => {
    // Keys are globally unique, so the scan must cross group boundaries.
    const result = makeManager().renameWorkspace('AAA', 'DDD');
    expect(result.renamed).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('rejects an unknown source key', () => {
    const result = makeManager().renameWorkspace('NOPE', 'ZZZ');
    expect(result.renamed).toBe(false);
    expect(result.error).toContain('no longer exists');
  });

  it('checks existence before collision, so a bad rename reports the real problem', () => {
    const result = makeManager().renameWorkspace('NOPE', 'AAA');
    expect(result.error).toContain('no longer exists');
  });

  it('allows renaming to a key freed earlier in the same session', () => {
    const mgr = makeManager();
    expect(mgr.renameWorkspace('AAA', 'ZZZ').renamed).toBe(true);
    expect(mgr.renameWorkspace('BBB', 'AAA').renamed).toBe(true);
    expect(readFileGroups()[0].workspaces.map((w) => w.key)).toEqual(['ZZZ', 'AAA', 'CCC']);
  });
});
