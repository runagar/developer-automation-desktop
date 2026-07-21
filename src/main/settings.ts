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
  jira: {
    vaultPath: string;
  };
  notes: {
    rootPath: string;
  };
  firstLaunchComplete: boolean;
}

function defaultSettings(): AppSettings {
  return {
    workspaces: {
      defaultWorkingDirectoryRoot: path.join(os.homedir(), 'projects'),
    },
    jira: {
      vaultPath: '',
    },
    notes: {
      rootPath: '',
    },
    firstLaunchComplete: false,
  };
}

// ---------------------------------------------------------------------------
// In-memory cache (avoids redundant disk reads)
// ---------------------------------------------------------------------------

let cachedSettings: AppSettings | null = null;
let cachedDataDir: string | null = null;

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function settingsPath(dataDir: string): string {
  return path.join(dataDir, 'settings.json');
}

export function loadSettings(dataDir: string): AppSettings {
  if (cachedSettings && cachedDataDir === dataDir) return cachedSettings;
  const filePath = settingsPath(dataDir);
  const dataDirDefaults = {
    jiraVaultPath: path.join(dataDir, 'jira-context'),
    notesRootPath: path.join(dataDir, 'notes'),
  };

  let settings: AppSettings;

  if (!fs.existsSync(filePath)) {
    settings = defaultSettings();
    settings.jira.vaultPath = dataDirDefaults.jiraVaultPath;
    settings.notes.rootPath = dataDirDefaults.notesRootPath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  } else {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const defaults = defaultSettings();
      settings = {
        workspaces: {
          defaultWorkingDirectoryRoot:
            parsed?.workspaces?.defaultWorkingDirectoryRoot ?? defaults.workspaces.defaultWorkingDirectoryRoot,
        },
        jira: {
          vaultPath: parsed?.jira?.vaultPath || dataDirDefaults.jiraVaultPath,
        },
        notes: {
          rootPath: parsed?.notes?.rootPath || dataDirDefaults.notesRootPath,
        },
        firstLaunchComplete: parsed?.firstLaunchComplete === true,
      };

      // Persist any newly computed defaults back to the file
      const raw = JSON.stringify(settings, null, 2);
      if (raw !== content) {
        fs.writeFileSync(filePath, raw, 'utf-8');
      }
    } catch {
      settings = defaultSettings();
      settings.jira.vaultPath = dataDirDefaults.jiraVaultPath;
      settings.notes.rootPath = dataDirDefaults.notesRootPath;
    }
  }

  cachedSettings = settings;
  cachedDataDir = dataDir;
  return settings;
}

export function saveSettings(dataDir: string, settings: AppSettings): void {
  const filePath = settingsPath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  cachedSettings = settings;
  cachedDataDir = dataDir;
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

export function getJiraVaultPath(dataDir: string): string {
  return loadSettings(dataDir).jira.vaultPath;
}

export function setJiraVaultPath(dataDir: string, vaultPath: string): void {
  const settings = loadSettings(dataDir);
  settings.jira.vaultPath = vaultPath;
  saveSettings(dataDir, settings);
}

export function getNotesRootPath(dataDir: string): string {
  return loadSettings(dataDir).notes.rootPath;
}

export function setNotesRootPath(dataDir: string, rootPath: string): void {
  const settings = loadSettings(dataDir);
  settings.notes.rootPath = rootPath;
  saveSettings(dataDir, settings);
}

export function isFirstLaunch(dataDir: string): boolean {
  return !loadSettings(dataDir).firstLaunchComplete;
}

export function markFirstLaunchComplete(dataDir: string): void {
  const settings = loadSettings(dataDir);
  settings.firstLaunchComplete = true;
  saveSettings(dataDir, settings);
}
