# Agent Smith

Agent Smith is a desktop terminal manager for the [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli), built with Electron, React, and TypeScript. It lets you run multiple Copilot CLI sessions side by side in a single window, persists them across restarts via tmux, and wraps them in an Atompunk Pip-Boy aesthetic.

---

## Features

### Multi-session management
- Run any number of Copilot CLI sessions simultaneously.
- Switch between sessions from the Sessions panel (click, or focus the panel and use **Tab**).
- Rename any session by right-clicking it → **Session** → **Rename**.
- Archive a session to move it to a collapsible archived section. The tmux session (and copilot agent) keeps running in the background.
- Restore an archived session to bring it back to the active list and reattach to the running tmux session.
- Permanently destroy a session from the archived list with confirmation (kills the tmux session).
- Revive a dead session without losing its scrollback.

### Customizable dashboard
The main workspace is a **24×24 virtual grid** of draggable, resizable panels. Multiple instances of the same panel type can exist simultaneously (e.g. two terminal panels showing different sessions). The grid system is custom-built with React + pointer events (no third-party windowing library), adapted from the pattern in `src/renderer/dashboard/`.

**Panel types:**
| Type | Content | Multi-instance | Mode |
|---|---|---|---|
| `sessions` | Session sidebar (`SessionList`) | No (singleton) | `singleton` |
| `terminal` | CLI Terminal (`TerminalPane`) | Yes | `default` or `linked` |
| `shell` | Shell terminal (tmux-backed) | Yes | `default` or `linked` |
| `jira` | Jira issue pane (`JiraPane`) | Yes | `default` or `linked` |

**Panel modes:**
- **Singleton**: Only one instance exists (Sessions panel). Visibility can be toggled from the Panel menu.
- **Default**: The first panel of each type. Follows the active session — when a new session is activated, the Default panel switches to show that session's content (unless a linked panel of the same type already exists for that session).
- **Linked**: Pinned to a specific session. Created by double-clicking a session or via the context menu. Always shows the same session.

**Panel instance data model** (`PanelInstance`):
- `id` — type-prefixed nanoid (e.g. `terminal-a8f3k2`) or `"sessions"` for the singleton.
- `type` — `'sessions' | 'terminal' | 'jira' | 'shell'`
- `placement` — `{ x, y, w, h, visible, z }`
- `mode` — `'singleton' | 'default' | 'linked'`
- `linkedSessionId` — set only when mode is `linked`
- `currentSessionId` — what the panel is currently displaying

**Default panel promotion:** When the Default panel of a type is closed, the first remaining instance of that type (in reading order) is promoted to Default. It loses its session link but keeps its current content.

**Spawning panels:**
- **Double-click** a session in the list → spawns Terminal + Shell + Jira panels (in that order) for that session. Focus stays on the Sessions panel.
- **Right-click → context menu** on a session → spawn an individual panel type. Focus moves to the spawned panel.
- If a linked panel already exists for that session+type, focus moves to the existing panel instead.
- Spawn placement: (1) fills the first empty space ≥ 2×2; (2) splits an existing same-type panel; (3) overlays at centre 3×3.

**Closing panels:**
- **✕ on a panel** destroys the instance (Sessions panel is hidden instead). Does NOT destroy session resources.
- **Archiving a session** destroys all linked panels for that session.
- **Restoring a session** activates it in Default panels (no new panels spawned).

- **Drag** a panel by its header to move it (snaps to grid cells, clamped to bounds).
- **Resize** from any of 8 edge/corner handles (minimum 1×1 cell).
- **Z-order:** clicking a panel brings it to the front; panels may overlap.
- **Panel menu** (header, left of zoom): toggle Sessions panel visibility and **Lock layout** toggle.
- **Persistence:** the full layout (panel instances + lock state) is saved to `localStorage` (`agent-smith-dashboard`) and restored on launch. Old 12×12 layouts are automatically discarded and replaced with the 24×24 default.
- Default panels display a small **◆** badge in the header to distinguish them from linked panels.

