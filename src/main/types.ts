export type SessionState = 'idle' | 'running' | 'awaiting' | 'suspended';

export interface JiraLinkedIssue {
  key: string;
  summary: string;
  relation: string;             // e.g. "is blocked by", "relates to"
}

export interface JiraIssue {
  __schemaVersion?: number;     // 4 adds statusCategory; 3 for Markdown description; absent or 2 in legacy cached data
  key: string;
  summary: string;
  description: string;
  status: string;
  statusCategory?: string;      // Jira statusCategory.key; absent in notes/blobs written before v4
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
  renameWorkspace: (oldKey: string, newKey: string) => Promise<{ renamed: boolean; error?: string }>;
  addGroup: (name: string) => Promise<void>;
  removeGroup: (name: string) => Promise<void>;
  moveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  reorderGroup: (name: string, toIndex: number) => Promise<void>;

  // Workspace discovery
  getPendingDiscovery: () => Promise<DiscoveredWorkspace[]>;
  clearPendingDiscovery: () => Promise<void>;
  discoverWorkspaces: () => Promise<DiscoveredWorkspace[]>;
  saveDiscoveredWorkspaces: (entries: DiscoveredWorkspace[], group: string) => Promise<{ saved: boolean; error?: string }>;

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
  fetchAndPopulateVault: (key: string, force?: boolean) => Promise<JiraIssue>;
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

  /**
   * Mirror the renderer's xterm background/foreground into the main process so
   * it can answer copilot's startup colour query for sessions whose panel is
   * not attached yet. Both values are `#rrggbb`.
   */
  setTerminalColors: (colors: { bg: string; fg: string }) => void;

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

  // Nykredit authentication (R2)
  authStatus: () => Promise<AuthStatusInfo>;
  authLogin: (username: string, password: string) => Promise<AuthStatusInfo>;
  authRetry: () => Promise<AuthStatusInfo>;
  authStartup: () => Promise<AuthStatusInfo>;
  authLogout: () => Promise<AuthStatusInfo>;
  onAuthStateChanged: (cb: (status: AuthStatusInfo) => void) => () => void;

  // API-docs (R2)
  apidocsServices: () => Promise<string[]>;
  apidocsVersions: (service: string) => Promise<ApiDocsServiceVersions>;
  apidocsOperations: (service: string, type: ApiDocsContractType, version: string) => Promise<ApiDocsOperationRow[]>;
  apidocsSelection: (
    service: string, type: ApiDocsContractType, version: string,
    method: string, path: string, acceptVersion: string | null
  ) => Promise<ApiDocsRestSelection | null>;
  apidocsDefinitions: (service: string, type: ApiDocsContractType, version: string) => Promise<Record<string, unknown>>;
  apidocsRefresh: () => Promise<void>;

  // REST Crafter (R3)
  restEnvironments: () => Promise<RestEnvironmentInfo[]>;
  restToken: (environmentKey: string) => Promise<string>;
  restSend: (request: RestRequestSpec) => Promise<RestResultInfo>;

  // Pull Requests (GIT1)
  githubListPullRequests: () => Promise<PrLists>;
  githubGetPullRequest: (ref: PrRef) => Promise<PrDetail>;
  githubGetDiff: (ref: PrRef, diffRef: PrDiffRef, changedFiles: number) => Promise<PrDiff>;
  githubSubmitReview: (
    pullRequestId: string, reviewId: string | null, event: PrReviewEvent, body: string
  ) => Promise<void>;
  githubDiscardReview: (reviewId: string) => Promise<void>;
  githubAddReviewComment: (
    pullRequestId: string, reviewId: string | null, anchor: PrCommentAnchor, body: string
  ) => Promise<{ thread: PrReviewThread; pendingReviewId: string | null }>;
  githubReplyThread: (threadId: string, reviewId: string | null, body: string) => Promise<PrThreadComment>;
  githubAddComment: (
    subjectId: string, body: string
  ) => Promise<{ id: string; createdAt: string; body: string; author: string | null }>;
  githubSetThreadResolved: (threadId: string, resolved: boolean) => Promise<PrThreadState>;
  githubDeleteComment: (id: string, kind: 'review' | 'issue') => Promise<void>;
  githubSetFileViewed: (pullRequestId: string, path: string, viewed: boolean) => Promise<void>;
  githubMerge: (pullRequestId: string, options: PrMergeOptions) => Promise<void>;
  /** Resolves to the branch's new head, or null if GitHub did not report one. */
  githubUpdateBranch: (
    pullRequestId: string, expectedHeadOid: string | null, method: PrBranchUpdateMethod
  ) => Promise<string | null>;
  githubSetAutoMerge: (
    pullRequestId: string, enabled: boolean, options?: PrMergeOptions
  ) => Promise<PrAutoMerge | null>;
  githubSetDraft: (pullRequestId: string, draft: boolean) => Promise<boolean>;
  githubClose: (pullRequestId: string) => Promise<string>;
  githubSetReviewers: (
    pullRequestId: string, userLogins: string[], teamLogins: string[]
  ) => Promise<PrReviewer[]>;

