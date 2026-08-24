export type SessionState = 'idle' | 'running' | 'awaiting' | 'suspended';

export interface JiraLinkedIssue {
  key: string;
  summary: string;
  relation: string;             // e.g. "is blocked by", "relates to"
}

export interface JiraIssue {
  __schemaVersion?: number;     // 3 for Markdown description; absent or 2 in legacy cached data
  key: string;
  summary: string;
  description: string;
  status: string;
  priority: string;
  issueType: string;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  fixVersions: string[];
  components: string[];
  parentKey: string | null;
  linkedIssues: JiraLinkedIssue[];
}

export interface Session {
  id: string;               // UUID — also used as copilot --session-id
  name: string;
  workingDir: string;
  project: string | null;   // PFT Beta project key (e.g. NRPCON) or null
  state: SessionState;
  dead: boolean;
  archived: boolean;        // true if session is archived (tmux keeps running)
  warm?: boolean;           // runtime-only: archived session whose copilot tmux is still alive
  restored: boolean;        // true if resumed from a previous run (runtime-only, not persisted)
  createdAt: string;
  lastActive: string;
  jiraKey: string | null;
  jiraData: JiraIssue | null;
}

export interface IpcApi {
  // Session management
  getSessions: () => Promise<Session[]>;
  createSession: (opts: { name?: string; workingDir: string; project?: string }) => Promise<Session>;
  destroySession: (id: string) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  unarchiveSession: (id: string, cols?: number, rows?: number) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  reorderSessions: (orderedIds: string[]) => Promise<void>;
  reviveSession: (id: string, cols?: number, rows?: number) => Promise<void>;
  resumeSession: (id: string) => Promise<void>;

  // PTY I/O (legacy — kept for state poller / session creation only)
  ptyWrite: (sessionId: string, data: string) => void;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;

  // Workspace management
  getWorkspaces: () => Promise<WorkspaceEntry[]>;
  getWorkspaceGroups: () => Promise<WorkspaceGroup[]>;
  addWorkspace: (opts: { key: string; repo: string; group: string; wdr?: string; createMissingDir?: boolean }) => Promise<{ created: boolean; entry?: WorkspaceEntry; path?: string; error?: string }>;
  removeWorkspace: (key: string) => Promise<void>;
  addGroup: (name: string) => Promise<void>;
  removeGroup: (name: string) => Promise<void>;
  moveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  reorderGroup: (name: string, toIndex: number) => Promise<void>;

  // Settings
  getDefaultWorkingRoot: () => Promise<string>;
  setDefaultWorkingRoot: (root: string) => Promise<void>;
  getJiraVaultPath: () => Promise<string>;
  setJiraVaultPath: (vaultPath: string) => Promise<void>;
  getNotesRootPath: () => Promise<string>;
  setNotesRootPath: (rootPath: string) => Promise<void>;
  migrateJiraVault: (newPath: string) => Promise<{ success: boolean; error?: string }>;
  migrateNotesRoot: (newPath: string) => Promise<{ success: boolean; error?: string }>;
  isPathNonEmpty: (dirPath: string) => Promise<boolean>;
  isFirstLaunch: () => Promise<boolean>;
  markFirstLaunchComplete: () => Promise<void>;

  // Jira
  fetchJiraIssue: (key: string) => Promise<JiraIssue>;
  fetchAndPopulateVault: (key: string) => Promise<JiraIssue>;
  writeToVault: (issue: JiraIssue) => Promise<void>;
  readJiraIssue: (key: string) => Promise<JiraIssue | null>;
  getOrFetchJiraIssue: (key: string) => Promise<JiraIssue>;
  saveJiraIssue: (sessionId: string, issue: JiraIssue) => Promise<void>;
  clearJiraIssue: (sessionId: string) => Promise<void>;

  // Window controls (custom titlebar)
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  onWindowMaximized: (callback: (maximized: boolean) => void) => () => void;

