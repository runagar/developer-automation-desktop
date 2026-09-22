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
  github: {
    /**
     * Orgs the PR lists are scoped to.
     *
     * Read once at startup — `loadSettings` caches for the process lifetime,
     * so a change here needs a restart.
     */
    orgs: string[];
  };
  firstLaunchComplete: boolean;
}

/** The org the team's work lives in; overridable in `settings.json`. */
const DEFAULT_GITHUB_ORGS = ['Nykredit'];

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
    github: {
      orgs: [...DEFAULT_GITHUB_ORGS],
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

/**
 * Accept only a list of non-empty strings.
 *
 * A malformed value here would be interpolated straight into a GitHub search
 * query, where it fails as a confusing API error rather than as a settings
 * problem — so it degrades to the default instead.
 */
function parseOrgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_GITHUB_ORGS];
  const orgs = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return orgs.length > 0 ? orgs : [...DEFAULT_GITHUB_ORGS];
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
        github: {
          orgs: parseOrgs(parsed?.github?.orgs),
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

export function saveSettings(dataDir: string, settings: AppSettings): void {  const filePath = settingsPath(dataDir);
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

/**
 * Orgs the pull request lists are scoped to.
 *
 * Read-only by design: there is no setter and no Settings dialog, because
 * `loadSettings` caches for the process lifetime and a live edit would not be
 * seen. Changing it means editing `settings.json` and restarting.
 */
export function getGitHubOrgs(dataDir: string): string[] {
  return loadSettings(dataDir).github.orgs;
}

export function isFirstLaunch(dataDir: string): boolean {  return !loadSettings(dataDir).firstLaunchComplete;
}

export function markFirstLaunchComplete(dataDir: string): void {
  const settings = loadSettings(dataDir);
  settings.firstLaunchComplete = true;
  saveSettings(dataDir, settings);
}
