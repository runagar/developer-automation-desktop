import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PtySession } from './pty';
import { Session, SessionState, JiraIssue } from './types';
import { BrowserWindow } from 'electron';
import {
  tmuxSessionName, hasTmuxSession,
  getSessionInfo, listSmithSessions, killTmuxSession,
} from './tmux';
import { ensureWhitelistConfig } from './whitelist';

export class SessionManager {
  private db!: Database.Database;
  private ptySessions: Map<string, PtySession> = new Map();
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

    // Restore non-dead, non-archived sessions
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE dead = 0 AND archived = 0'
    ).all() as any[];

    for (const row of rows) {
      this.restoredIds.add(row.id);
      const tmuxName = tmuxSessionName(row.id);
      const tmuxExists = await hasTmuxSession(tmuxName);
      await this.spawnSession(row.id, row.working_dir, row.name, row.project, tmuxExists);
    }
  }

  async createSession(opts: { name?: string; workingDir: string; project?: string | null }): Promise<Session> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const name = opts.name || `Session ${this.getSessionCount() + 1}`;

    this.db.prepare(`
      INSERT INTO sessions (id, name, working_dir, project, state, dead, archived, created_at, last_active)
      VALUES (?, ?, ?, ?, 'idle', 0, 0, ?, ?)
    `).run(id, name, opts.workingDir, opts.project ?? null, now, now);

    await this.spawnSession(id, opts.workingDir, name, opts.project ?? null, false);

    return this.getSession(id)!;
  }

  private async spawnSession(
    id: string,
    workingDir: string,
    _name: string,
    _project: string | null,
    tmuxExists: boolean,
    size?: { cols: number; rows: number }
  ): Promise<void> {
    const ptySession = new PtySession(id);

    ptySession.on('data', (data: string) => {
      this.window?.webContents.send('pty:data', id, data);
    });

    ptySession.on('stateChange', (state: SessionState) => {
      this.db.prepare('UPDATE sessions SET state = ?, last_active = ? WHERE id = ?')
        .run(state, new Date().toISOString(), id);
      this.window?.webContents.send('session:stateChange', id, state);
    });

    ptySession.on('died', () => {
      this.handleDied(id);
    });

    try {
      await ptySession.spawn(workingDir, id, tmuxExists, size?.cols, size?.rows);
      this.ptySessions.set(id, ptySession);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.window?.webContents.send(
        'pty:data', id,
        `\r\n\x1b[31m[Agent Smith] Failed to start session: ${msg}\x1b[0m\r\n`
      );
      this.db.prepare('UPDATE sessions SET dead = 1 WHERE id = ?').run(id);
      this.window?.webContents.send('session:died', id);
    }
  }

  /**
   * Archive a session: detach the PTY but keep the tmux session alive.
   */
  archiveSession(id: string): void {
    const pty = this.ptySessions.get(id);
    if (pty) {
      pty.kill(); // kills attach PTY only, tmux keeps running
      this.ptySessions.delete(id);
    }
    this.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id);
    this.window?.webContents.send('session:archived', id);
  }

  /**
   * Unarchive a session: reattach to the (possibly still running) tmux session.
   */
  async unarchiveSession(id: string, cols?: number, rows?: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return;

    this.db.prepare('UPDATE sessions SET archived = 0, dead = 0 WHERE id = ?').run(id);

    const tmuxName = tmuxSessionName(id);
    const tmuxExists = await hasTmuxSession(tmuxName);
    const size = cols && rows ? { cols, rows } : undefined;
    await this.spawnSession(id, row.working_dir, row.name, row.project, tmuxExists, size);
  }

  /**
   * Permanently destroy a session: kill tmux session and delete DB row.
   */
  async destroySession(id: string): Promise<void> {
    const pty = this.ptySessions.get(id);
    if (pty) {
      await pty.destroyTmux();
      this.ptySessions.delete(id);
    } else {
      // No active PTY (archived) — kill tmux directly
      await killTmuxSession(tmuxSessionName(id));
    }
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  renameSession(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  async reviveSession(id: string, cols?: number, rows?: number): Promise<void> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return;

    const tmuxName = tmuxSessionName(id);
    const tmuxExists = await hasTmuxSession(tmuxName);

    this.db.prepare('UPDATE sessions SET dead = 0, state = ? WHERE id = ?').run('idle', id);

    const size = cols && rows ? { cols, rows } : undefined;
    await this.spawnSession(id, row.working_dir, row.name, row.project, tmuxExists, size);
  }

  ptyWrite(id: string, data: string): void {
    this.ptySessions.get(id)?.write(data);
  }

  ptyResize(id: string, cols: number, rows: number): void {
    this.ptySessions.get(id)?.resize(cols, rows);
  }

  getSessions(): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all() as any[];
    return rows.map(this.rowToSession);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  async persistAll(): Promise<void> {
    // Update last_active for all live sessions
    this.db.prepare('UPDATE sessions SET last_active = ? WHERE dead = 0')
      .run(new Date().toISOString());

    // Kill only attach PTYs — tmux sessions keep running
    for (const [, pty] of this.ptySessions) {
      pty.kill();
    }
    this.ptySessions.clear();
  }

  getNonDeadSessions(): { id: string; state: SessionState }[] {
    const rows = this.db.prepare('SELECT id, state FROM sessions WHERE dead = 0').all() as Array<{ id: string; state: string }>;
    return rows.map((row) => ({ id: row.id, state: row.state as SessionState }));
  }

  handleStateChange(id: string, state: SessionState): void {
    const pty = this.ptySessions.get(id);
    if (pty) {
      pty.setState(state);
      return;
    }

    this.db.prepare('UPDATE sessions SET state = ?, last_active = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id);
    this.window?.webContents.send('session:stateChange', id, state);
  }

  handleDied(id: string): void {
    const pty = this.ptySessions.get(id);
    if (pty) {
      pty.kill();
      this.ptySessions.delete(id);
    }
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
      // Extract the session ID prefix from the tmux name (smith-<12 chars>)
      const prefix = ts.name.replace('smith-', '');
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
