import { IpcMain, clipboard } from 'electron';
import {
  getCredentialStatus, validateCredentials, saveCredential, clearCredential,
} from '../credentials';
import { clearCredentialCache } from '../jira';

/**
 * Groups whose values must never cross the IPC boundary.
 *
 * `credentials:status` returns resolved values so the Jira dialog can pre-fill
 * and reveal its token. The Nykredit group holds the user's actual domain
 * password, which the renderer has no reason to ever hold — the login dialog
 * works from `auth:status`, which exposes only the username and the source.
 */
const RENDERER_HIDDEN_GROUPS = new Set(['Nykredit']);

export function registerCredentialHandlers(
  ipcMain: IpcMain,
  dataDir: string,
): void {
  ipcMain.handle('credentials:status', () =>
    getCredentialStatus(dataDir).filter((s) => !RENDERER_HIDDEN_GROUPS.has(s.group)));

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
