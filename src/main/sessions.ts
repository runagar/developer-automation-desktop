import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PtySession } from './pty';
import { Session, SessionState, ProjectEntry } from './types';
import { BrowserWindow, app } from 'electron';

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
  }

  // Called from the renderer:ready IPC event, after the window is set,
  // so PTY events are never emitted while this.window is null.
  async restoreSessions(): Promise<void> {
    if (this.sessionsRestored) return;
    this.sessionsRestored = true;
    const rows = this.db.prepare('SELECT * FROM sessions WHERE dead = 0').all() as any[];
    for (const row of rows) {
      this.restoredIds.add(row.id);
      await this.spawnSession(row.id, row.working_dir, row.name, row.project, true);
    }
  }

  async createSession(opts: { name?: string; workingDir: string; project?: string | null }): Promise<Session> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const name = opts.name || `Session ${this.getSessionCount() + 1}`;

    this.db.prepare(`
      INSERT INTO sessions (id, name, working_dir, project, state, dead, created_at, last_active)
      VALUES (?, ?, ?, ?, 'idle', 0, ?, ?)
    `).run(id, name, opts.workingDir, opts.project ?? null, now, now);

    await this.spawnSession(id, opts.workingDir, name, opts.project ?? null, false);

    return this.getSession(id)!;
  }

  private async spawnSession(
    id: string,
    workingDir: string,
    name: string,
    project: string | null,
    isRestore: boolean
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
      this.db.prepare('UPDATE sessions SET dead = 1 WHERE id = ?').run(id);
      this.ptySessions.delete(id);
      this.window?.webContents.send('session:died', id);
    });

    try {
      ptySession.spawn(workingDir, id);
      this.ptySessions.set(id, ptySession);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface the error in the terminal pane before marking the session dead,
      // so the user knows why it failed (e.g. 'copilot' binary not found).
      this.window?.webContents.send(
        'pty:data', id,
        `\r\n\x1b[31m[Agent Smith] Failed to start session: ${msg}\x1b[0m\r\n`
      );
      this.db.prepare('UPDATE sessions SET dead = 1 WHERE id = ?').run(id);
      this.window?.webContents.send('session:died', id);
    }
  }

  destroySession(id: string): void {
    const pty = this.ptySessions.get(id);
    pty?.kill();
    this.ptySessions.delete(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  renameSession(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  async reviveSession(id: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return;
    this.db.prepare('UPDATE sessions SET dead = 0, state = ? WHERE id = ?').run('idle', id);
    await this.spawnSession(id, row.working_dir, row.name, row.project, true);
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
    this.db.prepare('UPDATE sessions SET last_active = ? WHERE dead = 0')
      .run(new Date().toISOString());
  }

  getProjectEntries(): ProjectEntry[] {
    // app.getAppPath() resolves correctly in both dev and packaged .asar,
    // unlike __dirname which breaks when the app is bundled.
    const configPath = path.join(app.getAppPath(), 'projects.json');
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as ProjectEntry[];
    } catch {
      return [];
    }
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
    restored: this.restoredIds.has(row.id),
    createdAt: row.created_at,
    lastActive: row.last_active,
  });
}
