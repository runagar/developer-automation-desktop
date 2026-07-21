import { IpcMain } from 'electron';
import { SessionManager } from '../sessions';
import { ShellTmuxManager } from '../shellTmux';
import { NotesManager } from '../notes';

export function registerSessionHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  shellTmuxManager: ShellTmuxManager,
  notesManager: NotesManager,
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
}
