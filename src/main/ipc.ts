import { IpcMain, BrowserWindow } from 'electron';
import { SessionManager } from './sessions';

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

  ipcMain.handle('pty:write', (_event, id: string, data: string) => {
    sessionManager.ptyWrite(id, data);
  });

  ipcMain.handle('pty:resize', (_event, id: string, cols: number, rows: number) => {
    sessionManager.ptyResize(id, cols, rows);
  });

  ipcMain.handle('projects:get', () => sessionManager.getProjectEntries());

  // Window controls for custom frameless titlebar
  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:maximize', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', () => getWindow()?.close());

  // Notify session manager of window reference whenever renderer is ready
  ipcMain.on('renderer:ready', () => {
    const win = getWindow();
    if (win) sessionManager.setWindow(win);
  });
}
