import { IpcMain, BrowserWindow, clipboard, screen, dialog } from 'electron';
import { SessionManager } from './sessions';
import { ShellTmuxManager } from './shellTmux';
import { WorkspaceManager } from './workspaces';
import { NotesManager, NotesScope } from './notes';
import { StatePoller } from './statePoller';
import { fetchJiraIssue, fetchIssueGraph, clearCredentialCache } from './jira';
import { JiraIssue } from './types';
import { writeIssueNote, getVaultRoot, readFromVault } from './vault';
import { loadWhitelist } from './whitelist';
import {
  getCredentialStatus, validateCredentials, saveCredential, clearCredential,
} from './credentials';
import {
  getDefaultWorkingRoot, setDefaultWorkingRoot,
  getJiraVaultPath, setJiraVaultPath,
  getNotesRootPath, setNotesRootPath,
} from './settings';
import { migrateJiraVault } from './migrationVault';
import { migrateNotesRoot } from './migrationNotes';

let statePoller: StatePoller | null = null;
let isSimulatedMaximized = false;
let restoreBounds: Electron.Rectangle | null = null;

export function getRegisteredStatePoller(): StatePoller | null {
  return statePoller;
}

export function stopRegisteredStatePoller(): void {
  if (statePoller) {
    statePoller.stop();
    statePoller = null;
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  shellTmuxManager: ShellTmuxManager,
  workspaceManager: WorkspaceManager,
  notesManager: NotesManager,
  getWindow: () => BrowserWindow | null,
  dataDir: string
): void {
  ipcMain.handle('sessions:get', () => sessionManager.getSessions());

  ipcMain.handle('sessions:create', (_event, opts) =>
    sessionManager.createSession(opts)
  );

  ipcMain.handle('sessions:destroy', async (_event, id: string) => {
    shellTmuxManager.detachAllForSession(id);
    await shellTmuxManager.destroy(id);
    notesManager.destroySessionNotes(id);
    await sessionManager.destroySession(id);
  });

  ipcMain.handle('sessions:archive', (_event, id: string) => {
    shellTmuxManager.detachAllForSession(id);
    sessionManager.archiveSession(id);
  });

  ipcMain.handle('sessions:unarchive', (_event, id: string, cols?: number, rows?: number) =>
    sessionManager.unarchiveSession(id, cols, rows)
  );

  ipcMain.handle('sessions:rename', (_event, id: string, name: string) => {
    sessionManager.renameSession(id, name);
  });

  ipcMain.handle('sessions:reorder', (_event, orderedIds: string[]) => {
    sessionManager.reorderSessions(orderedIds);
  });

  ipcMain.handle('sessions:revive', (_event, id: string, cols?: number, rows?: number) =>
    sessionManager.reviveSession(id, cols, rows)
  );

  ipcMain.handle('sessions:resume', (_event, id: string) =>
    sessionManager.resumeSession(id)
  );

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    sessionManager.ptyWrite(id, data);
  });

  ipcMain.handle('pty:resize', (_event, id: string, cols: number, rows: number) => {
    sessionManager.ptyResize(id, cols, rows);
  });

  ipcMain.handle('workspaces:get', () => workspaceManager.getEntries());
  ipcMain.handle('workspaces:getGroups', () => workspaceManager.getGroups());

  ipcMain.handle('workspaces:add', (_event, opts: { key: string; repo: string; group: string; wdr?: string; createMissingDir?: boolean }) =>
    workspaceManager.addWorkspace(opts)
  );

  ipcMain.handle('workspaces:remove', (_event, key: string) =>
    workspaceManager.removeWorkspace(key)
  );

  ipcMain.handle('workspaces:addGroup', (_event, name: string) =>
    workspaceManager.addGroup(name)
  );

  ipcMain.handle('workspaces:removeGroup', (_event, name: string) =>
    workspaceManager.removeGroup(name)
  );

  ipcMain.handle('workspaces:move', (_event, key: string, toGroup: string, toIndex: number) =>
    workspaceManager.moveWorkspace(key, toGroup, toIndex)
  );

  ipcMain.handle('workspaces:reorderGroup', (_event, name: string, toIndex: number) =>
    workspaceManager.reorderGroup(name, toIndex)
  );

  // Settings
  ipcMain.handle('settings:getDefaultRoot', () => getDefaultWorkingRoot(dataDir));
  ipcMain.handle('settings:setDefaultRoot', (_event, root: string) => setDefaultWorkingRoot(dataDir, root));
  ipcMain.handle('settings:getJiraVaultPath', () => getJiraVaultPath(dataDir));
  ipcMain.handle('settings:setJiraVaultPath', (_event, vaultPath: string) => setJiraVaultPath(dataDir, vaultPath));
  ipcMain.handle('settings:getNotesRoot', () => getNotesRootPath(dataDir));
  ipcMain.handle('settings:setNotesRoot', (_event, rootPath: string) => setNotesRootPath(dataDir, rootPath));

  // Migration
  ipcMain.handle('jira:migrateVault', (_event, newPath: string) =>
    migrateJiraVault(dataDir, newPath)
  );
  ipcMain.handle('notes:migrateRoot', (_event, newPath: string) =>
    migrateNotesRoot(dataDir, newPath, notesManager)
  );

  ipcMain.handle('settings:isPathNonEmpty', (_event, dirPath: string) => {
    const fs = require('fs');
    const resolved = require('path').resolve(dirPath);
    try {
      if (!fs.existsSync(resolved)) return false;
      const entries = fs.readdirSync(resolved);
      return entries.length > 0;
    } catch { return false; }
  });

  // Jira
  ipcMain.handle('jira:fetchIssue', (_event, key: string) => fetchJiraIssue(key));

  ipcMain.handle('jira:fetchAndPopulateVault', async (_event, key: string) => {
    const whitelist = loadWhitelist(dataDir);
    const { primary, related, filtered } = await fetchIssueGraph(key, {
      linkedDepth: 1, linkLimit: 8, maxIssues: 30,
      whitelist, maintenanceEpic: 'NRPPRO-326',
    });
    const vaultRoot = getVaultRoot(dataDir);
    writeIssueNote(vaultRoot, primary, filtered);
    for (const issue of related) writeIssueNote(vaultRoot, issue);
    return primary;
  });

  ipcMain.handle('jira:writeToVault', (_event, issue: JiraIssue) => {
    writeIssueNote(getVaultRoot(dataDir), issue);
  });

  ipcMain.handle('jira:readIssue', (_event, key: string) => {
    return readFromVault(getVaultRoot(dataDir), key);
  });

  ipcMain.handle('jira:getOrFetch', async (_event, key: string) => {
    const vaultRoot = getVaultRoot(dataDir);
    const cached = readFromVault(vaultRoot, key);
    if (cached) return cached;
    const fetched = await fetchJiraIssue(key);
    writeIssueNote(vaultRoot, fetched);
    return fetched;
  });

  ipcMain.handle('jira:saveIssue', (_event, sessionId: string, issue: JiraIssue) => {
    sessionManager.saveJiraIssue(sessionId, issue);
  });

  ipcMain.handle('jira:clearIssue', (_event, sessionId: string) => {
    sessionManager.clearJiraIssue(sessionId);
  });

  // Window controls for custom frameless titlebar
  // WSLg: native maximize causes rendering offset. Instead, manually size to
  // fill the display work area (simulated maximize).
  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:maximize', () => {
    const win = getWindow();
    if (!win) return;
    const isSimMax = win.isMaximized() || isSimulatedMaximized;
    if (isSimMax) {
      isSimulatedMaximized = false;
      if (restoreBounds) {
        win.setBounds(restoreBounds);
        restoreBounds = null;
      } else {
        win.unmaximize();
      }
      win.webContents.send('window:maximized', false);
    } else {
      restoreBounds = win.getBounds();
      isSimulatedMaximized = true;
      const display = screen.getDisplayMatching(win.getBounds());
      win.setBounds(display.workArea);
      win.webContents.send('window:maximized', true);
    }
  });
  ipcMain.handle('window:close', () => getWindow()?.close());

  // WSLg: intercept native maximize (Win+Up, etc.) and convert to simulated
  // maximize so the button and Win+Up share the same toggle state.
  const onNativeMaximize = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    setImmediate(() => {
      if (win.isDestroyed()) return;
      if (!isSimulatedMaximized) {
        restoreBounds = restoreBounds ?? win.getBounds();
      }
      win.unmaximize();
      isSimulatedMaximized = true;
      const display = screen.getDisplayMatching(win.getBounds());
      win.setBounds(display.workArea);
      win.webContents.send('window:maximized', true);
    });
  };
  // Register on current window and re-register when renderer:ready fires
  getWindow()?.on('maximize', onNativeMaximize);

  // Notify session manager of window reference whenever renderer is ready,
  // then restore sessions so PTY events are never fired while window is null.
  ipcMain.on('renderer:ready', () => {
    const win = getWindow();
    if (!win) return;

    // Re-register native maximize interception on this window
    win.removeAllListeners('maximize');
    win.on('maximize', onNativeMaximize);

    sessionManager.setWindow(win);
    void (async () => {
      await sessionManager.restoreSessions();
      if (!statePoller) {
        statePoller = new StatePoller({
          pollMs: 3000,
          getSessionIds: () => sessionManager.getNonDeadSessions(),
          onStateChange: (id, state) => sessionManager.handleStateChange(id, state),
          onDied: (id) => sessionManager.handleDied(id),
        });
        statePoller.start();
      }
    })().catch((error) => {
      console.error('[renderer:ready] Failed to restore sessions', error);
    });
  });

  // Clipboard — synchronous IPC so the key event handler can read/write
  // clipboard without going async.
  ipcMain.on('clipboard:write', (event, text: string) => {
    clipboard.writeText(text);
    event.returnValue = true;
  });

  ipcMain.on('clipboard:read', (event) => {
    event.returnValue = clipboard.readText();
  });

  // PTY attach/detach (panel-instance-aware)
  ipcMain.handle('pty:attach', (_event, sessionId: string, panelInstanceId: string, cols?: number, rows?: number) =>
    sessionManager.ptyAttach(sessionId, panelInstanceId, cols, rows)
  );

  ipcMain.handle('pty:detach', (_event, panelInstanceId: string) => {
    sessionManager.ptyDetach(panelInstanceId);
  });

  ipcMain.on('pty:writePanel', (_event, panelInstanceId: string, data: string) => {
    sessionManager.ptyWritePanel(panelInstanceId, data);
  });

  ipcMain.handle('pty:resizePanel', (_event, panelInstanceId: string, cols: number, rows: number) => {
    sessionManager.ptyResizePanel(panelInstanceId, cols, rows);
  });

  // Shell tmux (panel-instance-aware)
  ipcMain.handle('shell:attach', (_event, sessionId: string, panelInstanceId: string, workingDir: string, cols?: number, rows?: number) =>
    shellTmuxManager.attach(sessionId, panelInstanceId, workingDir, cols, rows)
  );

  ipcMain.handle('shell:detach', (_event, panelInstanceId: string) => {
    shellTmuxManager.detach(panelInstanceId);
  });

  ipcMain.on('shell:writePanel', (_event, panelInstanceId: string, data: string) => {
    shellTmuxManager.write(panelInstanceId, data);
  });

  ipcMain.handle('shell:resizePanel', (_event, panelInstanceId: string, cols: number, rows: number) => {
    shellTmuxManager.resize(panelInstanceId, cols, rows);
  });

  ipcMain.handle('shell:destroyTmux', (_event, sessionId: string) =>
    shellTmuxManager.destroy(sessionId)
  );

  // Credentials
  ipcMain.handle('credentials:status', () => getCredentialStatus(dataDir));

  ipcMain.handle('credentials:save', async (_event, updates: Array<{ key: string; value: string }>) => {
    const results = await validateCredentials(dataDir, updates);
    for (const r of results) {
      if (r.valid) {
        const update = updates.find((u) => u.key === r.key);
        if (update) saveCredential(dataDir, update.key, update.value);
      }
    }
    clearCredentialCache();
    return results;
  });

  ipcMain.handle('credentials:clear', (_event, key: string) => {
    clearCredential(dataDir, key);
    clearCredentialCache();
  });

  // Notes
  ipcMain.handle('notes:createPanel', (_event, scope: NotesScope, panelId?: string) => notesManager.createPanel(scope, panelId));
  ipcMain.handle('notes:closePanel', (_event, panelId: string) => notesManager.closePanel(panelId));
  ipcMain.handle('notes:destroyPanel', (_event, panelId: string) => notesManager.destroyPanel(panelId));
  ipcMain.handle('notes:restorePanel', (_event, panelId: string) => notesManager.restorePanel(panelId));
  ipcMain.handle('notes:getClosedPanels', () => notesManager.getClosedGlobalPanels());
  ipcMain.handle('notes:getAllGlobalPanels', () => notesManager.getAllGlobalPanels());
  ipcMain.handle('notes:renamePanel', (_event, panelId: string, name: string) => notesManager.renamePanel(panelId, name));
  ipcMain.handle('notes:createTab', (_event, scope: NotesScope) => notesManager.createTab(scope));
  ipcMain.handle('notes:closeTab', (_event, tabId: string) => notesManager.closeTab(tabId));
  ipcMain.handle('notes:restoreTab', (_event, tabId: string) => notesManager.restoreTab(tabId));
  ipcMain.handle('notes:getClosedTabs', (_event, scope: NotesScope) => notesManager.getClosedTabs(scope));
  ipcMain.handle('notes:renameTab', (_event, tabId: string, name: string) => notesManager.renameTab(tabId, name));
  ipcMain.handle('notes:saveContent', (_event, tabId: string, content: string) => notesManager.saveTabContent(tabId, content));
  ipcMain.handle('notes:loadContent', (_event, tabId: string) => notesManager.loadTabContent(tabId));
  ipcMain.handle('notes:getTabs', (_event, scope: NotesScope) => notesManager.getOpenTabs(scope));
  ipcMain.handle('notes:exportTab', async (_event, tabId: string) => {
    const win = getWindow();
    if (!win) return false;
    const filePath = notesManager.getTabFilePath(tabId);
    if (!filePath) return false;
    const defaultName = `${tabId}.md`;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    notesManager.exportTab(tabId, result.filePath);
    return true;
  });
  ipcMain.handle('notes:copyRef', (_event, tabId: string) => notesManager.getTabFilePath(tabId));
}
