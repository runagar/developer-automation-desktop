export type SessionState = 'idle' | 'running' | 'awaiting';

export interface JiraLinkedIssue {
  key: string;
  summary: string;
  relation: string;             // e.g. "is blocked by", "relates to"
}

export interface JiraIssue {
  __schemaVersion?: number;     // 2 for the expanded format; absent in legacy cached data
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  releaseNotes: string;
  developerTasks: string;
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
  reviveSession: (id: string, cols?: number, rows?: number) => Promise<void>;

  // PTY I/O (legacy — kept for state poller / session creation only)
  ptyWrite: (sessionId: string, data: string) => void;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;

  // Projects dropdown / workspace management
  getProjects: () => Promise<ProjectEntry[]>;
  getProjectGroups: () => Promise<ProjectGroup[]>;
  addProject: (entry: { key: string; repo: string; group: string }) => Promise<ProjectEntry>;
  removeProject: (key: string) => Promise<void>;
  addGroup: (name: string) => Promise<void>;
  removeGroup: (name: string) => Promise<void>;
  moveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  reorderGroup: (name: string, toIndex: number) => Promise<void>;

  // Jira
  fetchJiraIssue: (key: string) => Promise<JiraIssue>;
  fetchAndPopulateVault: (key: string) => Promise<JiraIssue>;
  writeToVault: (issue: JiraIssue) => Promise<void>;
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
}

export interface ProjectEntry {
  key: string;         // e.g. NRPCON
  repo: string;        // e.g. rs-consent
  workingDir: string;  // e.g. /home/rulu/projects/rs-consent
}

export interface ProjectGroup {
  group: string;
  workspaces: ProjectEntry[];
}
