import { IpcMain, BrowserWindow, clipboard } from 'electron';
import { SessionManager } from './sessions';
import { fetchJiraIssue } from './jira';
import { JiraIssue } from './types';

export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('sessions:get', () => sessionManager.getSessions());

  ipcMain.handle('sessions:create', (_event, opts) =>
    sessionManager.createSession(opts)
  );

  ipcMain.handle('sessions:destroy', (_event, id: string) => {
    sessionManager.destroySession(id);
  });

  ipcMain.handle('sessions:rename', (_event, id: string, name: string) => {
    sessionManager.renameSession(id, name);
  });

  ipcMain.handle('sessions:revive', (_event, id: string) =>
    sessionManager.reviveSession(id)
  );

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    sessionManager.ptyWrite(id, data);
  });

  ipcMain.handle('pty:resize', (_event, id: string, cols: number, rows: number) => {
    sessionManager.ptyResize(id, cols, rows);
  });

  ipcMain.handle('projects:get', () => sessionManager.getProjectEntries());
  ipcMain.handle('projects:getGroups', () => sessionManager.getProjectGroups());

  ipcMain.handle('projects:add', (_event, entry: { key: string; repo: string; group: string }) =>
    sessionManager.addProject(entry.key, entry.repo, entry.group)
  );

  ipcMain.handle('projects:remove', (_event, key: string) =>
    sessionManager.removeProject(key)
  );

  ipcMain.handle('projects:addGroup', (_event, name: string) =>
    sessionManager.addGroup(name)
  );

  ipcMain.handle('projects:removeGroup', (_event, name: string) =>
    sessionManager.removeGroup(name)
  );

  ipcMain.handle('projects:move', (_event, key: string, toGroup: string, toIndex: number) =>
    sessionManager.moveWorkspace(key, toGroup, toIndex)
  );

  ipcMain.handle('projects:reorderGroup', (_event, name: string, toIndex: number) =>
    sessionManager.reorderGroup(name, toIndex)
  );

  // Jira
  ipcMain.handle('jira:fetchIssue', (_event, key: string) => fetchJiraIssue(key));

  ipcMain.handle('jira:saveIssue', (_event, sessionId: string, issue: JiraIssue) => {
    sessionManager.saveJiraIssue(sessionId, issue);
  });

  ipcMain.handle('jira:clearIssue', (_event, sessionId: string) => {
    sessionManager.clearJiraIssue(sessionId);
  });

  // Window controls for custom frameless titlebar
  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:maximize', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', () => getWindow()?.close());

  // Notify session manager of window reference whenever renderer is ready,
  // then restore sessions so PTY events are never fired while window is null.
  ipcMain.on('renderer:ready', () => {
    const win = getWindow();
    if (win) {
      sessionManager.setWindow(win);
      sessionManager.restoreSessions();
    }
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
}
