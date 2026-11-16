import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './sessions';
import { createTmuxSession, hasTmuxSession, isAgentTmuxAlive, isLegacyOpenCodeRuntime, killTmuxSession, listSmithSessions, tmuxSessionName } from './tmux';
import { readSessionState } from './statePoller';
import type { CreateSessionOptions } from './types';

const pty = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }));
vi.mock('electron', () => ({}));
vi.mock('./pty', () => ({
  PtySession: class extends EventEmitter {
    spawn = pty.spawn;
    kill = pty.kill;
  },
}));
vi.mock('./tmux', () => ({
  tmuxSessionName: (id: string) => `smith-${id.slice(0, 12)}`,
  createTmuxSession: vi.fn(),
  hasTmuxSession: vi.fn(),
  isAgentTmuxAlive: vi.fn(),
  isLegacyOpenCodeRuntime: vi.fn(),
  killTmuxSession: vi.fn(),
  listSmithSessions: vi.fn(),
}));
vi.mock('./statePoller', () => ({ readSessionState: vi.fn() }));

let directory: string;
let manager: SessionManager;
let db: Database.Database;
let live: Set<string>;
let created: number;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-session-lifecycle-'));
  live = new Set();
  created = 0;
  vi.mocked(hasTmuxSession).mockImplementation(async (name) => live.has(name));
  vi.mocked(isAgentTmuxAlive).mockImplementation(async (name) => live.has(name));
  vi.mocked(isLegacyOpenCodeRuntime).mockResolvedValue(false);
  vi.mocked(listSmithSessions).mockImplementation(async () =>
    [...live].map((name) => ({ name, activity: 0, attached: 0 })));
  vi.mocked(createTmuxSession).mockImplementation(async (id, _workingDir, options) => {
    if (options.agent === 'opencode') {
      options.onConversationCreated(options.agentSessionId ?? `ses_created${++created}`);
    }
    const name = tmuxSessionName(id);
    live.add(name);
    return name;
  });
  vi.mocked(killTmuxSession).mockImplementation(async (name) => { live.delete(name); });
  vi.mocked(readSessionState).mockResolvedValue('idle');
  pty.spawn.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  manager = new SessionManager(directory);
  await manager.initialize();
  db = new Database(path.join(directory, 'sessions.db'));
});

async function createReady(options: CreateSessionOptions) {
  const session = await manager.createSession(options);
  await vi.waitFor(() => expect(manager.getPollableSessions().some((candidate) => candidate.id === session.id)).toBe(true));
  return manager.getSession(session.id)!;
}

function attachRenderer(): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  manager.setWindow({ webContents: { send } } as unknown as BrowserWindow);
  return send;
}

function sentOn(send: ReturnType<typeof vi.fn>, channel: string): unknown[][] {
  return send.mock.calls.filter(([sent]) => sent === channel);
}

afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('session agent persistence', () => {
  it('backfills legacy active and archived sessions as Copilot', async () => {
    // Given
    db.exec('ALTER TABLE sessions DROP COLUMN agent; ALTER TABLE sessions DROP COLUMN agent_session_id');
    const insert = db.prepare(`INSERT INTO sessions
      (id, name, working_dir, state, dead, archived, created_at, last_active)
      VALUES (?, 'Legacy', '/work', 'idle', 0, ?, '2026-01-01', '2026-01-01')`);
    insert.run('old-active', 0);
    insert.run('old-archived', 1);
    const restored = new SessionManager(directory);
    // When
    await restored.initialize();
    // Then
    expect(restored.getSessions().map((session) => [session.agent, session.agentSessionId])).toEqual([
      ['copilot', null], ['copilot', null],
    ]);
  });

  it('returns a new OpenCode session before its runtime finishes booting, then persists its conversation', async () => {
    // Given
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(createTmuxSession).mockImplementationOnce(async (id, _workingDir, options) => {
      await blocked;
      options.onConversationCreated('ses_created1');
      live.add(tmuxSessionName(id));
      return tmuxSessionName(id);
    });
    // When
    const openCode = await manager.createSession({ workingDir: '/work' });
    // Then
    expect(openCode).toMatchObject({ agent: 'opencode', agentSessionId: null, dead: false });
    expect(manager.getPollableSessions()).toEqual([]);
    release();
    await vi.waitFor(() => expect(manager.getSession(openCode.id)?.agentSessionId).toBe('ses_created1'));
    expect(manager.getPollableSessions().map((session) => session.id)).toEqual([openCode.id]);
  });

  it('keeps explicit Copilot creation unchanged', async () => {
    // Given
    const workingDir = '/work';
    // When
    const copilot = await manager.createSession({ workingDir, agent: 'copilot' });
    // Then
    expect(copilot).toMatchObject({ agent: 'copilot', agentSessionId: null });
    expect(live.has(tmuxSessionName(copilot.id))).toBe(true);
  });

  it('rejects an invalid IPC agent without inserting a row', async () => {
    // Given
    const options: CreateSessionOptions = { workingDir: '/work' };
    Object.defineProperty(options, 'agent', { value: 'other' });
    // When
    const result = manager.createSession(options);
    // Then
    await expect(result).rejects.toThrow('Unknown session agent');
    expect(manager.getSessions()).toEqual([]);
  });

  it('marks a background startup failure dead for retry instead of leaving it alive', async () => {
    // Given
    vi.mocked(createTmuxSession).mockRejectedValueOnce(new Error('OpenCode is not installed'));
    // When
    await manager.createSession({ workingDir: '/work' });
    // Then
    await vi.waitFor(() => expect(manager.getSessions()[0]?.dead).toBe(true));
    expect(manager.getSessions()).toHaveLength(1);
    expect(manager.getSessions()[0]).toMatchObject({ dead: true, agent: 'opencode', agentSessionId: null });
    expect(manager.getPollableSessions()).toEqual([]);
  });
});

describe('OpenCode lifecycle', () => {
  it('cold-restores each exact conversation when two sessions share a working directory', async () => {
    // Given
    const first = await createReady({ workingDir: '/same' });
    const second = await createReady({ workingDir: '/same' });
    await manager.archiveSession(first.id);
    await manager.archiveSession(second.id);
    await manager.evictArchivedSessions();
    vi.mocked(createTmuxSession).mockClear();
    // When
    await manager.unarchiveSession(first.id);
    await manager.unarchiveSession(second.id);
    // Then
    expect(vi.mocked(createTmuxSession).mock.calls.map((call) => call[2].agentSessionId)).toEqual([
      first.agentSessionId, second.agentSessionId,
    ]);
    expect(first.agentSessionId).not.toBe(second.agentSessionId);
  });

  it('awaits the same bootstrap when restore races with panel attachment', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    live.clear();
    vi.mocked(createTmuxSession).mockClear();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(createTmuxSession).mockImplementationOnce(async (id) => {
      live.add(tmuxSessionName(id));
      await blocked;
      return tmuxSessionName(id);
    });
    const restore = manager.restoreSessions();
    await vi.waitFor(() => expect(createTmuxSession).toHaveBeenCalledTimes(1));
    // When
    const attach = manager.ptyAttach(session.id, 'panel', 96, 28);
    await Promise.resolve();
    expect(pty.spawn).not.toHaveBeenCalled();
    release();
    await Promise.all([restore, attach]);
    // Then
    expect(createTmuxSession).toHaveBeenCalledTimes(1);
    expect(pty.spawn).toHaveBeenCalledWith('/work', 96, 28);
  });

  it('keeps a failed cold restore archived and preserves the conversation binding', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    await manager.archiveSession(session.id);
    await manager.evictArchivedSessions();
    vi.mocked(createTmuxSession).mockRejectedValueOnce(new Error('Saved conversation is unavailable'));
    // When
    const result = manager.unarchiveSession(session.id);
    // Then
    await expect(result).rejects.toThrow('Saved conversation');
    expect(manager.getSession(session.id)).toMatchObject({
      archived: true, dead: false, agentSessionId: session.agentSessionId,
    });
  });

  it('cancels a panel attachment closed while its runtime is booting', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    live.clear();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(createTmuxSession).mockImplementationOnce(async (id) => {
      await blocked;
      live.add(tmuxSessionName(id));
      return tmuxSessionName(id);
    });
    const attach = manager.ptyAttach(session.id, 'closed-panel', 96, 28);
    await vi.waitFor(() => expect(createTmuxSession).toHaveBeenCalledTimes(2));
    // When
    manager.ptyDetach('closed-panel');
    release();
    await attach;
    // Then
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it('serializes archive behind bootstrap and detaches the completed attachment', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    live.clear();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(createTmuxSession).mockImplementationOnce(async (id) => {
      await blocked;
      live.add(tmuxSessionName(id));
      return tmuxSessionName(id);
    });
    const attach = manager.ptyAttach(session.id, 'panel', 96, 28);
    await vi.waitFor(() => expect(createTmuxSession).toHaveBeenCalledTimes(2));
    // When
    const archive = manager.archiveSession(session.id);
    release();
    await Promise.all([attach, archive]);
    // Then
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(manager.getSession(session.id)?.archived).toBe(true);
  });

  it('cleans the surviving runtime when one required CLI process dies', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    vi.mocked(isAgentTmuxAlive).mockResolvedValue(false);
    // When
    await manager.handleDied(session.id);
    // Then
    expect(killTmuxSession).toHaveBeenCalledWith(tmuxSessionName(session.id));
    expect(manager.getSession(session.id)?.dead).toBe(true);
    expect(live.size).toBe(0);
  });

  it('does not let a stale died callback kill a healthy revived runtime', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    // When
    await manager.handleDied(session.id);
    // Then
    expect(killTmuxSession).not.toHaveBeenCalled();
    expect(manager.getSession(session.id)?.dead).toBe(false);
  });
});