#### Dashboard keyboard navigation
Two-layer, **focus-gated** model:
- **Ctrl+Tab / Ctrl+Shift+Tab** — cycle focus between visible panel instances in grid reading order (top-left → bottom-right, higher-z wins ties).
- **Tab / Shift+Tab** — cycle focusable elements **within** the focused panel only (wraps at the ends). In the terminal panel, Tab goes to the PTY (shell autocomplete). When focus is **outside** any panel (e.g. header), plain Tab is suppressed — there is no global Tab navigation.
- **Sessions panel:** Tab moves between session items, selecting each on focus (Default panels switch to that session).
- **Ctrl+N** opens the New Session dropdown.

### Session persistence (tmux)
Each copilot session runs inside a **tmux session** that is independent of the Electron process. This means:
- **App close** — the copilot agent keeps running in tmux. On next launch, Agent Smith reattaches to the existing tmux sessions and replays scrollback from `capture-pane`.
- **Electron crash** — same as app close; tmux sessions are unaffected.
- **OS restart** — tmux sessions are lost, but Agent Smith creates fresh ones on next launch (copilot `--session-id` resumes the server-side conversation).

**tmux is a hard requirement.** If tmux is not installed, session creation fails with a descriptive error. There is no fallback to direct node-pty.

**tmux session naming:**
- Terminal: `smith-<first 12 chars of UUID>` — deterministic, short, avoids tmux name limits.
- Shell: `smith-shell-<first 12 chars of UUID>` — separate tmux session per app session for the shell panel.

**tmux session configuration:**
- `mouse on` (required for Ink-based CLI mouse tracking)
- `status off` (Agent Smith provides its own chrome)
- `history-limit 50000` (generous scrollback)
- `allow-passthrough on` (for OSC 52 clipboard)
- `set-clipboard on`

**Session lifecycle:**
1. `createSession()` creates a detached tmux session (`tmux new-session -d`) running copilot. PTY attachment is deferred to the renderer.
2. When a terminal panel instance activates, it calls `ptyAttach(sessionId, panelInstanceId)` which spawns an attach PTY (`tmux attach-session`) via node-pty. Each panel instance gets its own PTY client (enabling dual-attach when Default + linked panels show the same session).
3. PTY output flows through the tmux attach client to xterm.js, routed by `panelInstanceId`.
4. On archive, all PTY attachments for the session are killed; tmux sessions (terminal + shell) survive.
5. On app close, `persistAll()` kills all attach PTYs but leaves tmux sessions running.
6. On next launch, `restoreSessions()` ensures tmux sessions exist; PTY attachment is deferred to panel mount.
7. Shell sessions also run in tmux (`smith-shell-*`), with the same lifecycle as terminal sessions.

Each session UUID is passed to copilot as `--session-id`, allowing Copilot's server-side conversation history to be resumed. Sessions are stored in a SQLite database.

### Session archiving
- The **✕ button** on active sessions archives instead of destroying.
- Archived sessions appear in a collapsible **ARCHIVED SESSIONS** section at the bottom of the sidebar.
- Archived sessions show a live state indicator (updated by capturePane polling).
- Each archived session has a **Restore** (↺) button and a **Destroy** (✕) button.
- Destroy permanently kills the tmux session and deletes the DB row (with confirmation).
- Archived sessions are excluded from **Tab** / **Shift+Tab** cycling.
- The collapse state of the archived section is persisted to `localStorage`.

### Session state detection
State detection uses **tmux `capture-pane` polling** — a single `setInterval` (every 3 seconds) captures the visible pane content from each session's tmux window and scans for known patterns.

`SessionState` has four values (`idle` | `running` | `awaiting` | `suspended`). **Dead is not a `SessionState`** — it is a boolean flag (`Session.dead`) set in the DB and displayed by `StateIndicator` in the renderer.

| State / flag | Meaning |
|---|---|
| **Idle** | Input prompt (`❯`) visible in the captured pane |
| **Running** | Output is streaming (`esc cancel` pattern detected) |
| **Awaiting** | CLI is waiting for user input (`enter to select` / `enter to confirm` / `Asking user`) |
| **Suspended** | Copilot was suspended with Ctrl+Z (`Copilot has been suspended` detected). Resumed via SIGCONT (▶ RESUME button or Alt+R in terminal panel) |
| **Dead** *(flag)* | tmux session has exited; session row has `dead = 1` in the DB |

States are shown as coloured indicator pills in the session sidebar.

