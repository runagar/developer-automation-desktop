import { IpcMain, BrowserWindow, clipboard, screen } from 'electron';
import { SessionManager } from './sessions';
import { ShellTmuxManager } from './shellTmux';
import { ProjectManager } from './projects';
import { StatePoller } from './statePoller';
import { fetchJiraIssue, fetchIssueGraph } from './jira';
import { JiraIssue } from './types';
import { writeIssueNote, getVaultRoot } from './vault';
import { loadWhitelist } from './whitelist';

let statePoller: StatePoller | null = null;
let isSimulatedMaximized = false;
let restoreBounds: Electron.Rectangle | null = null;

export function getRegisteredStatePoller(): StatePoller | null {
  return statePoller;
}

export function stopRegisteredStatePoller(): void {
  if (statePoller) {
    statePoller.stop();
    statePoller = null;
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  shellTmuxManager: ShellTmuxManager,
  projectManager: ProjectManager,
  getWindow: () => BrowserWindow | null,
  dataDir: string
): void {
  ipcMain.handle('sessions:get', () => sessionManager.getSessions());

  ipcMain.handle('sessions:create', (_event, opts) =>
    sessionManager.createSession(opts)
  );

  ipcMain.handle('sessions:destroy', async (_event, id: string) => {
    shellTmuxManager.detachAllForSession(id);
    await shellTmuxManager.destroy(id);
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

  ipcMain.handle('sessions:revive', (_event, id: string, cols?: number, rows?: number) =>
    sessionManager.reviveSession(id, cols, rows)
  );

  ipcMain.handle('sessions:resume', (_event, id: string) =>
    sessionManager.resumeSession(id)
  );

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    sessionManager.ptyWrite(id, data);
  });

  ipcMain.handle('pty:resize', (_event, id: string, cols: number, rows: number) => {
    sessionManager.ptyResize(id, cols, rows);
  });

  ipcMain.handle('projects:get', () => projectManager.getEntries());
  ipcMain.handle('projects:getGroups', () => projectManager.getGroups());

  ipcMain.handle('projects:add', (_event, entry: { key: string; repo: string; group: string }) =>
    projectManager.addProject(entry.key, entry.repo, entry.group)
  );

  ipcMain.handle('projects:remove', (_event, key: string) =>
    projectManager.removeProject(key)
  );

  ipcMain.handle('projects:addGroup', (_event, name: string) =>
    projectManager.addGroup(name)
  );

  ipcMain.handle('projects:removeGroup', (_event, name: string) =>
    projectManager.removeGroup(name)
  );

  ipcMain.handle('projects:move', (_event, key: string, toGroup: string, toIndex: number) =>
    projectManager.moveWorkspace(key, toGroup, toIndex)
  );

  ipcMain.handle('projects:reorderGroup', (_event, name: string, toIndex: number) =>
    projectManager.reorderGroup(name, toIndex)
  );

  // Jira
  ipcMain.handle('jira:fetchIssue', (_event, key: string) => fetchJiraIssue(key));

  ipcMain.handle('jira:fetchAndPopulateVault', async (_event, key: string) => {
    const whitelist = loadWhitelist(dataDir);
    const { primary, related, filtered } = await fetchIssueGraph(key, {
      linkedDepth: 1, linkLimit: 8, maxIssues: 30,
      whitelist, maintenanceEpic: 'NRPPRO-326',
    });
    const vaultRoot = getVaultRoot(dataDir);
    writeIssueNote(vaultRoot, primary, filtered);
    for (const issue of related) writeIssueNote(vaultRoot, issue);
    return primary;
  });

  ipcMain.handle('jira:writeToVault', (_event, issue: JiraIssue) => {
    writeIssueNote(getVaultRoot(dataDir), issue);
  });

  ipcMain.handle('jira:saveIssue', (_event, sessionId: string, issue: JiraIssue) => {
    sessionManager.saveJiraIssue(sessionId, issue);
  });

  ipcMain.handle('jira:clearIssue', (_event, sessionId: string) => {
    sessionManager.clearJiraIssue(sessionId);
  });

  // Window controls for custom frameless titlebar
  // WSLg: native maximize causes rendering offset. Instead, manually size to
  // fill the display work area (simulated maximize).
  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:maximize', () => {
    const win = getWindow();
    if (!win) return;
    const isSimMax = win.isMaximized() || isSimulatedMaximized;
    if (isSimMax) {
      isSimulatedMaximized = false;
      if (restoreBounds) {
        win.setBounds(restoreBounds);
        restoreBounds = null;
      } else {
        win.unmaximize();
      }
      win.webContents.send('window:maximized', false);
    } else {
      restoreBounds = win.getBounds();
      isSimulatedMaximized = true;
      const display = screen.getDisplayMatching(win.getBounds());
      win.setBounds(display.workArea);
      win.webContents.send('window:maximized', true);
    }
  });
  ipcMain.handle('window:close', () => getWindow()?.close());

  // WSLg: intercept native maximize (Win+Up, etc.) and convert to simulated
  // maximize so the button and Win+Up share the same toggle state.
  const onNativeMaximize = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    setImmediate(() => {
      if (win.isDestroyed()) return;
      if (!isSimulatedMaximized) {
        restoreBounds = restoreBounds ?? win.getBounds();
      }
      win.unmaximize();
      isSimulatedMaximized = true;
      const display = screen.getDisplayMatching(win.getBounds());
      win.setBounds(display.workArea);
      win.webContents.send('window:maximized', true);
    });
  };
  // Register on current window and re-register when renderer:ready fires
  getWindow()?.on('maximize', onNativeMaximize);

  // Notify session manager of window reference whenever renderer is ready,
  // then restore sessions so PTY events are never fired while window is null.
  ipcMain.on('renderer:ready', () => {
    const win = getWindow();
    if (!win) return;

    // Re-register native maximize interception on this window
    win.removeAllListeners('maximize');
    win.on('maximize', onNativeMaximize);

    sessionManager.setWindow(win);
    void (async () => {
      await sessionManager.restoreSessions();
      if (!statePoller) {
        statePoller = new StatePoller({
          pollMs: 3000,
          getSessionIds: () => sessionManager.getNonDeadSessions(),
          onStateChange: (id, state) => sessionManager.handleStateChange(id, state),
          onDied: (id) => sessionManager.handleDied(id),
        });
        statePoller.start();
      }
    })().catch((error) => {
      console.error('[renderer:ready] Failed to restore sessions', error);
    });
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
