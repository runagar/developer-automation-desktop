import { IpcMain, BrowserWindow } from 'electron';
import { SessionManager } from './sessions';
import { ShellTmuxManager } from './shellTmux';
import { WorkspaceManager } from './workspaces';
import { NotesManager } from './notes';
import { DiscoveredWorkspace } from './types';

import { registerSessionHandlers } from './ipc/sessions';
import { registerPtyHandlers } from './ipc/pty';
import { registerWorkspaceHandlers } from './ipc/workspaces';
import { registerSettingsHandlers } from './ipc/settings';
import { registerJiraHandlers } from './ipc/jira';
import { registerNotesHandlers } from './ipc/notes';
import { registerWindowHandlers, getRegisteredStatePoller, stopRegisteredStatePoller } from './ipc/window';
import { registerCredentialHandlers } from './ipc/credentials';
import { registerAuthHandlers } from './ipc/auth';
import { registerRestHandlers } from './ipc/rest';

export { getRegisteredStatePoller, stopRegisteredStatePoller };

export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  shellTmuxManager: ShellTmuxManager,
  workspaceManager: WorkspaceManager,
  notesManager: NotesManager,
  getWindow: () => BrowserWindow | null,
  dataDir: string,
  pendingDiscovery: {
    peek: () => Promise<DiscoveredWorkspace[]>;
    clear: () => void;
  }
): void {
  registerSessionHandlers(ipcMain, sessionManager, shellTmuxManager, notesManager);
  registerPtyHandlers(ipcMain, sessionManager, shellTmuxManager);
  registerWorkspaceHandlers(ipcMain, workspaceManager, dataDir, pendingDiscovery);
  registerSettingsHandlers(ipcMain, notesManager, dataDir);
  registerJiraHandlers(ipcMain, sessionManager, dataDir);
  registerNotesHandlers(ipcMain, notesManager, getWindow);
  registerWindowHandlers(ipcMain, sessionManager, getWindow);
  registerCredentialHandlers(ipcMain, dataDir);
  registerAuthHandlers(ipcMain, getWindow, dataDir);
  registerRestHandlers(ipcMain, dataDir);
}