  // Auto-updater
  onUpdaterStatus: (cb: (status: { state: 'downloading' | 'ready' | 'installing' | 'manual'; version: string; command?: string }) => void) => () => void;
  updaterInstall: () => void;
}

export type AuthStateValue = 'no-credentials' | 'logged-in' | 'login-failed' | 'unavailable';
export type AuthReasonValue = 'rejected' | 'network' | 'configuration' | null;

export interface AuthStatusInfo {
  state: AuthStateValue;
  reason: AuthReasonValue;
  message: string;
  username: string;
  /** Where the password comes from — the password itself never reaches the renderer. */
  passwordSource: 'env' | 'file' | 'none';
}

export type ApiDocsContractType = 'RELEASE' | 'PRERELEASE' | 'BRANCH';

export interface ApiDocsContractVersion {
  name: string;
  type: ApiDocsContractType;
  modifiedTs: string;
  href: string | null;
}

export interface ApiDocsServiceVersions {
  releases: ApiDocsContractVersion[];
  prereleases: ApiDocsContractVersion[];
  branches: ApiDocsContractVersion[];
}

export interface ApiDocsParameter {
  name: string;
  in: string;
  required?: boolean;
  type?: string;
  description?: string;
  schema?: unknown;
  [key: string]: unknown;
}

export interface ApiDocsOperationVariant {
  acceptVersion: string | null;
  deprecated: boolean;
  summary: string;
  tags: string[];
  operationId: string | null;
  produces: string[];
  consumes: string[];
  parameters: ApiDocsParameter[];
  bodySchema: unknown | null;
  pathKey: string;
}

export interface ApiDocsOperationRow {
  method: string;
  path: string;
  summary: string;
  deprecated: boolean;
  /** Swagger tag the operation is grouped under; `UNTAGGED` when it declares none. */
  tag: string;
  variants: ApiDocsOperationVariant[];
}

/** What the API Picker hands to the REST Crafter (R3). */
export interface ApiDocsRestSelection {
  serviceName: string;
  category: string;
  contractType: ApiDocsContractType;
  contractVersion: string;
  method: string;
  path: string;
  fullPath: string;
  acceptVersion: string | null;
  acceptHeader: string | null;
  /** Every media type the operation can return — the Accept dropdown. */
  produces: string[];
  consumesVersion: string | null;
  consumesHeader: string | null;
  /** Every media type the operation accepts — the Content-Type dropdown. */
  consumes: string[];
  requestBodySchema: unknown | null;
  /** The request body with every `$ref` expanded, pretty-printed. */
  bodySkeleton: string;
  /** Path, query and header parameters — the body is never included here. */
  parameters: ApiDocsParameter[];
  deprecated: boolean;
  summary: string;
}

/** One target environment for a crafted request (R3). */
export interface RestEnvironmentInfo {
  key: string;
  label: string;
  baseUrl: string;
  securityHost: string | null;
  auth: 'oauth' | 'local-basic';
}

export interface RestHeaderSpec {
  name: string;
  value: string;
}

export interface RestRequestSpec {
  environmentKey: string;
  method: string;
  /** Already substituted and query-appended by the renderer. */
  path: string;
  /** A followed link: used verbatim instead of environment base URL + path. */
  absoluteUrl?: string;
  headers: RestHeaderSpec[];
  body: string;
  /** False once the user has hand-edited Authorization. */
  autoAuth: boolean;
}

export interface RestResultInfo {
  /** False only for a transport failure, where `error` is set. */
  ok: boolean;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
  truncated: boolean;
  durationMs: number;
  url: string;
  method: string;
  error: string | null;
}