describe('OpenCode archive reaping', () => {
  it.each(['running', 'awaiting'] as const)('protects expired archived %s work even if its stored state was idle', async (state) => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    await manager.archiveSession(session.id);
    db.prepare("UPDATE sessions SET archived_at = '2020-01-01' WHERE id = ?").run(session.id);
    vi.mocked(readSessionState).mockResolvedValue(state);
    // When
    await manager.reapArchivedSessions();
    // Then
    expect(killTmuxSession).not.toHaveBeenCalled();
    expect(manager.getSession(session.id)).toMatchObject({ warm: true, state });
  });

  it('does not demote an expired idle session when its API is unavailable', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    await manager.archiveSession(session.id);
    db.prepare("UPDATE sessions SET archived_at = '2020-01-01' WHERE id = ?").run(session.id);
    vi.mocked(readSessionState).mockRejectedValue(new Error('API unavailable'));
    // When
    await manager.reapArchivedSessions();
    // Then
    expect(killTmuxSession).not.toHaveBeenCalled();
    expect(manager.getSession(session.id)?.warm).toBe(true);
  });

  it('demotes verified idle work and preserves the exact ID for later restore', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    await manager.archiveSession(session.id);
    db.prepare("UPDATE sessions SET archived_at = '2020-01-01' WHERE id = ?").run(session.id);
    // When
    await manager.reapArchivedSessions();
    // Then
    expect(killTmuxSession).toHaveBeenCalledWith(tmuxSessionName(session.id));
    expect(manager.getSession(session.id)).toMatchObject({
      warm: false, archived: true, agentSessionId: session.agentSessionId,
    });
  });
});

