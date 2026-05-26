export type SessionState = 'idle' | 'running' | 'awaiting';

export interface Session {
  id: string;               // UUID — also used as copilot --session-id
  name: string;
  workingDir: string;
  project: string | null;   // PFT Beta project key (e.g. NRPCON) or null
  state: SessionState;
  dead: boolean;
  restored: boolean;        // true if resumed from a previous run (runtime-only, not persisted)
  createdAt: string;
  lastActive: string;
}

export interface IpcApi {
  // Session management
  getSessions: () => Promise<Session[]>;
  createSession: (opts: { name?: string; workingDir: string; project?: string }) => Promise<Session>;
  destroySession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  reviveSession: (id: string) => Promise<void>;

  // PTY I/O
  ptyWrite: (sessionId: string, data: string) => Promise<void>;
  ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>;

  // Projects dropdown
  getProjects: () => Promise<ProjectEntry[]>;

  // Window controls (custom titlebar)
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  onWindowMaximized: (callback: (maximized: boolean) => void) => () => void;

  // Zoom
  setZoom: (factor: number) => void;
  getZoom: () => number;

  // Events (renderer listens)
  onPtyData: (callback: (sessionId: string, data: string) => void) => () => void;
  onSessionStateChange: (callback: (sessionId: string, state: SessionState) => void) => () => void;
  onSessionDied: (callback: (sessionId: string) => void) => () => void;
}

export interface ProjectEntry {
  key: string;         // e.g. NRPCON
  repo: string;        // e.g. rs-consent
  workingDir: string;  // e.g. /home/rulu/projects/rs-consent
}
