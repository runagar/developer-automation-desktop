import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PtySession } from './pty';
import { Session, SessionState, JiraIssue } from './types';
import { BrowserWindow } from 'electron';
import {
  tmuxSessionName, hasTmuxSession, createTmuxSession,
  getSessionInfo, listSmithSessions, killTmuxSession, getPanePid,
} from './tmux';
import { ensureWhitelistConfig } from './whitelist';

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

  constructor(dataDir: string) {
    this.dataDir = dataDir;
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

    this.db.prepare(`
      INSERT INTO sessions (id, name, working_dir, project, state, dead, archived, sort_order, created_at, last_active)
      VALUES (?, ?, ?, ?, 'idle', 0, 0, ?, ?, ?)
    `).run(id, name, opts.workingDir, opts.project ?? null, maxSort + 1, now, now);

    await this.ensureTmuxSession(id, opts.workingDir);

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
   * Archive a session: detach all PTYs but keep the tmux session alive.
   */
  archiveSession(id: string): void {
    this.detachAllPtysForSession(id);
    this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id);
    this.window?.webContents.send('session:archived', id);
  }

  /**
   * Unarchive a session: mark as unarchived. PTY attachment is deferred to renderer.
   */
  async unarchiveSession(id: string, _cols?: number, _rows?: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return;
    this.db.prepare('UPDATE sessions SET archived = 0, dead = 0 WHERE id = ?').run(id);
    // Ensure tmux session exists (it may have died while archived)
    await this.ensureTmuxSession(id, row.working_dir);
  }

  /**
   * Permanently destroy a session: kill tmux session and delete DB row.
   */
  async destroySession(id: string): Promise<void> {
    this.detachAllPtysForSession(id);
    await killTmuxSession(tmuxSessionName(id));
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  renameSession(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  async reviveSession(id: string, _cols?: number, _rows?: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return;

    this.db.prepare('UPDATE sessions SET dead = 0, state = ? WHERE id = ?').run('idle', id);

    // Re-create the tmux session so copilot can restart
    await this.ensureTmuxSession(id, row.working_dir);
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

  getNonDeadSessions(): { id: string; state: SessionState }[] {
    const rows = this.db.prepare('SELECT id, state FROM sessions WHERE dead = 0').all() as Array<{ id: string; state: string }>;
    return rows.map((row) => ({ id: row.id, state: row.state as SessionState }));
  }

  handleStateChange(id: string, state: SessionState): void {
    // State changes come from the state poller, not from PTY sessions.
    // Update the DB and notify the renderer directly.
    this.db.prepare('UPDATE sessions SET state = ?, last_active = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id);
    this.window?.webContents.send('session:stateChange', id, state);
  }

  handleDied(id: string): void {
    this.detachAllPtysForSession(id);
    this.db.prepare('UPDATE sessions SET dead = 1, state = ? WHERE id = ?').run('idle', id);
    this.window?.webContents.send('session:died', id);
  }

  // --- Orphan cleanup ---

  private async cleanupOrphanedSessions(): Promise<void> {
    const tmuxSessions = await listSmithSessions();
    const dbIds = new Set<string>(
      (this.db.prepare('SELECT id FROM sessions').all() as any[]).map((r) => r.id)
    );

    for (const ts of tmuxSessions) {
      // Extract the session ID prefix from tmux name:
      // Terminal: "smith-<12 chars>" → prefix is the 12-char UUID prefix
      // Shell:   "smith-shell-<12 chars>" → prefix is the 12-char UUID prefix
      let prefix: string;
      if (ts.name.startsWith('smith-shell-')) {
        prefix = ts.name.replace('smith-shell-', '');
      } else {
        prefix = ts.name.replace('smith-', '');
      }
      const hasDbRow = Array.from(dbIds).some((id) => id.startsWith(prefix));
      if (!hasDbRow) {
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
