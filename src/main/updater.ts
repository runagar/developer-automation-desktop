import { autoUpdater, UpdateInfo } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';

export interface UpdaterStatus {
  state: 'downloading' | 'ready';
  version: string;
}

let win: BrowserWindow | null = null;

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    win?.webContents.send('updater:status', {
      state: 'downloading',
      version: info.version,
    } satisfies UpdaterStatus);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    win?.webContents.send('updater:status', {
      state: 'ready',
      version: info.version,
    } satisfies UpdaterStatus);
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
  });

  ipcMain.on('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.checkForUpdates().catch(() => {});
}
