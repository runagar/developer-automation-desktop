import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './sessions';
import {
  capturePane, getOpenCodeConnection, hasTmuxSession, isAgentTmuxAlive, isLegacyOpenCodeRuntime,
  killTmuxSession, readOpenCodeCliVersion, tmuxSessionName,
} from './tmux';
import { getOpenCodeConversation, isSupportedOpenCodeVersion, requestOpenCode } from './opencode';
import { readSessionState } from './statePoller';

vi.mock('electron', () => ({}));

const exec = promisify(execFile);

describe.skipIf(process.env.DAD_OPENCODE_SMOKE !== '1')('real OpenCode runtime', () => {
  let directory: string;
  let workspace: string;
  let manager: SessionManager;
  const names = new Set<string>();
  const environment = { ...process.env };

  beforeAll(async () => {
    await fs.mkdir(path.resolve('tmp'), { recursive: true });
    directory = await fs.mkdtemp(path.resolve('tmp/opencode-smoke-'));
    workspace = path.join(directory, 'project with spaces');
    await fs.mkdir(workspace);
    await exec('git', ['init', '-q', workspace]);
    const socketDirectory = path.join(directory, 'tmux');
    await fs.mkdir(socketDirectory);
    delete process.env.TMUX;
    process.env.TMUX_TMPDIR = socketDirectory;
    process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) {
      process.env[`XDG_${kind}_HOME`] = path.join(directory, kind.toLowerCase());
    }
    process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    process.env.OPENCODE_DISABLE_LSP_DOWNLOAD = 'true';
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
    process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    manager = new SessionManager(path.join(directory, 'dad'));
    await manager.initialize();
  });

  async function createReady(options: { workingDir: string; name: string }) {
    const session = await manager.createSession(options);
    names.add(tmuxSessionName(session.id));
    await vi.waitFor(() => {
      expect(manager.getSession(session.id)?.dead).toBe(false);
      expect(manager.getPollableSessions().some((candidate) => candidate.id === session.id)).toBe(true);
    }, { timeout: 60000, interval: 100 });
    return manager.getSession(session.id)!;
  }

  afterAll(async () => {
    manager?.getSessions().forEach((session) => names.add(tmuxSessionName(session.id)));
    for (const name of names) {
      await killTmuxSession(name);
      expect(await hasTmuxSession(name)).toBe(false);
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in environment)) delete process.env[key];
    }
    Object.assign(process.env, environment);
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }, 30000);

  it('creates, reuses, cold-restores, and destroys the original conversation, not the newest one', async () => {
    // Given
    const first = await createReady({ workingDir: workspace, name: 'DAD smoke original' });
    names.add(tmuxSessionName(first.id));
    const second = await createReady({ workingDir: workspace, name: 'DAD smoke newer' });
    names.add(tmuxSessionName(second.id));
    expect(first.agentSessionId).toBeTruthy();
    expect(second.agentSessionId).not.toBe(first.agentSessionId);
    const name = tmuxSessionName(first.id);
    const original = await getOpenCodeConnection(name, workspace);
    await expect(readSessionState(first)).resolves.toBe('idle');
    const unauthenticated = await fetch(`http://127.0.0.1:${original.port}/api/info`);
    expect(unauthenticated.status).toBe(401);
    manager = new SessionManager(path.join(directory, 'dad'));
    await manager.initialize();
    manager.setWindow(null);
    await manager.restoreSessions();
    expect(await getOpenCodeConnection(name, workspace)).toEqual(original);
    await exec('tmux', ['resize-window', '-t', name, '-x', '160', '-y', '40']);
    await vi.waitFor(async () => {
      expect(await capturePane(name)).toContain('DAD smoke original');
    }, { timeout: 20000, interval: 200 });
    await manager.archiveSession(first.id);
    await manager.unarchiveSession(first.id);
    expect((await getOpenCodeConnection(name, workspace)).port).toBe(original.port);
    await manager.archiveSession(first.id);
    await manager.evictArchivedSessions();
    expect(await hasTmuxSession(name)).toBe(false);
    await expect(requestOpenCode(original, '/api/info', { timeoutMs: 500 })).rejects.toThrow();
    // When
    await manager.unarchiveSession(first.id);
    const restored = await getOpenCodeConnection(name, workspace);
    // Then
    expect(await isAgentTmuxAlive(name, 'opencode')).toBe(true);
    expect(await getOpenCodeConversation(restored, first.agentSessionId!)).toMatchObject({ id: first.agentSessionId });
    await exec('tmux', ['resize-window', '-t', name, '-x', '160', '-y', '40']);
    await vi.waitFor(async () => {
      expect(await capturePane(name)).toContain('DAD smoke original');
    }, { timeout: 20000, interval: 200 });
    await manager.archiveSession(first.id);
    await manager.destroySession(first.id);
    expect(manager.getSession(first.id)).toBeNull();
    await expect(requestOpenCode(restored, '/api/info', { timeoutMs: 500 })).rejects.toThrow();
  }, 120000);

  it('finds OpenCode 2 through the login shell', async () => {
    // Given
    const supported = isSupportedOpenCodeVersion;
    // When
    const version = await readOpenCodeCliVersion();
    // Then
    expect(version).not.toBeNull();
    expect(supported(version ?? '')).toBe(true);
  });

  it('starts the TUI with its session tab strip turned off', async () => {
    // Given
    const session = await createReady({ workingDir: workspace, name: 'DAD smoke tabs' });
    const name = tmuxSessionName(session.id);
    names.add(name);
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', `${name}:dad-opencode-agent`, '#{pane_pid}']);
    // When
    const environment = (await fs.readFile(`/proc/${stdout.trim()}/environ`, 'utf8')).split('\0');
    // Then
    expect(environment).toContain('OPENCODE_CLI_CONFIG_CONTENT={"tabs":{"mode":"off"}}');
  }, 120000);

  it('leaves an OpenCode 1 runtime running until revive replaces it with the same conversation', async () => {
    // Given
    const session = await createReady({ workingDir: workspace, name: 'DAD smoke legacy' });
    const name = tmuxSessionName(session.id);
    names.add(name);
    await killTmuxSession(name);
    await exec('tmux', [
      'new-session', '-d', '-s', name, '-n', 'dad-opencode-server', 'sleep 300',
      ';', 'new-window', '-d', '-t', name, '-n', 'dad-opencode-agent', 'sleep 300',
    ]);
    manager = new SessionManager(path.join(directory, 'dad'));
    await manager.initialize();
    manager.setWindow(null);
    // When
    await manager.restoreSessions();
    const afterRestore = { dead: manager.getSession(session.id)?.dead, running: await hasTmuxSession(name) };
    await manager.reviveSession(session.id);
    // Then
    expect(afterRestore).toEqual({ dead: true, running: true });
    expect(manager.getSession(session.id)).toMatchObject({ dead: false, agentSessionId: session.agentSessionId });
    expect(await isLegacyOpenCodeRuntime(name)).toBe(false);
    expect(await isAgentTmuxAlive(name, 'opencode')).toBe(true);
  }, 180000);

  it.each(['dad-opencode-agent', 'dad-opencode-server'])('cleans a partial runtime after %s dies and revives the same conversation', async (window) => {
    // Given
    const session = await createReady({ workingDir: workspace, name: 'DAD smoke revive' });
    const name = tmuxSessionName(session.id);
    names.add(name);
    const connection = await getOpenCodeConnection(name, workspace);
    await exec('tmux', ['kill-window', '-t', `${name}:${window}`]);
    expect(await isAgentTmuxAlive(name, 'opencode')).toBe(false);
    // When
    await manager.handleDied(session.id);
    await expect(requestOpenCode(connection, '/api/info', { timeoutMs: 500 })).rejects.toThrow();
    await manager.reviveSession(session.id);
    // Then
    expect(manager.getSession(session.id)).toMatchObject({ dead: false, agentSessionId: session.agentSessionId });
    expect(await isAgentTmuxAlive(name, 'opencode')).toBe(true);
  }, 120000);

  it('cleans up a failed resume instead of falling back to a new conversation', async () => {
    // Given
    const name = tmuxSessionName(randomUUID());
    names.add(name);
    const { createTmuxSession } = await import('./tmux');
    const onConversationCreated = vi.fn();
    const onPhase = vi.fn();
    // When
    const result = createTmuxSession(name.slice('smith-'.length), workspace, {
      agent: 'opencode', agentSessionId: 'ses_MissingConversation', name: 'Missing', onConversationCreated, onPhase,
    });
    // Then
    await expect(result).rejects.toThrow('HTTP 404');
    expect(onConversationCreated).not.toHaveBeenCalled();
    expect(onPhase.mock.calls).toEqual([['server'], ['load-conversation']]);
    expect(await hasTmuxSession(name)).toBe(false);
  }, 60000);

  it('terminates an owned child even after its pane leader has exited', async () => {
    // Given
    const name = tmuxSessionName(randomUUID());
    names.add(name);
    const childFile = path.join(directory, 'owned-child.pid');
    await exec('tmux', [
      'new-session', '-d', '-s', name, '-n', 'dad-opencode-server',
      '--', '/bin/bash', '-c', 'sleep 0.2; trap "" HUP; sleep 300 & printf "%s" "$!" > "$1"', 'smoke', childFile,
      ';', 'set-window-option', '-t', `${name}:dad-opencode-server`, 'remain-on-exit', 'on',
    ]);
    await vi.waitFor(async () => { expect(await fs.readFile(childFile, 'utf8')).toMatch(/^\d+$/); });
    const childPid = Number(await fs.readFile(childFile, 'utf8'));
    expect(childPid).toBeGreaterThan(1);
    try {
      await vi.waitFor(async () => {
        expect((await exec('tmux', ['display-message', '-p', '-t', name, '#{pane_dead}'])).stdout.trim()).toBe('1');
      });
      // When
      await killTmuxSession(name);
      // Then
      expect(await hasTmuxSession(name)).toBe(false);
      const state = await fs.readFile(`/proc/${childPid}/stat`, 'utf8').then(
        (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0],
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 'exited';
          throw error;
        },
      );
      expect(['exited', 'Z']).toContain(state);
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    }
  });
});
