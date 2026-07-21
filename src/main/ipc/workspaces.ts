import { IpcMain } from 'electron';
import { WorkspaceManager } from '../workspaces';

export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  workspaceManager: WorkspaceManager,
): void {
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
}
