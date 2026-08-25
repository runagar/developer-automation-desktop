import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessions';
import { ShellTmuxManager } from './shellTmux';
import { WorkspaceManager } from './workspaces';
import { NotesManager } from './notes';
import { registerIpcHandlers, getRegisteredStatePoller, stopRegisteredStatePoller } from './ipc';
import { getMaximizeState, setMaximizeState } from './ipc/window';
import { loadSettings, isFirstLaunch, getDefaultWorkingRoot } from './settings';
import { discoverWorkspaces } from './workspaceDiscovery';
import { DiscoveredWorkspace } from './types';
import { initAutoUpdater } from './updater';

let mainWindow: BrowserWindow | null = null;
let dataDir: string;
let sessionManager: SessionManager;
let shellTmuxManager: ShellTmuxManager;
let workspaceManager: WorkspaceManager;
let notesManager: NotesManager;
let pendingDiscovery: Promise<DiscoveredWorkspace[]> | null = null;

// ---------------------------------------------------------------------------
// Window-state persistence
// ---------------------------------------------------------------------------

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function windowStatePath(): string {
  return path.join(dataDir, 'window-state.json');
}

function loadWindowState(): WindowState {
  const defaults: WindowState = { width: 1920, height: 1080, isMaximized: false };
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf-8');
    const p = JSON.parse(raw);
    if (typeof p.width === 'number' && typeof p.height === 'number') {
      return {
        x: typeof p.x === 'number' ? p.x : undefined,
        y: typeof p.y === 'number' ? p.y : undefined,
        width: Math.max(p.width, 900),
        height: Math.max(p.height, 600),
        isMaximized: p.isMaximized === true,
      };
    }
  } catch {
    // Missing or corrupt — use defaults
  }
  return defaults;
}

function saveWindowState(state: WindowState): void {
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(state), 'utf-8');
  } catch {
    // Non-critical — silently ignore write failures
  }
}

/** Ensure saved bounds are visible on at least one connected display. */
function ensureBoundsOnScreen(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const wa = d.workArea;
    return (
      state.x! < wa.x + wa.width &&
      state.x! + state.width > wa.x &&
      state.y! < wa.y + wa.height &&
      state.y! + state.height > wa.y
    );
  });
  if (!visible) {
    const primary = screen.getPrimaryDisplay();
    return {
      ...state,
      x: primary.workArea.x + Math.round((primary.workArea.width - state.width) / 2),
      y: primary.workArea.y + Math.round((primary.workArea.height - state.height) / 2),
    };
  }
  return state;
}

function saveCurrentWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { isSimulatedMaximized: isMax, restoreBounds: rBounds } = getMaximizeState();
  const bounds = isMax && rBounds ? rBounds : mainWindow.getBounds();
  saveWindowState({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: isMax,
  });
}

function createWindow(): void {
  const saved = ensureBoundsOnScreen(loadWindowState());

  mainWindow = new BrowserWindow({
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: saved.width,
    height: saved.height,
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
    icon: path.join(__dirname, '../../assets/dad.png'),
  });

  // Restore simulated maximize if the window was maximized when last closed
  if (saved.isMaximized) {
    const normalBounds = mainWindow.getBounds();
    setMaximizeState(true, normalBounds);
    const display = screen.getDisplayMatching(normalBounds);
    mainWindow.setBounds(display.workArea);
  }

  // Persist window bounds on move/resize (debounced) and on close
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveCurrentWindowState, 500);
  };
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);
  mainWindow.on('close', () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveCurrentWindowState();
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

  // Auto-updater (production only — skip in dev mode)
  if (!process.env.ELECTRON_RENDERER_URL) {
    initAutoUpdater(mainWindow);
  }
}

async function initialize(): Promise<void> {
  dataDir = path.join(app.getPath('userData'), 'dad');
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

  // First-launch workspace discovery. Read the flag here — before the renderer
  // exists — because SplashScreen flips firstLaunchComplete as soon as the
  // splash finishes. The scan promise is deliberately NOT awaited: an unbounded
  // directory walk must never delay window creation.
  if (isFirstLaunch(dataDir)) {
    pendingDiscovery = discoverWorkspaces(getDefaultWorkingRoot(dataDir), workspaceManager.getEntries())
      .catch(() => []); // never let an unawaited scan surface as an unhandled rejection
  }

  await sessionManager.initialize();

  // Initialize notes manager (uses same DB as sessions)
  const Database = require('better-sqlite3');
  const notesDb = new Database(path.join(dataDir, 'sessions.db'));
  notesManager = new NotesManager(notesDb, dataDir);
  notesManager.initialize();

  registerIpcHandlers(ipcMain, sessionManager, shellTmuxManager, workspaceManager, notesManager, () => mainWindow, dataDir, {
    peek: () => pendingDiscovery ?? Promise.resolve([]),
    clear: () => { pendingDiscovery = null; },
  });
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

// Shutdown cleanup lives on `before-quit`, not `window-all-closed`: the latter
// is not emitted when app.quit() is called directly (e.g. by the auto-updater's
// quitAndInstall), which would skip eviction entirely.
let cleanupDone = false;

app.on('before-quit', (event) => {
  if (cleanupDone) return;
  event.preventDefault();
  void (async () => {
    try {
      shellTmuxManager.killAll();
      stopRegisteredStatePoller();
      await sessionManager.evictArchivedSessions();
      await sessionManager.persistAll();
    } catch (error) {
      console.error('[shutdown] Cleanup failed', error);
    } finally {
      // Must always run — a throw here would otherwise leave the app unquittable.
      cleanupDone = true;
      app.quit();
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
