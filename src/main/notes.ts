import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';

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

  constructor(db: Database.Database, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes_panels (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      )
    `);
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
      'INSERT INTO notes_panels (id, scope_kind, scope_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, scope.kind, scope.id, now);
    return { id, scopeKind: scope.kind, scopeId: scope.id, createdAt: now, closedAt: null };
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

  // --- Tab operations ---

  createTab(scope: NotesScope): NotesTabInfo {
    const id = `tab-${nanoid(6)}`;
    const filePath = this.tabFilePath(scope, id);
    const maxOrder = (this.db.prepare(
      'SELECT MAX(sort_order) as m FROM notes_tabs WHERE scope_kind = ? AND scope_id = ? AND is_open = 1'
    ).get(scope.kind, scope.id) as any)?.m ?? -1;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf-8');

    this.db.prepare(
      'INSERT INTO notes_tabs (id, scope_kind, scope_id, name, file_path, is_open, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(id, scope.kind, scope.id, null, filePath, maxOrder + 1);

    return { id, scopeKind: scope.kind, scopeId: scope.id, name: id, filePath, isOpen: true, sortOrder: maxOrder + 1, closedAt: null };
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
    fs.mkdirSync(path.dirname(row.file_path), { recursive: true });
    fs.writeFileSync(row.file_path, content, 'utf-8');
  }

  loadTabContent(tabId: string): string {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    if (!row) return '';
    try {
      return fs.readFileSync(row.file_path, 'utf-8');
    } catch {
      return '';
    }
  }

  getTabFilePath(tabId: string): string {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    return row?.file_path ?? '';
  }

  exportTab(tabId: string, destPath: string): void {
    const row = this.db.prepare('SELECT file_path FROM notes_tabs WHERE id = ?').get(tabId) as any;
    if (!row) return;
    fs.copyFileSync(row.file_path, destPath);
  }

  destroySessionNotes(sessionId: string): void {
    const tabs = this.db.prepare(
      "SELECT file_path FROM notes_tabs WHERE scope_kind = 'session' AND scope_id = ?"
    ).all(sessionId) as any[];
    for (const t of tabs) this.deleteTabFile(t.file_path);
    this.db.prepare("DELETE FROM notes_tabs WHERE scope_kind = 'session' AND scope_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM notes_panels WHERE scope_kind = 'session' AND scope_id = ?").run(sessionId);
    const dir = path.join(this.dataDir, 'notes', 'sessions', sessionId);
    try { fs.rmSync(dir, { recursive: true }); } catch { /* ok */ }
  }

  // --- Helpers ---

  private scopeDir(scope: NotesScope): string {
    if (scope.kind === 'global') {
      return path.join(this.dataDir, 'notes', 'global', scope.id);
    }
    return path.join(this.dataDir, 'notes', 'sessions', scope.id);
  }

  private tabFilePath(scope: NotesScope, tabId: string): string {
    return path.join(this.scopeDir(scope), `${tabId}.md`);
  }

  private deleteTabFile(filePath: string): void {
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }

  private rowToPanel = (row: any): NotesPanelInfo => ({
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  });

  private rowToTab = (row: any): NotesTabInfo => ({
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    name: row.name || row.id,
    filePath: row.file_path,
    isOpen: row.is_open === 1,
    sortOrder: row.sort_order,
    closedAt: row.closed_at,
  });
}
