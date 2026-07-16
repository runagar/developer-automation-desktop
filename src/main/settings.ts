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
  const dataDirDefaults = {
    jiraVaultPath: path.join(dataDir, 'jira-context'),
    notesRootPath: path.join(dataDir, 'notes'),
  };

  if (!fs.existsSync(filePath)) {
    const defaults = defaultSettings();
    defaults.jira.vaultPath = dataDirDefaults.jiraVaultPath;
    defaults.notes.rootPath = dataDirDefaults.notesRootPath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    // Merge with defaults to handle missing keys from older versions
    const defaults = defaultSettings();
    const settings: AppSettings = {
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
    };

    // Persist any newly computed defaults back to the file
    const raw = JSON.stringify(settings, null, 2);
    if (raw !== content) {
      fs.writeFileSync(filePath, raw, 'utf-8');
    }

    return settings;
  } catch {
    const defaults = defaultSettings();
    defaults.jira.vaultPath = dataDirDefaults.jiraVaultPath;
    defaults.notes.rootPath = dataDirDefaults.notesRootPath;
    return defaults;
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
