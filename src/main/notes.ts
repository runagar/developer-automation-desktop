import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { getNotesRootPath } from './settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotesScope {
  kind: 'global' | 'session';
  id: string; // panelId for global, sessionId for session-bound
}

export interface NotesPanelInfo {
  id: string;
  scopeKind: 'global' | 'session';
  scopeId: string;
  name: string;
  createdAt: string;
  closedAt: string | null;
}

export interface NotesTabInfo {
  id: string;
  scopeKind: 'global' | 'session';
  scopeId: string;
  name: string;
  filePath: string;
  isOpen: boolean;
  sortOrder: number;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------
// NotesManager
// ---------------------------------------------------------------------------

export class NotesManager {
  private db: Database.Database;
  private dataDir: string;
  private notesRoot: string;

  constructor(db: Database.Database, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
    // Must read the configured root from settings. Defaulting to
    // <dataDir>/notes here would silently ignore a user-configured vault on
    // every launch and write notes to the wrong location.
    this.notesRoot = getNotesRootPath(dataDir);
  }

  setNotesRoot(root: string): void {
    this.notesRoot = root;
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes_panels (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT DEFAULT 'Untitled',
        created_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);
    // Migration: add name column if missing
    const panelCols = this.db.pragma('table_info(notes_panels)') as any[];
    if (!panelCols.some((c: any) => c.name === 'name')) {
      this.db.exec("ALTER TABLE notes_panels ADD COLUMN name TEXT DEFAULT 'Untitled'");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes_tabs (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT,
        file_path TEXT NOT NULL,
        is_open INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        closed_at TEXT
      )
    `);

    // One-time migration: convert absolute file_path values to relative
    this.migrateToRelativePaths();
  }

  /**
   * Migrate absolute file_path values in notes_tabs to relative paths.
   * Detects migration need by checking if any path starts with '/'.
   */
  private migrateToRelativePaths(): void {
    const rows = this.db.prepare(
      "SELECT id, file_path FROM notes_tabs WHERE file_path LIKE '/%'"
    ).all() as any[];
    if (rows.length === 0) return;

    const oldRoot = path.join(this.dataDir, 'notes');
    const prefixes = [this.notesRoot, oldRoot]
      .map((root) => (root.endsWith(path.sep) ? root : root + path.sep));

    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const abs: string = row.file_path;
        const prefix = prefixes.find((p) => abs.startsWith(p));
        const relative = prefix ? abs.slice(prefix.length) : abs;
        this.db.prepare('UPDATE notes_tabs SET file_path = ? WHERE id = ?')
          .run(relative, row.id);
      }
    });
    migrate();
  }

  // --- Panel operations ---

  createPanel(scope: NotesScope, panelId?: string): NotesPanelInfo {
    const id = panelId || `notes-panel-${nanoid(8)}`;
    const now = new Date().toISOString();
    // Upsert: if this panel was previously closed, re-open it
    const existing = this.db.prepare('SELECT * FROM notes_panels WHERE id = ?').get(id) as any;
    if (existing) {
      this.db.prepare('UPDATE notes_panels SET closed_at = NULL WHERE id = ?').run(id);
      return this.rowToPanel({ ...existing, closed_at: null });
    }
    this.db.prepare(
      'INSERT INTO notes_panels (id, scope_kind, scope_id, name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, scope.kind, scope.id, 'Untitled', now);
    return { id, scopeKind: scope.kind, scopeId: scope.id, name: 'Untitled', createdAt: now, closedAt: null };
  }

  closePanel(panelId: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE notes_panels SET closed_at = ? WHERE id = ?').run(now, panelId);
  }

  restorePanel(panelId: string): NotesPanelInfo | null {
    this.db.prepare('UPDATE notes_panels SET closed_at = NULL WHERE id = ?').run(panelId);
    const row = this.db.prepare('SELECT * FROM notes_panels WHERE id = ?').get(panelId) as any;
    return row ? this.rowToPanel(row) : null;
  }

  destroyPanel(panelId: string): void {
    const panel = this.db.prepare('SELECT * FROM notes_panels WHERE id = ?').get(panelId) as any;
    if (!panel) return;
    // Delete tabs and files
    const tabs = this.db.prepare('SELECT * FROM notes_tabs WHERE scope_kind = ? AND scope_id = ?')
      .all(panel.scope_kind, panel.scope_id) as any[];
    for (const tab of tabs) {
      this.deleteTabFile(tab.file_path);
    }
    this.db.prepare('DELETE FROM notes_tabs WHERE scope_kind = ? AND scope_id = ?')
      .run(panel.scope_kind, panel.scope_id);
    this.db.prepare('DELETE FROM notes_panels WHERE id = ?').run(panelId);
    // Remove directory
    const dir = this.scopeDir({ kind: panel.scope_kind, id: panel.scope_id });
    try { fs.rmSync(dir, { recursive: true }); } catch { /* ok */ }
  }

  getClosedGlobalPanels(): NotesPanelInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM notes_panels WHERE scope_kind = 'global' AND closed_at IS NOT NULL ORDER BY closed_at DESC"
    ).all() as any[];
    return rows.map(this.rowToPanel);
  }

  getAllGlobalPanels(): NotesPanelInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM notes_panels WHERE scope_kind = 'global' ORDER BY created_at ASC"
    ).all() as any[];
    return rows.map(this.rowToPanel);
  }

  renamePanel(panelId: string, name: string): void {
    this.db.prepare('UPDATE notes_panels SET name = ? WHERE id = ?').run(name, panelId);
  }

  getPanelName(panelId: string): string {
    const row = this.db.prepare('SELECT name FROM notes_panels WHERE id = ?').get(panelId) as any;
    return row?.name || 'Untitled';
  }

  // --- Tab operations ---

  createTab(scope: NotesScope): NotesTabInfo {
    const id = `tab-${nanoid(6)}`;
    const relativePath = this.relativeTabPath(scope, id);
    const absolutePath = this.resolveTabPath(relativePath);
    const maxOrder = (this.db.prepare(
      'SELECT MAX(sort_order) as m FROM notes_tabs WHERE scope_kind = ? AND scope_id = ? AND is_open = 1'
    ).get(scope.kind, scope.id) as any)?.m ?? -1;

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '', 'utf-8');

    this.db.prepare(
      'INSERT INTO notes_tabs (id, scope_kind, scope_id, name, file_path, is_open, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(id, scope.kind, scope.id, null, relativePath, maxOrder + 1);

    return { id, scopeKind: scope.kind, scopeId: scope.id, name: 'Untitled', filePath: relativePath, isOpen: true, sortOrder: maxOrder + 1, closedAt: null };
  }

  closeTab(tabId: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE notes_tabs SET is_open = 0, closed_at = ? WHERE id = ?').run(now, tabId);
  }

  restoreTab(tabId: string): NotesTabInfo | null {
    this.db.prepare('UPDATE notes_tabs SET is_open = 1, closed_at = NULL WHERE id = ?').run(tabId);
    const row = this.db.prepare('SELECT * FROM notes_tabs WHERE id = ?').get(tabId) as any;
    return row ? this.rowToTab(row) : null;
  }

  getClosedTabs(scope: NotesScope): NotesTabInfo[] {
    const rows = this.db.prepare(
      'SELECT * FROM notes_tabs WHERE scope_kind = ? AND scope_id = ? AND is_open = 0 ORDER BY closed_at DESC'
    ).all(scope.kind, scope.id) as any[];
    return rows.map(this.rowToTab);
  }

  getOpenTabs(scope: NotesScope): NotesTabInfo[] {
    const rows = this.db.prepare(
      'SELECT * FROM notes_tabs WHERE scope_kind = ? AND scope_id = ? AND is_open = 1 ORDER BY sort_order ASC'
    ).all(scope.kind, scope.id) as any[];
    return rows.map(this.rowToTab);
  }

  renameTab(tabId: string, name: string): void {
    this.db.prepare('UPDATE notes_tabs SET name = ? WHERE id = ?').run(name, tabId);
  }

  saveTabContent(tabId: string, content: string): void {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    if (!row) return;
    const absPath = this.resolveTabPath(row.file_path);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }

  loadTabContent(tabId: string): string {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    if (!row) return '';
    try {
      return fs.readFileSync(this.resolveTabPath(row.file_path), 'utf-8');
    } catch {
      return '';
    }
  }

  getTabFilePath(tabId: string): string {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    return row ? this.resolveTabPath(row.file_path) : '';
  }

  exportTab(tabId: string, destPath: string): void {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    if (!row) return;
    fs.copyFileSync(this.resolveTabPath(row.file_path), destPath);
  }

  destroySessionNotes(sessionId: string): void {
    const tabs = this.db.prepare(
      "SELECT file_path FROM notes_tabs WHERE scope_kind = 'session' AND scope_id = ?"
    ).all(sessionId) as any[];
    for (const t of tabs) this.deleteTabFile(t.file_path);
    this.db.prepare("DELETE FROM notes_tabs WHERE scope_kind = 'session' AND scope_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM notes_panels WHERE scope_kind = 'session' AND scope_id = ?").run(sessionId);
    const dir = path.join(this.notesRoot, 'sessions', sessionId);
    try { fs.rmSync(dir, { recursive: true }); } catch { /* ok */ }
  }

  // --- Helpers ---

  private scopeDir(scope: NotesScope): string {
    if (scope.kind === 'global') {
      return path.join(this.notesRoot, 'global', scope.id);
    }
    return path.join(this.notesRoot, 'sessions', scope.id);
  }

  /** Relative path for DB storage (relative to notesRoot) */
  private relativeTabPath(scope: NotesScope, tabId: string): string {
    if (scope.kind === 'global') {
      return path.join('global', scope.id, `${tabId}.md`);
    }
    return path.join('sessions', scope.id, `${tabId}.md`);
  }

  /** Resolve a relative file_path from the DB to an absolute path */
  private resolveTabPath(relativePath: string): string {
    return path.join(this.notesRoot, relativePath);
  }

  private deleteTabFile(relativePath: string): void {
    try { fs.unlinkSync(this.resolveTabPath(relativePath)); } catch { /* ok */ }
  }

  private rowToPanel = (row: any): NotesPanelInfo => ({
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    name: row.name || 'Untitled',
    createdAt: row.created_at,
    closedAt: row.closed_at,
  });

  private rowToTab = (row: any): NotesTabInfo => ({
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    name: row.name || 'Untitled',
    filePath: row.file_path,
    isOpen: row.is_open === 1,
    sortOrder: row.sort_order,
    closedAt: row.closed_at,
  });
}