**Detection patterns** (defined in `src/main/sessions.ts`, `detectStateFromPane()`):

| Pattern in pane capture | Transition |
|---|---|
| `esc cancel` | → `running` |
| `enter to select` | → `awaiting` |
| `enter to confirm` | → `awaiting` |
| `Asking user` | → `awaiting` |
| `❯` | → `idle` |

**Key design decisions:**
- Polling works for **both active and archived sessions** — no attach PTY needed for state detection.
- ~3 second latency on state changes (acceptable since indicators are informational).
- No chunk-tail bridging needed — `capture-pane` returns complete lines.
- The polling loop is managed by `StatePoller`, not `PtySession`.

### Jira issue overview
The Jira pane is a dashboard panel (`jira`) that displays issue details for a session. Multiple Jira panel instances can exist per session (unique among panel types — terminals and shells are limited to one linked panel per session), each linked to a specific session or following the active session (Default mode). Each Jira panel maintains its own issue state independently.

**Fetching issues:**
- Enter a Jira issue key (e.g. `PROJ-123`) in the key input and press Enter or click **FETCH**.
- FETCH triggers a **recursive fetch** via `jira:fetchAndPopulateVault`:
  1. Fetches the primary issue with 12 fields (summary, description, status, priority, issuetype, assignee, reporter, labels, fixVersions, components, issuelinks, parent + discovered custom epic-link field).
  2. Follows linked issues (BFS, depth 1, max 8 links per issue, max 30 total).
  3. Fetches the primary's parent epic (if not the maintenance epic `NRPPRO-326`).
  4. Fetches the epic's children belonging to the same project as the primary.
  5. Filters by project-key whitelist (configurable via `<dataDir>/jira-whitelist.json`).
  6. Writes all fetched issues to the **Jira vault** as Markdown notes with YAML frontmatter and `[[wikilinks]]`.
- Credentials (`ATLASSIAN_PAT` + `ATLASSIAN_BASE_URL`) are resolved by `src/main/credentials.ts` in order:
  1. Environment variables (highest priority — shown as read-only in the UI)
  2. `<dataDir>/credentials.env` (managed via Settings → Credentials dialog)
  3. Error with actionable message if neither source provides both values

**Wiki-to-Markdown conversion:** Jira issue descriptions arrive in wiki markup and are converted to Markdown at fetch time by `src/main/wikiToMarkdown.ts`. The converter handles: headings, bold, italic, bullet/numbered lists (with nesting), code blocks (with language), inline code, links, tables, and colour markup (stripped). Jira issue keys (`PROJ-123`) in the description are automatically wrapped as `[KEY](jira://KEY)` links. Code blocks and inline code are protected from further conversion.

**Display:** SUMMARY → STATUS · PRIORITY · TYPE (metadata row) → LABELS → FIX VERSIONS → DESCRIPTION (rendered Markdown via `react-markdown` + `remark-gfm`) → LINKED ISSUES. Descriptions are rendered as formatted HTML with headings, lists, tables, and code blocks styled per theme.

**Link clickthrough:**
- Clicking a Jira issue key (in Linked Issues section or within the Markdown description) fetches the issue (vault-first via `jira:getOrFetch`, API fallback) and displays it in the same panel.
- Ctrl+clicking spawns a new linked Jira panel showing that issue. Focus stays on the current panel.
- Jira keys in Markdown are rendered via a custom `jira://` URL scheme intercepted by a custom link component.

**PLAN button:** Sends `Plan <KEY>\r` to the active session's PTY as a single-shot write. The user's Copilot skills (`plan-jira-issue`, `implement-jira-issue`) are responsible for making the agent read the vault notes.

**Jira vault:** Local Obsidian-compatible vault at `<userData>/jira-context/` (overridable via `AGENT_SMITH_JIRA_VAULT` env var). Layout: `Jira/<PROJECT>/<KEY>.md` (nested by project). Notes have YAML frontmatter (all fields) and Markdown body (already converted from wiki markup) with `[[wikilinks]]` in the Linked Issues section. Atomic writes (`.tmp` + rename). Notes accumulate across sessions — no auto-cleanup. Vault is also readable via `jira:readIssue` IPC (parses frontmatter + body back into `JiraIssue`).

