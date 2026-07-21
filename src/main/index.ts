import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessions';
import { ShellTmuxManager } from './shellTmux';
import { WorkspaceManager } from './workspaces';
import { NotesManager } from './notes';
import { registerIpcHandlers, getRegisteredStatePoller, stopRegisteredStatePoller } from './ipc';
import { loadSettings } from './settings';

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager;
let shellTmuxManager: ShellTmuxManager;
let workspaceManager: WorkspaceManager;
let notesManager: NotesManager;

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
    title: 'DAD',
    icon: path.join(__dirname, '../../assets/dad_icon.png'),
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

  // Prevent links from opening new Electron windows — open in system browser instead
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

async function initialize(): Promise<void> {
  const dataDir = path.join(app.getPath('userData'), 'dad');
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

  // Initialize notes manager (uses same DB as sessions)
  const Database = require('better-sqlite3');
  const notesDb = new Database(path.join(dataDir, 'sessions.db'));
  notesManager = new NotesManager(notesDb, dataDir);
  notesManager.initialize();

  registerIpcHandlers(ipcMain, sessionManager, shellTmuxManager, workspaceManager, notesManager, () => mainWindow, dataDir);
}

// ---------------------------------------------------------------------------
// Startup dependency check
// ---------------------------------------------------------------------------

function checkCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(!err));
  });
}

async function checkDependencies(): Promise<void> {
  const missing: string[] = [];

  if (!await checkCommand('tmux', ['-V'])) {
    missing.push('• tmux — session persistence\n    Install: sudo apt-get install tmux');
  }

  if (!await checkCommand('copilot', ['--version'])) {
    missing.push('• GitHub Copilot CLI — AI coding assistant\n    Install: npm install -g @github/copilot');
  }

  if (missing.length === 0) return;

  const message = [
    'DAD requires the following dependencies that are not installed or not in PATH:\n',
    ...missing,
    '\nYou can run ./setup.sh from the project root to install all prerequisites automatically.',
  ].join('\n');

  dialog.showMessageBoxSync(mainWindow!, {
    type: 'warning',
    title: 'Missing Dependencies',
    message: 'DAD — Missing Dependencies',
    detail: message,
    buttons: ['OK'],
  });
}

// WSLg: run GPU thread in-process to prevent separate GPU process crash.
app.commandLine.appendSwitch('in-process-gpu');

app.on('ready', async () => {
  await initialize();
  createWindow();
  await checkDependencies();
});

app.on('window-all-closed', async () => {
  shellTmuxManager.killAll();
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
