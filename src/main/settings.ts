import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------

export interface AppSettings {
  workspaces: {
    defaultWorkingDirectoryRoot: string;
  };
}

function defaultSettings(): AppSettings {
  return {
    workspaces: {
      defaultWorkingDirectoryRoot: path.join(os.homedir(), 'projects'),
    },
  };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'settings.json');
}

export function loadSettings(dataDir: string): AppSettings {
  const filePath = settingsPath(dataDir);
  if (!fs.existsSync(filePath)) {
    const defaults = defaultSettings();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    // Merge with defaults to handle missing keys from older versions
    const defaults = defaultSettings();
    return {
      workspaces: {
        defaultWorkingDirectoryRoot:
          parsed?.workspaces?.defaultWorkingDirectoryRoot ?? defaults.workspaces.defaultWorkingDirectoryRoot,
      },
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(dataDir: string, settings: AppSettings): void {
  const filePath = settingsPath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Convenience getters / setters
// ---------------------------------------------------------------------------

export function getDefaultWorkingRoot(dataDir: string): string {
  return loadSettings(dataDir).workspaces.defaultWorkingDirectoryRoot;
}

export function setDefaultWorkingRoot(dataDir: string, root: string): void {
  const settings = loadSettings(dataDir);
  settings.workspaces.defaultWorkingDirectoryRoot = root;
  saveSettings(dataDir, settings);
}
