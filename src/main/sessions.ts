import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PtySession } from './pty';
import { Session, SessionState, JiraIssue } from './types';
import { BrowserWindow } from 'electron';
import {
  tmuxSessionName, hasTmuxSession, createTmuxSession,
  getSessionInfo, listSmithSessions, killTmuxSession, getPanePid, capturePane,
} from './tmux';
import { detectStateFromPane } from './statePoller';
import { ensureWhitelistConfig } from './whitelist';
import { ArchivedRow, selectDemotionCandidates } from './archivePolicy';

export class SessionManager {
  private db!: Database.Database;
  // Panel-instance-keyed PTY attachments (multiple panels can attach to the same session's tmux)
  private ptyAttachments: Map<string, PtySession> = new Map();
  private panelToSession: Map<string, string> = new Map();
  private dataDir: string;
  private window: BrowserWindow | null = null;
  private sessionsRestored = false;
  // IDs of sessions resumed from the previous run — runtime only, not persisted.
  private restoredIds = new Set<string>();
  // IDs of sessions whose tmux is currently being created. The state poller
  // skips these to avoid a race where the poller marks a session dead before
  // its tmux session finishes spawning.
  private pendingTmuxIds = new Set<string>();
  // IDs of archived sessions whose copilot tmux is still alive ("warm").
  // Runtime only — reconciled against real tmux state, never persisted.
  private warmIds = new Set<string>();
  // Per-session promise queues serialising lifecycle operations.
  private locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Serialise lifecycle operations (archive/unarchive/revive/destroy/reap/evict)
   * per session id, so that e.g. the reaper cannot kill a tmux session that a
   * concurrent restore has just recreated. Re-check eligibility inside `fn` —
   * holding the lock is not enough if the decision was made outside it.
   */
  private withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => { /* previous failure must not block the queue */ }).then(fn);
    this.locks.set(id, next);
    void next.catch(() => { /* handled by the caller */ }).finally(() => {
      if (this.locks.get(id) === next) this.locks.delete(id);
    });
    return next;
  }

  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.db = new Database(path.join(this.dataDir, 'sessions.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        project TEXT,
        state TEXT DEFAULT 'idle',
        dead INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        last_active TEXT NOT NULL
      )
    `);

    // Migration-safe additions
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN jira_key TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN jira_data TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT'); } catch { /* already exists */ }

    // `dead` is meaningless for an archived session: before archived sessions
    // were excluded from polling, every launch after a reboot flipped them to
    // dead = 1 (their tmux was gone), so they rendered as DEAD even though
    // restoring them worked. Clear it once.
    this.db.prepare('UPDATE sessions SET dead = 0 WHERE archived = 1 AND dead = 1').run();

    // Backfill sort_order for existing rows that have 0
    const unordered = this.db.prepare('SELECT id FROM sessions WHERE sort_order = 0 ORDER BY created_at ASC').all() as any[];
    if (unordered.length > 1) {
      const update = this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?');
      const tx = this.db.transaction(() => {
        unordered.forEach((row: any, i: number) => update.run(i + 1, row.id));
      });
      tx();
    }

    // Ensure Jira whitelist config exists (creates default on first run)
    ensureWhitelistConfig(this.dataDir);
  }

  // Called from the renderer:ready IPC event, after the window is set,
  // so PTY events are never emitted while this.window is null.
  async restoreSessions(): Promise<void> {
    if (this.sessionsRestored) return;
    this.sessionsRestored = true;

    // Clean up orphaned tmux sessions (no matching DB row)
    await this.cleanupOrphanedSessions();

    // Establish which archived sessions still have a live copilot tmux. A
    // previous run may have left some alive (e.g. a crash before eviction).
    await this.reconcileWarmth();

    // Mark non-dead, non-archived sessions as restored.
    // PTY attachment is deferred to renderer-driven ptyAttach calls.
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE dead = 0 AND archived = 0'
    ).all() as any[];

    for (const row of rows) {
      this.restoredIds.add(row.id);
      // Ensure the tmux session exists (may have been killed externally)
      const tmuxName = tmuxSessionName(row.id);
      const tmuxExists = await hasTmuxSession(tmuxName);
      if (!tmuxExists) {
        // Re-create the tmux session so copilot can restart
        await this.ensureTmuxSession(row.id, row.working_dir);
      }
    }
  }

  async createSession(opts: { name?: string; workingDir: string; project?: string | null }): Promise<Session> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const name = opts.name || `Session ${this.getSessionCount() + 1}`;

    // New sessions get sort_order after all existing ones
    const maxSort = (this.db.prepare('SELECT MAX(sort_order) as m FROM sessions').get() as any)?.m ?? 0;

    // Mark as pending so the state poller skips this session while tmux spawns.
    this.pendingTmuxIds.add(id);
    try {
      this.db.prepare(`
        INSERT INTO sessions (id, name, working_dir, project, state, dead, archived, sort_order, created_at, last_active)
        VALUES (?, ?, ?, ?, 'idle', 0, 0, ?, ?, ?)
      `).run(id, name, opts.workingDir, opts.project ?? null, maxSort + 1, now, now);

      await this.ensureTmuxSession(id, opts.workingDir);
    } finally {
      this.pendingTmuxIds.delete(id);
    }

    return this.getSession(id)!;
  }

  /**
   * Ensure the tmux session exists for a given app session. Creates it if needed.
   * Does NOT attach a PTY — the renderer drives attachment via ptyAttach.
   */
  private async ensureTmuxSession(id: string, workingDir: string): Promise<void> {
    const tmuxName = tmuxSessionName(id);
    if (!await hasTmuxSession(tmuxName)) {
      try {
        await createTmuxSession(id, workingDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.window?.webContents.send(
          'pty:data', id,
          `\r\n\x1b[31m[DAD] Failed to start session: ${msg}\x1b[0m\r\n`
        );
        this.db.prepare('UPDATE sessions SET dead = 1 WHERE id = ?').run(id);
        this.window?.webContents.send('session:died', id);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Panel-instance-keyed PTY attachment
  // -----------------------------------------------------------------------

  /**
   * Attach a panel instance to a session's terminal tmux.
   * Creates a new PtySession (tmux attach-session client) keyed by panelInstanceId.
   */
  async ptyAttach(sessionId: string, panelInstanceId: string, cols?: number, rows?: number): Promise<void> {
    // Detach existing if any
    this.ptyDetach(panelInstanceId);

    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!row) return;

    const ptySession = new PtySession(sessionId);

    ptySession.on('data', (data: string) => {
      // Guard: only forward if we're still the active attachment for this panel.
      // Concurrent ptyAttach calls can orphan us during the async spawn window.
      if (this.ptyAttachments.get(panelInstanceId) !== ptySession) return;
      this.window?.webContents.send('pty:data', panelInstanceId, data);
    });

    ptySession.on('died', () => {
      // Guard: ignore if superseded by a newer attachment
      if (this.ptyAttachments.get(panelInstanceId) !== ptySession) return;
      this.ptyAttachments.delete(panelInstanceId);
      this.panelToSession.delete(panelInstanceId);
      // Check if any other attachment already triggered died for this session
      const otherAttached = Array.from(this.panelToSession.values()).includes(sessionId);
      if (!otherAttached) {
        this.handleDied(sessionId);
      }
    });

    try {
      const tmuxExists = await hasTmuxSession(tmuxSessionName(sessionId));
      if (!tmuxExists) {
        await this.ensureTmuxSession(sessionId, row.working_dir);
      }
      await ptySession.spawn(row.working_dir, sessionId, true, cols ?? 120, rows ?? 36);
      // Kill any orphan that a concurrent ptyAttach stored while we were awaiting
      this.ptyDetach(panelInstanceId);
      this.ptyAttachments.set(panelInstanceId, ptySession);
      this.panelToSession.set(panelInstanceId, sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.window?.webContents.send(
        'pty:data', panelInstanceId,
        `\r\n\x1b[31m[DAD] Failed to attach: ${msg}\x1b[0m\r\n`
      );
    }
  }

  /**
   * Detach a panel instance's PTY (keeps tmux running).
   */
  ptyDetach(panelInstanceId: string): void {
    const pty = this.ptyAttachments.get(panelInstanceId);
    if (pty) {
      pty.kill();
      this.ptyAttachments.delete(panelInstanceId);
      this.panelToSession.delete(panelInstanceId);
    }
  }

  /**
   * Detach all PTY attachments for a given session.
   */
  private detachAllPtysForSession(sessionId: string): void {
    for (const [panelId, sid] of this.panelToSession) {
      if (sid === sessionId) {
        const pty = this.ptyAttachments.get(panelId);
        if (pty) pty.kill();
        this.ptyAttachments.delete(panelId);
        this.panelToSession.delete(panelId);
      }
    }
  }

  ptyWritePanel(panelInstanceId: string, data: string): void {
    this.ptyAttachments.get(panelInstanceId)?.write(data);
  }

  ptyResizePanel(panelInstanceId: string, cols: number, rows: number): void {
    this.ptyAttachments.get(panelInstanceId)?.resize(cols, rows);
  }

  /**
   * Archive a session: detach all PTYs but keep the tmux session alive ("warm").
   */
  archiveSession(id: string): void {
    this.detachAllPtysForSession(id);
    this.db.prepare('UPDATE sessions SET archived = 1, archived_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    this.warmIds.add(id);
    this.window?.webContents.send('session:archived', id);
  }

  /**
   * Unarchive a session: mark as unarchived. PTY attachment is deferred to renderer.
   */
  async unarchiveSession(id: string, _cols?: number, _rows?: number): Promise<void> {
    return this.withSessionLock(id, async () => {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
      if (!row) return;

      // Mark as pending so the state poller skips this session while tmux spawns.
      this.pendingTmuxIds.add(id);
      try {
        this.db.prepare(
          "UPDATE sessions SET archived = 0, dead = 0, archived_at = NULL, state = 'idle' WHERE id = ?"
        ).run(id);
        this.warmIds.delete(id);
        await this.ensureTmuxSession(id, row.working_dir);
      } finally {
        this.pendingTmuxIds.delete(id);
      }
    });
  }

  /**
   * Permanently destroy a session: kill tmux session and delete DB row.
   */
  async destroySession(id: string): Promise<void> {
    return this.withSessionLock(id, async () => {
      this.detachAllPtysForSession(id);
      await killTmuxSession(tmuxSessionName(id));
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.warmIds.delete(id);
    });
  }

  renameSession(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  async reviveSession(id: string, _cols?: number, _rows?: number): Promise<void> {
    return this.withSessionLock(id, async () => {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
      if (!row) return;

      // Mark as pending so the state poller skips this session while tmux spawns.
      this.pendingTmuxIds.add(id);
      try {
        this.db.prepare('UPDATE sessions SET dead = 0, state = ? WHERE id = ?').run('idle', id);
        await this.ensureTmuxSession(id, row.working_dir);
      } finally {
        this.pendingTmuxIds.delete(id);
      }
    });
  }

  /**
   * Resume a suspended copilot session by sending SIGCONT to its process group.
   */
  async resumeSession(id: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row || row.dead === 1 || row.archived === 1) return;

    const tmuxName = tmuxSessionName(id);
    const pid = await getPanePid(tmuxName);
    if (!pid) {
      console.log(`[resume] Could not get pane PID for session ${id}`);
      return;
    }

    try {
      // Signal the entire process group so child processes are also resumed
      process.kill(-pid, 'SIGCONT');
      console.log(`[resume] Sent SIGCONT to process group ${pid} for session ${id}`);
    } catch (err: any) {
      if (err?.code === 'ESRCH') {
        console.log(`[resume] Process ${pid} already dead for session ${id}`);
      } else {
        console.error(`[resume] Failed to send SIGCONT for session ${id}:`, err);
      }
    }
  }

  /** Legacy: write to any PTY attached to the given session (used by JiraPlan). */
  ptyWrite(id: string, data: string): void {
    for (const [panelId, sid] of this.panelToSession) {
      if (sid === id) {
        this.ptyAttachments.get(panelId)?.write(data);
        return;
      }
    }
  }

  /** Legacy: resize any PTY attached to the given session. */
  ptyResize(id: string, cols: number, rows: number): void {
    for (const [panelId, sid] of this.panelToSession) {
      if (sid === id) {
        this.ptyAttachments.get(panelId)?.resize(cols, rows);
        return;
      }
    }
  }

  getSessions(): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY sort_order ASC, created_at ASC').all() as any[];
    return rows.map(this.rowToSession);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  reorderSessions(orderedIds: string[]): void {
    const update = this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => update.run(i + 1, id));
    });
    tx();
  }

  /**
   * Kill the copilot tmux session for every archived session. Shell tmux
   * sessions and non-archived sessions are left running so the app can
   * reattach on next launch.
   *
   * Unconditional by design: a busy archived session is interrupted rather
   * than leaked as a ~350 MB copilot process that outlives the app.
   */
  async evictArchivedSessions(): Promise<void> {
    const rows = this.db.prepare(
      'SELECT id FROM sessions WHERE archived = 1'
    ).all() as Array<{ id: string }>;
    await Promise.all(rows.map((row) => this.withSessionLock(row.id, async () => {
      await killTmuxSession(tmuxSessionName(row.id));
      this.warmIds.delete(row.id);
    })));
  }

  // --- Warm/cold lifecycle for archived sessions ---

  /**
   * Rebuild `warmIds` from the tmux sessions that actually exist.
   *
   * Warmth cannot be tracked by bookkeeping alone: a copilot process can exit
   * on its own, and a previous run may have left tmux sessions alive. Notifies
   * the renderer only when the set actually changed.
   */
  private async reconcileWarmth(liveNames?: Set<string>): Promise<void> {
    const live = liveNames ?? new Set((await listSmithSessions()).map((s) => s.name));
    const archived = this.db.prepare(
      'SELECT id FROM sessions WHERE archived = 1'
    ).all() as Array<{ id: string }>;

    const next = new Set<string>();
    for (const { id } of archived) {
      if (live.has(tmuxSessionName(id))) next.add(id);
    }

    this.warmIds = next;
    // Always notify: `renderer:ready` fires from preload before the renderer
    // registers its listeners, so a change-only notification could be missed
    // at startup and leave a stale badge forever. The renderer ignores
    // no-op updates, so re-sending costs nothing.
    this.notifyWarmth();
  }

  private notifyWarmth(): void {
    this.window?.webContents.send('sessions:warmthChanged', [...this.warmIds]);
  }

  /**
   * Demote archived sessions that have outlived their warm period, or that fall
   * outside the warm-session cap, by killing their copilot tmux session. The
   * shell tmux session is deliberately left running.
   */
  async reapArchivedSessions(liveNames?: Set<string>): Promise<void> {
    await this.reconcileWarmth(liveNames);

    const rows = this.db.prepare(
      `SELECT id, state, archived_at FROM sessions
       WHERE archived = 1 ORDER BY archived_at DESC`
    ).all() as ArchivedRow[];

    const warm = rows.filter((r) => this.warmIds.has(r.id));
    if (warm.length === 0) return;

    // Archived sessions are not polled, so their `state` is frozen at archive
    // time. Without this a session archived mid-task would satisfy the
    // busy-guard forever and never go cold. Bounded by the warm cap.
    for (const row of warm) {
      if (row.state !== 'running' && row.state !== 'awaiting') continue;
      const content = await capturePane(tmuxSessionName(row.id));
      const fresh = content ? detectStateFromPane(content) : null;
      if (fresh && fresh !== row.state) {
        this.db.prepare('UPDATE sessions SET state = ? WHERE id = ? AND archived = 1')
          .run(fresh, row.id);
        row.state = fresh;
      }
    }

    const candidates = selectDemotionCandidates(warm, Date.now());
    if (candidates.length === 0) return;

    for (const id of candidates) {
      await this.withSessionLock(id, async () => {
        // Re-check inside the lock: the session may have been restored or
        // destroyed while we were awaiting an earlier kill.
        const row = this.db.prepare('SELECT archived FROM sessions WHERE id = ?')
          .get(id) as { archived: number } | undefined;
        if (!row || row.archived !== 1) return;

        const tmuxName = tmuxSessionName(id);
        await killTmuxSession(tmuxName);
        // killTmuxSession swallows errors — only report cold if it really is.
        if (!await hasTmuxSession(tmuxName)) this.warmIds.delete(id);
      });
    }
    this.notifyWarmth();
  }

  async persistAll(): Promise<void> {
    // Update last_active for all live sessions
    this.db.prepare('UPDATE sessions SET last_active = ? WHERE dead = 0')
      .run(new Date().toISOString());

    // Kill all attach PTYs — tmux sessions keep running
    for (const [, pty] of this.ptyAttachments) {
      pty.kill();
    }
    this.ptyAttachments.clear();
    this.panelToSession.clear();
  }

  getPollableSessions(): { id: string; state: SessionState }[] {
    const rows = this.db.prepare(
      'SELECT id, state FROM sessions WHERE dead = 0 AND archived = 0'
    ).all() as Array<{ id: string; state: string }>;
    return rows
      .filter((row) => !this.pendingTmuxIds.has(row.id))
      .map((row) => ({ id: row.id, state: row.state as SessionState }));
  }

  handleStateChange(id: string, state: SessionState): void {
    // State changes come from the state poller, not from PTY sessions.
    // The `archived = 0` guard covers a poll cycle that was already in flight
    // when the session was archived — its stale result must not be applied.
    const res = this.db.prepare(
      'UPDATE sessions SET state = ?, last_active = ? WHERE id = ? AND archived = 0'
    ).run(state, new Date().toISOString(), id);
    if (res.changes === 0) return;
    this.window?.webContents.send('session:stateChange', id, state);
  }

  handleDied(id: string): void {
    const res = this.db.prepare(
      "UPDATE sessions SET dead = 1, state = 'idle' WHERE id = ? AND archived = 0"
    ).run(id);
    if (res.changes === 0) return;
    this.detachAllPtysForSession(id);
    this.window?.webContents.send('session:died', id);
  }

  // --- Orphan cleanup ---

  private async cleanupOrphanedSessions(): Promise<void> {
    const tmuxSessions = await listSmithSessions();
    const dbIds = (this.db.prepare('SELECT id FROM sessions').all() as any[]).map((r) => r.id);

    // Build a Set of 12-char prefixes for O(1) lookup
    const dbPrefixes = new Set(dbIds.map((id: string) => id.slice(0, 12)));

    for (const ts of tmuxSessions) {
      const isShell = ts.name.startsWith('smith-shell-');
      const prefix = ts.name.slice(isShell ? 'smith-shell-'.length : 'smith-'.length);
      if (!dbPrefixes.has(prefix)) {
        console.log(`[tmux] Cleaning up orphaned tmux session: ${ts.name}`);
        await killTmuxSession(ts.name);
      }
    }
  }

  // --- tmux metadata for renderer ---

  async getSessionTmuxInfo(id: string): Promise<{ activity: number; attached: number } | null> {
    return getSessionInfo(tmuxSessionName(id));
  }

  private getSessionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as any;
    return row.count;
  }

  // Arrow property so `this` is bound correctly when passed as a .map() callback.
  private rowToSession = (row: any): Session => ({
    id: row.id,
    name: row.name,
    workingDir: row.working_dir,
    project: row.project,
    state: row.state as SessionState,
    dead: row.dead === 1,
    archived: row.archived === 1,
    warm: this.warmIds.has(row.id),
    restored: this.restoredIds.has(row.id),
    createdAt: row.created_at,
    lastActive: row.last_active,
    jiraKey: row.jira_key ?? null,
    jiraData: row.jira_data ? JSON.parse(row.jira_data) as JiraIssue : null,
  });

  saveJiraIssue(sessionId: string, issue: JiraIssue): void {
    this.db.prepare(`UPDATE sessions SET jira_key = ?, jira_data = ? WHERE id = ?`)
      .run(issue.key, JSON.stringify(issue), sessionId);
  }

  clearJiraIssue(sessionId: string): void {
    this.db.prepare(`UPDATE sessions SET jira_key = NULL, jira_data = NULL WHERE id = ?`)
      .run(sessionId);
  }
}