export interface CredentialStatusInfo {  key: string;
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

/** A directory found by workspace discovery that is not yet a saved workspace. */
export interface DiscoveredWorkspace {
  key: string;
  repo: string;
  workingDir: string;
}

/** Default group name offered for newly discovered workspaces (editable). */
export const DEFAULT_DISCOVERY_GROUP = 'Default Group';

// ---------------------------------------------------------------------------
// GitHub (GIT1 — Pull Requests)
// ---------------------------------------------------------------------------

export type PrCheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';

/** One entry in the status-check rollup. */
export interface PrCheck {
  name: string;
  /** Normalised across CheckRun's status/conclusion and StatusContext's state. */
  state: PrCheckState | 'SKIPPED';
  /** Whether branch protection requires this one to pass. */
  required: boolean;
}
/**
 * Whether the branch conflicts. **Not** whether it can be merged.
 *
 * GitHub answers MERGEABLE for a draft, for a PR missing required reviews and
 * for one with failing required checks — it only ever reports on textual
 * conflicts. Merge *readiness* is `PrMergeStateStatus`.
 */
export type PrMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * Whether the pull request can actually be merged right now.
 *
 * The seven values are GitHub's `MergeStateStatus` enum verbatim — note that
 * there is no DRAFT member: a draft reports BLOCKED, alongside missing
 * required reviews and failing required checks. `BEHIND` means the head ref
 * is out of date; `UNSTABLE` is mergeable with non-passing (non-required)
 * checks.
 */
export type PrMergeStateStatus =
  | 'CLEAN' | 'DIRTY' | 'BLOCKED' | 'BEHIND' | 'UNSTABLE' | 'HAS_HOOKS' | 'UNKNOWN';

/**
 * A reviewer's position on a pull request.
 *
 * `COMMENTED` and `DISMISSED` are deliberately distinct rather than folded
 * into "no action yet": both say something the other states do not.
 * `PENDING_REQUEST` covers a requested reviewer who has not responded, which
 * is the only state a requested *team* can be in.
 */
export type PrReviewerState =
  | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING_REQUEST';

export interface PrReviewer {
  /** Login for a user, bare slug for a team. Display only. */
  name: string;
  /**
   * What `requestReviewsByLogin` expects back: a login for a user, but the
   * **`org/team-slug`** form for a team — the bare slug is rejected.
   */
  requestKey: string;
  isTeam: boolean;
  /**
   * Bots appear as reviewers but cannot be submitted to
   * `requestReviewsByLogin`, which rejects the whole call.
   */
  isBot: boolean;
  state: PrReviewerState;
  /**
   * True when there is an *outstanding* review request.
   *
   * Distinct from `state`: someone who approved and was then re-requested is
   * both. Only these belong in the replace-set sent to
   * `requestReviewsByLogin` — including past reviewers would silently
   * re-request everyone and invalidate their existing approvals.
   */
  requested: boolean;
}

/** A row in the "Your Pull Requests" panel. */
export interface PrListItem {
  id: string;
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  /** `owner/repo`, shown as the dim second line. */
  nameWithOwner: string;
  isDraft: boolean;
  mergeable: PrMergeableState;
  mergeState: PrMergeStateStatus;
  checks: PrCheckState;
  updatedAt: string;
  reviewers: PrReviewer[];
}

export type PrListId = 'created' | 'reviewing' | 'listening';

export interface PrList {
  items: PrListItem[];
  /** Matches beyond the cap. Approximate for `listening` — see `moreIsApproximate`. */
  more: number;
  moreIsApproximate: boolean;
}

export interface PrLists {
  created: PrList;
  reviewing: PrList;
  listening: PrList;
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrLabel {
  name: string;
  color: string;
}

export interface PrAutoMerge {
  enabledAt: string;
  mergeMethod: PrMergeMethod;
  enabledBy: string | null;
}

export type PrMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

/**
 * Updating a branch is not merging it.
 *
 * Deliberately not `PrMergeMethod`: that union includes `SQUASH`, which
 * GitHub's `PullRequestBranchUpdateMethod` does not accept.
 */
export type PrBranchUpdateMethod = 'MERGE' | 'REBASE';

export interface PrAllowedMergeMethods {
  merge: boolean;
  squash: boolean;
  rebase: boolean;
}

export interface PrPendingReview {
  id: string;
  body: string;
  commentCount: number;
}

/** Merge is not method-agnostic: rebase takes no commit message. */
export interface PrMergeOptions {
  method: PrMergeMethod;
  commitHeadline?: string;
  commitBody?: string;
}

export interface PrCompare {
  aheadBy: number;
  behindBy: number;
  status: string;
}

/** Everything the viewer's header and merge controls need. */
export interface PrSummary {
  id: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  merged: boolean;
  mergeable: PrMergeableState;
  mergeState: PrMergeStateStatus;
  checks: PrCheckState;
  reviewDecision: string | null;
  /** The rollup broken out, for the Checks tooltip. */
  checkRuns: PrCheck[];
  changedFiles: number;
  commitCount: number;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  headRepoOwner: string | null;
  isCrossRepository: boolean;
  viewerCanUpdate: boolean;
  viewerDidAuthor: boolean;
  mergeHeadline: string;
  mergeBody: string;
  autoMerge: PrAutoMerge | null;
  allowedMergeMethods: PrAllowedMergeMethods;
  labels: PrLabel[];
  assignees: string[];
  milestone: string | null;
  reviewers: PrReviewer[];
  suggestedReviewers: string[];
  pendingReview: PrPendingReview | null;
  compare: PrCompare | null;
}

export interface PrCommit {
  oid: string;
  abbreviatedOid: string;
  messageHeadline: string;
  committedDate: string;
  author: string | null;
}

/** A force push, offered in the diff dropdown as a before…after range. */
export interface PrForcePush {
  id: string;
  createdAt: string;
  actor: string | null;
  beforeOid: string | null;
  beforeAbbrev: string | null;
  afterOid: string;
  afterAbbrev: string;
}

/** An inline comment shown under its review in the Overview. */
export interface PrReviewComment {
  id: string;
  path: string;
  /** Null once the anchor no longer exists in the current diff. */
  line: number | null;
  body: string;
  viewerCanDelete: boolean;
}

export type PrTimelineRow =
  | { kind: 'commit'; id: string; at: string; commit: PrCommit }
  | { kind: 'force-push'; id: string; at: string; actor: string | null; force: PrForcePush }
  | {
    kind: 'comment'; id: string; at: string; author: string | null; body: string;
    viewerDidAuthor: boolean; viewerCanDelete: boolean;
  }
  | {
    kind: 'review'; id: string; at: string; author: string | null; state: string; body: string;
    comments: PrReviewComment[];
    /** Comments beyond the page fetched, so a huge review is not silently cut. */
    moreComments: number;
  }
  | {
    kind: 'outdated-thread'; id: string; at: string; author: string | null; path: string;
    body: string; isResolved: boolean;
  }
  | { kind: 'event'; id: string; at: string; actor: string | null; text: string };

export interface PrThreadComment {
  id: string;
  databaseId: number | null;
  body: string;
  createdAt: string;
  author: string | null;
  viewerDidAuthor: boolean;
  outdated: boolean;
  /** `PENDING` while the comment is part of an unsubmitted review. */
  state: string;
  viewerCanDelete: boolean;
}

export interface PrReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  path: string;
  /** Null once the thread's line no longer exists in the current diff. */
  line: number | null;
  startLine: number | null;
  side: 'LEFT' | 'RIGHT';
  comments: PrThreadComment[];
}

/** Which diff the viewer is showing (requirement 3.2.3.1). */
/** What a resolve/unresolve returns: the state *and* the refreshed rights. */
export interface PrThreadState {
  isResolved: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
}

export type PrDiffRef =
  | { kind: 'pr' }
  | { kind: 'commit'; oid: string; abbreviatedOid: string }
  | { kind: 'range'; beforeOid: string; afterOid: string; label: string };

export type PrFileStatus =
  | 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface PrDiffFile {
  path: string;
  previousPath: string | null;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  /** Absent for binary files and files past GitHub's size ceiling. */
  patch: string | null;
  /** Only meaningful in full-PR mode; see ambiguity 27. */
  viewed: boolean;
}

export interface PrDiff {
  files: PrDiffFile[];
  /** True when GitHub returned fewer files than the pull request actually has. */
  truncated: boolean;
  /** The commit a new review comment must be anchored to. */
  headOid: string;
}

export interface PrDetail {
  summary: PrSummary;
  commits: PrCommit[];
  forcePushes: PrForcePush[];
  timeline: PrTimelineRow[];
  threads: PrReviewThread[];
  /** True when a connection hit the page cap and the history is incomplete. */
  historyTruncated: boolean;
}

export type PrReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface PrCommentAnchor {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  startLine: number | null;
  startSide: 'LEFT' | 'RIGHT' | null;
}