  // Clipboard (uses Electron clipboard — no IPC round-trip needed)
  clipboardWrite: (text: string) => void;
  clipboardRead: () => string;

  // Zoom
  setZoom: (factor: number) => void;
  getZoom: () => number;

  // PTY attach/detach (panel-instance-aware)
  ptyAttach: (sessionId: string, panelInstanceId: string, cols?: number, rows?: number) => Promise<void>;
  ptyDetach: (panelInstanceId: string) => Promise<void>;
  ptyWritePanel: (panelInstanceId: string, data: string) => void;
  ptyResizePanel: (panelInstanceId: string, cols: number, rows: number) => Promise<void>;

  // Shell (tmux-backed, panel-instance-aware)
  shellAttach: (sessionId: string, panelInstanceId: string, workingDir: string, cols?: number, rows?: number) => Promise<void>;
  shellDetach: (panelInstanceId: string) => Promise<void>;
  shellWritePanel: (panelInstanceId: string, data: string) => void;
  shellResizePanel: (panelInstanceId: string, cols: number, rows: number) => Promise<void>;
  shellDestroyTmux: (sessionId: string) => Promise<void>;

  // Events (renderer listens)
  onPtyData: (callback: (panelInstanceId: string, data: string) => void) => () => void;
  onShellData: (callback: (panelInstanceId: string, data: string) => void) => () => void;
  onShellExit: (callback: (panelInstanceId: string) => void) => () => void;
  onSessionStateChange: (callback: (sessionId: string, state: SessionState) => void) => () => void;
  onSessionDied: (callback: (sessionId: string) => void) => () => void;
  onSessionArchived: (callback: (sessionId: string) => void) => () => void;
  onSessionsWarmthChanged: (callback: (warmIds: string[]) => void) => () => void;

  // Notes
  notesCreatePanel: (scope: { kind: string; id: string }, panelId?: string) => Promise<any>;
  notesClosePanel: (panelId: string) => Promise<void>;
  notesDestroyPanel: (panelId: string) => Promise<void>;
  notesRestorePanel: (panelId: string) => Promise<any>;
  notesGetClosedPanels: () => Promise<any[]>;
  notesGetAllGlobalPanels: () => Promise<any[]>;
  notesRenamePanel: (panelId: string, name: string) => Promise<void>;
  notesCreateTab: (scope: { kind: string; id: string }) => Promise<any>;
  notesCloseTab: (tabId: string) => Promise<void>;
  notesRestoreTab: (tabId: string) => Promise<any>;
  notesGetClosedTabs: (scope: { kind: string; id: string }) => Promise<any[]>;
  notesRenameTab: (tabId: string, name: string) => Promise<void>;
  notesSaveContent: (tabId: string, content: string) => Promise<void>;
  notesLoadContent: (tabId: string) => Promise<string>;
  notesGetTabs: (scope: { kind: string; id: string }) => Promise<any[]>;
  notesExportTab: (tabId: string) => Promise<boolean>;
  notesCopyRef: (tabId: string) => Promise<string>;

  // Credentials
  getCredentialStatus: () => Promise<CredentialStatusInfo[]>;
  saveCredentials: (updates: Array<{ key: string; value: string }>) => Promise<Array<{ key: string; valid: boolean; error?: string }>>;
  clearCredential: (key: string) => Promise<void>;

  // Auto-updater
  onUpdaterStatus: (cb: (status: { state: 'downloading' | 'ready'; version: string }) => void) => () => void;
  updaterInstall: () => void;
}

export interface CredentialStatusInfo {
  key: string;
  label: string;
  group: string;
  sensitive: boolean;
  required: boolean;
  placeholder?: string;
  source: 'env' | 'file' | 'none';
  value: string;
}

export interface WorkspaceEntry {
  key: string;         // e.g. NRPCON
  repo: string;        // e.g. rs-consent
  workingDir: string;  // e.g. /home/rulu/projects/rs-consent
}

export interface WorkspaceGroup {
  group: string;
  workspaces: WorkspaceEntry[];
}
