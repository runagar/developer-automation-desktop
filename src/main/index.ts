import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessions';
import { ShellTmuxManager } from './shellTmux';
import { WorkspaceManager } from './workspaces';
import type { StatePoller } from './statePoller';
import { registerIpcHandlers, getRegisteredStatePoller, stopRegisteredStatePoller } from './ipc';
import { loadSettings } from './settings';

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager;
let shellTmuxManager: ShellTmuxManager;
let workspaceManager: WorkspaceManager;
let statePoller: StatePoller | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'AGENT SMITH',
    icon: path.join(__dirname, '../../assets/agent_smith_icon.png'),
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  mainWindow.setMenuBarVisibility(false);
  sessionManager.setWindow(mainWindow);
  shellTmuxManager.setWindow(mainWindow);

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
    shellTmuxManager.setWindow(null);
  });
}

async function initialize(): Promise<void> {
  const dataDir = path.join(app.getPath('userData'), 'agent-smith');
  fs.mkdirSync(dataDir, { recursive: true });

  // Migrate projects.json → workspaces.json
  const workspacesPath = path.join(dataDir, 'workspaces.json');
  const oldProjectsPath = path.join(dataDir, 'projects.json');
  if (!fs.existsSync(workspacesPath)) {
    if (fs.existsSync(oldProjectsPath)) {
      fs.renameSync(oldProjectsPath, workspacesPath);
    } else {
      const defaultPath = path.join(app.getAppPath(), 'assets', 'default-workspaces.json');
      fs.copyFileSync(defaultPath, workspacesPath);
    }
  }

  // Create settings.json with defaults if missing
  loadSettings(dataDir);

  sessionManager = new SessionManager(dataDir);
  shellTmuxManager = new ShellTmuxManager();
  workspaceManager = new WorkspaceManager(workspacesPath, dataDir);
  await sessionManager.initialize();

  registerIpcHandlers(ipcMain, sessionManager, shellTmuxManager, workspaceManager, () => mainWindow, dataDir);
}

// WSLg: run GPU thread in-process to prevent separate GPU process crash.
app.commandLine.appendSwitch('in-process-gpu');

app.on('ready', async () => {
  await initialize();
  createWindow();

});

app.on('window-all-closed', async () => {
  shellTmuxManager.killAll();
  statePoller = getRegisteredStatePoller();
  statePoller?.stop();
  stopRegisteredStatePoller();
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
