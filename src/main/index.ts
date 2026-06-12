import { app, BrowserWindow, ipcMain, shell, screen } from 'electron';
import * as path from 'path';
import { SessionManager } from './sessions';
import { registerIpcHandlers } from './ipc';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    frame: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'AGENT SMITH',
    icon: path.join(__dirname, '../../assets/agent_smith_icon.png'),
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  mainWindow.setMenuBarVisibility(false);
  sessionManager.setWindow(mainWindow);

  // Fix invisible OS resize-shadow border offset when maximized (WSLg / Windows).
  // Without this, the window content is pushed ~7px right and down on maximize.
  // setBounds must be deferred — calling it synchronously inside 'maximize' crashes.
  mainWindow.on('maximize', () => {
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const display = screen.getDisplayMatching(mainWindow.getBounds());
        mainWindow.setBounds(display.workArea);
      }
    });
    mainWindow?.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () =>
    mainWindow?.webContents.send('window:maximized', false)
  );

  // Log all renderer console messages to main process stdout for debugging
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[RENDERER ${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[RENDERER LOAD FAIL] ${errorCode}: ${errorDescription}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[RENDERER GONE]', details);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    sessionManager.setWindow(null);
  });
}

async function initialize(): Promise<void> {
  const dataDir = path.join(app.getPath('userData'), 'agent-smith');
  sessionManager = new SessionManager(dataDir);
  await sessionManager.initialize();

  registerIpcHandlers(ipcMain, sessionManager, () => mainWindow, dataDir);
}

// WSLg: run GPU thread in-process to prevent separate GPU process crash,
// while still allowing GPU-accelerated compositing for smooth CSS animations.
app.commandLine.appendSwitch('in-process-gpu');

app.on('ready', async () => {
  await initialize();
  createWindow();
  // Open DevTools in dev to expose renderer errors
  if (process.env.NODE_ENV !== 'production' && mainWindow) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
});

app.on('window-all-closed', async () => {
  await sessionManager.persistAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
