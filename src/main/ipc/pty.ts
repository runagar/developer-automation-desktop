import { IpcMain } from 'electron';
import { SessionManager } from '../sessions';
import { ShellTmuxManager } from '../shellTmux';

export function registerPtyHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  shellTmuxManager: ShellTmuxManager,
): void {
  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    sessionManager.ptyWrite(id, data);
  });

  ipcMain.handle('pty:resize', (_event, id: string, cols: number, rows: number) => {
    sessionManager.ptyResize(id, cols, rows);
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
}