describe('OpenCode 1 runtimes left running by the upgrade', () => {
  function replaceLegacyFlags(): Array<boolean | undefined> {
    return vi.mocked(createTmuxSession).mock.calls.map((call) => call[2].replaceLegacy);
  }

  it('marks an active session dead at restore without killing its OpenCode 1 runtime', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    vi.mocked(createTmuxSession).mockRejectedValueOnce(
      new Error('This session is still running OpenCode 1. Revive it to restart it on OpenCode 2.'),
    );
    // When
    await manager.restoreSessions();
    // Then
    expect(manager.getSession(session.id)?.dead).toBe(true);
    expect(killTmuxSession).not.toHaveBeenCalled();
    expect(live.has(tmuxSessionName(session.id))).toBe(true);
  });

  it('never replaces a runtime when restoring at startup or attaching a panel', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    live.clear();
    vi.mocked(createTmuxSession).mockClear();
    // When
    await manager.restoreSessions();
    live.clear();
    await manager.ptyAttach(session.id, 'panel', 96, 28);
    // Then
    expect(replaceLegacyFlags()).toEqual([false, false]);
  });

  it('replaces an OpenCode 1 runtime when the user revives or restores the session', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    db.prepare('UPDATE sessions SET dead = 1 WHERE id = ?').run(session.id);
    vi.mocked(createTmuxSession).mockClear();
    // When
    await manager.reviveSession(session.id);
    await manager.archiveSession(session.id);
    await manager.evictArchivedSessions();
    await manager.unarchiveSession(session.id);
    // Then
    expect(replaceLegacyFlags()).toEqual([true, true]);
  });

  it('evicts an archived session\'s OpenCode 1 runtime instead of reporting it warm', async () => {
    // Given
    const session = await createReady({ workingDir: '/work' });
    await manager.archiveSession(session.id);
    vi.mocked(isLegacyOpenCodeRuntime).mockResolvedValue(true);
    // When
    await manager.reapArchivedSessions();
    // Then
    expect(killTmuxSession).toHaveBeenCalledWith(tmuxSessionName(session.id));
    expect(manager.getSession(session.id)).toMatchObject({ archived: true, warm: false });
  });
});

describe('renderer notifications', () => {
  it('forwards each OpenCode startup phase and clears it once the runtime is ready', async () => {
    // Given
    const send = attachRenderer();
    vi.mocked(createTmuxSession).mockImplementationOnce(async (id, _workingDir, options) => {
      options.onPhase?.('server');
      options.onPhase?.('create-conversation');
      options.onConversationCreated('ses_created1');
      options.onPhase?.('tui');
      live.add(tmuxSessionName(id));
      return tmuxSessionName(id);
    });
    // When
    const session = await createReady({ workingDir: '/work' });
    // Then
    expect(sentOn(send, 'session:startupPhase')).toEqual([
      ['session:startupPhase', session.id, 'server'],
      ['session:startupPhase', session.id, 'create-conversation'],
      ['session:startupPhase', session.id, 'tui'],
      ['session:startupPhase', session.id, null],
    ]);
  });

  it('clears the startup phase when the runtime fails to start', async () => {
    // Given
    const send = attachRenderer();
    vi.mocked(createTmuxSession).mockImplementationOnce(async (_id, _workingDir, options) => {
      options.onPhase?.('server');
      throw new Error('OpenCode server exited');
    });
    // When
    const session = await manager.createSession({ workingDir: '/work' });
    // Then
    await vi.waitFor(() => expect(manager.getSession(session.id)?.dead).toBe(true));
    expect(sentOn(send, 'session:startupPhase')).toEqual([
      ['session:startupPhase', session.id, 'server'],
      ['session:startupPhase', session.id, null],
    ]);
  });

  it('tags attached terminal output with the session it came from', async () => {
    // Given
    const send = attachRenderer();
    const session = await createReady({ workingDir: '/work' });
    let client: EventEmitter | undefined;
    pty.spawn.mockImplementation(async function (this: EventEmitter) { client = this; });
    await manager.ptyAttach(session.id, 'panel', 96, 28);
    // When
    client?.emit('data', 'frame');
    // Then
    expect(sentOn(send, 'pty:data')).toEqual([['pty:data', 'panel', session.id, 'frame']]);
  });
});