**Project-key whitelist:** `<dataDir>/jira-whitelist.json` with named profiles. Default profile created on first run with the team's 9 project prefixes. Active profile is global (per-workspace profiles deferred).

**Auto-detect Jira keys:** When enabled (⚡ toggle in the Jira pane header), terminal input is scanned for Jira key patterns. Detected keys are fetched (single issue, non-recursive) and written to the vault silently — the Jira pane is NOT updated. Per-session dedup prevents re-fetching. Toggle persisted to `localStorage`.

**Persistence:** The fetched issue is stored as JSON in the `jira_key` / `jira_data` columns of the `sessions` SQLite table (added via migration-safe `ALTER TABLE`). Only the **default** Jira panel's issue is persisted to the DB; linked/spawned panels are transient. Issues are restored on startup. The type includes `__schemaVersion: 3` for the Markdown-description format.

**Per-panel issue state:** The `jiraStore` keys issues by `panelInstanceId` (not `sessionId`). Each Jira panel manages its own issue independently. When the default panel's session changes, it reseeds from `session.jiraData`.

**IPC channels:** `jira:fetchIssue` (single issue), `jira:fetchAndPopulateVault` (recursive + vault), `jira:writeToVault` (vault-only), `jira:readIssue` (vault-read), `jira:getOrFetch` (vault-first + API fallback), `jira:saveIssue`, `jira:clearIssue` — registered in `ipc.ts`, bound in `preload.ts`, typed in `IpcApi` (`types.ts`).

### Credentials management
The **⚙ SETTINGS** dropdown in the header provides access to the **Credentials** dialog — a modal for managing API tokens and URLs used by Agent Smith's integrations.

**Manifest-driven fields:** Credential fields are defined in `src/main/credentials.ts` as a `CREDENTIAL_FIELDS` array. Each entry specifies `key`, `label`, `group`, `sensitive`, `required`, and optional `placeholder`. Adding a new integration's credentials requires only appending entries to this manifest — no UI code changes needed.

**Current fields:**
| Key | Group | Sensitive | Required |
|---|---|---|---|
| `ATLASSIAN_PAT` | Atlassian | Yes | Yes |
| `ATLASSIAN_BASE_URL` | Atlassian | No | Yes |

**Environment variable precedence:** If a credential is set as a system environment variable, the field is shown as read-only (greyed out) with a "Set via environment variable" note. The user cannot override env-var-managed credentials through the UI.

**Validation on save:** Credentials are validated before saving (e.g. Atlassian credentials are tested by pinging `/rest/api/latest/myself`). Invalid fields are not saved — inline errors are shown. Fields can be saved independently; if the invalidity of one field makes another's validity undetermined, neither is saved.

**Persistence:** Credentials are stored in `<dataDir>/credentials.env` (plain text, chmod 600). The file is created on first save. The `clearCredentialCache()` function in `jira.ts` is called after any save/clear to ensure the next Jira operation uses updated values.

**IPC channels:** `credentials:status` (read all field statuses), `credentials:save` (validate + save), `credentials:clear` (remove a field).

### Workspace management
A **⬡ MANAGE WORKSPACES** button at the bottom of the session sidebar opens a dialog listing all workspaces organised into groups. From this dialog users can:
- **Add** a new workspace by entering a Key, Repo, and Group (workingDir is auto-computed as `/home/rulu/projects/` + Repo).
- **Remove** a workspace with a confirmation prompt. The delete button is disabled while any non-dead session is running for that project key.
- **Add** a new group with the **+ ADD GROUP** button. Empty groups can be removed with the ✕ button on their placeholder row.
- **Reorder workspaces** within and across groups by drag-and-dropping workspace rows.
- **Reorder groups** by drag-and-dropping the group name cell (dragging a group never merges it into another group).

Changes are written back to `<userData>/agent-smith/projects.json` immediately and the in-memory projects list is refreshed so the New Session dropdown reflects the change without restarting. The dropdown renders one header per group with its workspaces listed beneath.

Tab focus is constrained to the dialog while it is open (session Tab-cycling is suppressed). When the add-workspace form is active the Tab cycle is: KEY → REPO → GROUP → ADD → CANCEL → KEY. When the add-group form is active: GROUP NAME → ADD → CANCEL → GROUP NAME.

