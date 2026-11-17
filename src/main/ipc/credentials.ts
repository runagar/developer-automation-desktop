import { IpcMain, clipboard } from 'electron';
import {
  getCredentialStatus, validateCredentials, saveManagedCredentials, clearManagedCredential,
} from '../credentials';

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
  ipcMain.handle('credentials:status', async () =>
    (await getCredentialStatus(dataDir)).filter((s) => !RENDERER_HIDDEN_GROUPS.has(s.group)));

  ipcMain.handle('credentials:save', async (_event, updates: Array<{ key: string; value: string }>) => {
    const results = await validateCredentials(dataDir, updates);
    const validKeys = new Set(results.filter((result) => result.valid).map((result) => result.key));
    await saveManagedCredentials(dataDir, updates.filter((update) => validKeys.has(update.key)));
    return results;
  });

  ipcMain.handle('credentials:clear', async (_event, key: string) => {
    await clearManagedCredential(dataDir, key);
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
