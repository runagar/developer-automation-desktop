import { IpcMain, BrowserWindow, screen } from 'electron';
import { SessionManager } from '../sessions';
import { StatePoller } from '../statePoller';

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

export function registerWindowHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  getWindow: () => BrowserWindow | null,
): void {
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
}