---

## Technology stack

| Layer | Technology |
|---|---|
| App shell | Electron 33 (WSLg) |
| Renderer | React 18 + TypeScript |
| Bundler | Webpack via `electron-forge` |
| Terminal emulator | xterm.js (`@xterm/xterm`) with FitAddon and WebLinksAddon |
| Session host | tmux (hard requirement) |
| PTY | `node-pty` (for tmux attach client only) |
| Persistence | `better-sqlite3` |

---

## Architecture

```
Main process
├── SessionManager       SQLite session store + session lifecycle + panel-instance PTY attachments
├── ShellTmuxManager     tmux-backed shell session management (attach/detach/destroy per panel instance)
├── ProjectManager       userData-backed workspace config manager
├── StatePoller          tmux capture-pane polling + state detection
├── tmux.ts              tmux CLI wrapper (create/kill/capture for both terminal + shell sessions)
├── PtySession           node-pty wrapper for tmux attach-session client
└── IPC handlers         bridges main ↔ renderer via contextBridge

tmux server (independent process)
├── smith-* sessions       each runs copilot CLI; survives app close
└── smith-shell-* sessions each runs $SHELL; survives app close

Renderer process
├── App.tsx              root wiring, renderBody dispatcher, activation flow
├── stores/              Zustand state stores
│   ├── sessionStore.ts  sessions, activeSessionId, attachGen, lifecycle actions
│   ├── jiraStore.ts     jiraIssues map, auto-fetch toggle/buffer/cache
│   ├── projectStore.ts  projectGroups, CRUD actions
│   └── layoutStore.ts   PanelInstance[] management, spawn/destroy/promote/switchDefault
├── hooks/
│   └── useXterm.ts      shared xterm creation/fit/theme/addons/keys
├── dashboard/           grid layout system (framework-agnostic)
│   ├── layout.ts        24×24 grid math, PanelInstance types, spawn placement algorithm
│   └── usePanelFocus.ts intra-panel Tab wrapping
├── Workspace            24×24 grid container: drag/resize, Ctrl+Tab (instance cycling), focus tracking
├── WorkspacePanel       panel chrome: drag header, resize handles, close, default badge (◆), error boundary
├── PanelMenu            header dropdown: Sessions toggle + lock
├── SessionList          sessions panel body: new/archive/restore/destroy
│   ├── Active sessions  main list with archive button (✕), double-click, context menu
│   └── Archived section collapsible list with restore (↺), destroy (✕), destroy-all
├── SessionContextMenu   right-click context menu: New Panel (Terminal/Shell/Jira) + Rename
├── TerminalPanelInstance per-instance terminal: PTY attach/detach lifecycle, data routing
├── ShellPanelInstance   per-instance shell: shell tmux attach/detach lifecycle, data routing
├── JiraPanelInstance    per-instance Jira: issue display for currentSessionId
├── TerminalPane         xterm.js instance (uses useXterm hook)
├── ShellPane            xterm.js instance (uses useXterm hook), tmux-backed
├── JiraPane             Jira issue overview per session
├── PanelErrorBoundary   per-panel error boundary with retry
├── StateIndicator       idle / running / awaiting / dead pill
├── ConfirmDialog        modal confirmation for destructive actions
├── TitleBar             frameless window controls
├── ThemeSelector        theme switcher
└── ZoomControl          zoom in/out/reset

Preload
└── preload.ts           exposes window.agentSmith IPC API via contextBridge
```

**Data flow:**
```
Renderer panel instance → ptyAttach(sessionId, panelInstanceId) → main process
Main process → node-pty.spawn('tmux attach-session -t smith-xxx') → PTY data → pty:data(panelInstanceId) → renderer
                    ↓
           tmux server → copilot process (child of tmux, NOT Electron)
```

