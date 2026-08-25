import * as fs from 'fs';
import * as path from 'path';
import { IpcMain } from 'electron';
import {
  getDefaultWorkingRoot, setDefaultWorkingRoot,
  getJiraVaultPath, setJiraVaultPath,
  getNotesRootPath, setNotesRootPath,
  isFirstLaunch, markFirstLaunchComplete,
} from '../settings';
import { migrateJiraVault } from '../migrationVault';
import { migrateNotesRoot } from '../migrationNotes';
import { NotesManager } from '../notes';

export function registerSettingsHandlers(
  ipcMain: IpcMain,
  notesManager: NotesManager,
  dataDir: string,
): void {
  ipcMain.handle('settings:getDefaultRoot', () => getDefaultWorkingRoot(dataDir));
  ipcMain.handle('settings:setDefaultRoot', (_event, root: string) => setDefaultWorkingRoot(dataDir, root));
  ipcMain.handle('settings:getJiraVaultPath', () => getJiraVaultPath(dataDir));
  ipcMain.handle('settings:setJiraVaultPath', (_event, vaultPath: string) => setJiraVaultPath(dataDir, vaultPath));
  ipcMain.handle('settings:getNotesRoot', () => getNotesRootPath(dataDir));
  ipcMain.handle('settings:setNotesRoot', (_event, rootPath: string) => {
    setNotesRootPath(dataDir, rootPath);
    // Keep the live NotesManager in sync, otherwise it keeps writing to the
    // previous root until the next restart.
    notesManager.setNotesRoot(rootPath);
  });
  ipcMain.handle('settings:isFirstLaunch', () => isFirstLaunch(dataDir));
  ipcMain.handle('settings:markFirstLaunchComplete', () => markFirstLaunchComplete(dataDir));

  // Migration
  ipcMain.handle('jira:migrateVault', (_event, newPath: string) =>
    migrateJiraVault(dataDir, newPath)
  );
  ipcMain.handle('notes:migrateRoot', (_event, newPath: string) =>
    migrateNotesRoot(dataDir, newPath, notesManager)
  );

  ipcMain.handle('settings:isPathNonEmpty', (_event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) return false;
      return fs.readdirSync(resolved).length > 0;
    } catch { return false; }
  });
}