**Session lifecycle:**
1. `createSession()` creates a detached tmux session running copilot. PTY attachment is deferred to the renderer.
2. When a panel instance activates, it calls `ptyAttach(sessionId, panelInstanceId)` which creates a fresh PTY client attached to the session's tmux. Each panel instance has its own PTY client, enabling dual-attach.
3. PTY output is routed to the specific panel instance via `pty:data(panelInstanceId)` IPC events.
4. On archive (✕ button), all PTY attachments for the session are killed, linked panels are destroyed, but tmux sessions (terminal + shell) keep running.
5. On restore (↺ from archived list), the session is activated and Default panels switch to it. PTY attachment happens when the panel instance mounts.
6. On app close, `persistAll()` kills all attach PTYs and stops state polling. tmux sessions survive.
7. On next launch, `restoreSessions()` ensures tmux sessions exist; PTY attachment is driven by panel instance mount.
8. Sessions that were alive when the app closed are marked with `Session.restored = true` (runtime-only flag, not persisted to the DB).

> Scrollback is owned by tmux; on reattach the current screen is repainted by tmux into a clean xterm. There is no manual scrollback replay (it collided with the live buffer and tmux's repaint).

---

## UI

The interface is themed after the Fallout Pip-Boy 3000/3000a terminal aesthetic, inspired by https://www.pip-boy.com/3000a/simulator:
- **Phosphor green** (Pip-Boy 3000) or **amber** (Pip-Boy 3000a) colour scheme
- CRT effects: rolling scanlines, periodic top-to-bottom sweep, centre phosphor bloom
- All text in `Roboto Mono`
- Theme, zoom level, and dashboard layout are persisted to `localStorage`

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Cycle focus between visible panel instances |
| **Tab** / **Shift+Tab** | Cycle within the focused panel (sessions: select session; terminal: shell tab) |
| **Double-click** (session in list) | Spawn Terminal + Shell + Jira panels for that session |
| **Right-click** (session in list) | Context menu: New Panel (Terminal/Shell/Jira), Rename |
| **Ctrl+n** | New session |
| **Ctrl+c** | Copy selection to clipboard (if text is selected); otherwise send SIGINT |
| **Ctrl+v** | Paste from clipboard |
| **Shift+Arrow** | Extend text selection (xterm-level) |
| **Ctrl+Shift+Left/Right** | Extend text selection by word |
| **Ctrl++** / **Ctrl+=** | Zoom in |
| **Ctrl+-** | Zoom out |
| **Ctrl+0** | Reset zoom |

### Clipboard architecture

Two selection modes coexist because the Copilot CLI uses Ink, which enables terminal mouse tracking:

- **Normal click+drag** — handled by the CLI's own Ink-based selection. The CLI copies to clipboard via `xclip` (must be installed: `sudo apt-get install xclip`). Our code does not intercept this.
- **Shift+click+drag** — bypasses mouse tracking and creates a real xterm text selection. Ctrl+C/X copies via Electron's `clipboard` module through synchronous IPC (`clipboard:write` / `clipboard:read` in `ipc.ts`, bound in `preload.ts`).
- **Shift+Arrow** — keyboard selection, creates an xterm selection via `term.select()`. Same copy mechanism as Shift+click.

OSC 52 clipboard-write sequences from CLI applications are intercepted in the PTY data handler and forwarded to Electron's clipboard API.

---

## Configuration

### `projects.json`
Maps project keys to repository names and working directories, organised into named groups. On first launch, Agent Smith copies `assets/default-projects.json` into `<userData>/agent-smith/projects.json`; runtime reads and writes use the userData copy.

```json
[
  {
    "group": "PFT BETA PROJECTS",
    "workspaces": [
      { "key": "NRPCON", "repo": "rs-consent", "workingDir": "/home/rulu/projects/rs-consent" }
    ]
  }
]
```

### Data directory
Session data is stored at:
```
$XDG_CONFIG_HOME/agent-smith/sessions.db
```
On WSLg this resolves to `~/.config/agent-smith/sessions.db`. The directory is created automatically on first launch.

### State detection patterns
Defined in `src/main/statePoller.ts` (`detectStateFromPane()` function). Pattern strings should be confirmed empirically against the installed Copilot CLI version and updated as needed. State is polled from tmux `capture-pane` output every 3 seconds.

---

## Running

```bash
cd "/home/rulu/projects/Agent Smith"
./launch.sh
```

`launch.sh` initialises `fnm` (Node version manager), ensures Electron native module headers are present, and starts the app via `electron-forge start`.

To package a distributable:

```bash
npm run make
```
