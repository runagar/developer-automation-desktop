# Agent Smith

Agent Smith is a desktop terminal manager for the [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli), built with Electron, React, and TypeScript. It lets you run multiple Copilot CLI sessions side by side in a single window, persists them across restarts via tmux, and wraps them in an Atompunk Pip-Boy aesthetic.

---

## Features

### Multi-session management
- Run any number of Copilot CLI sessions simultaneously, each in its own terminal pane.
- Switch between sessions via the sidebar or with **Tab** / **Shift+Tab**.
- Rename any session by clicking its name in the terminal header.
- Archive a session to move it to a collapsible archived section. The tmux session (and copilot agent) keeps running in the background.
- Restore an archived session to bring it back to the active list and reattach to the running tmux session.
- Permanently destroy a session from the archived list with confirmation (kills the tmux session).
- Revive a dead session without losing its scrollback.

### Session persistence (tmux)
Each copilot session runs inside a **tmux session** that is independent of the Electron process. This means:
- **App close** — the copilot agent keeps running in tmux. On next launch, Agent Smith reattaches to the existing tmux sessions and replays scrollback from `capture-pane`.
- **Electron crash** — same as app close; tmux sessions are unaffected.
- **OS restart** — tmux sessions are lost, but Agent Smith creates fresh ones on next launch (copilot `--session-id` resumes the server-side conversation).

**tmux is a hard requirement.** If tmux is not installed, session creation fails with a descriptive error. There is no fallback to direct node-pty.

**tmux session naming:** `smith-<first 12 chars of UUID>` — deterministic, short, avoids tmux name limits.

**tmux session configuration:**
- `mouse on` (required for Ink-based CLI mouse tracking)
- `status off` (Agent Smith provides its own chrome)
- `history-limit 50000` (generous scrollback)
- `allow-passthrough on` (for OSC 52 clipboard)
- `set-clipboard on`

**Session lifecycle:**
1. `createSession()` creates a detached tmux session (`tmux new-session -d`) running copilot, then spawns an attach PTY (`tmux attach-session`) via node-pty.
2. PTY output flows through the tmux attach client to xterm.js — the renderer is unaware of tmux.
3. On archive, only the attach PTY is killed; the tmux session survives.
4. On app close, `persistAll()` kills all attach PTYs but leaves tmux sessions running.
5. On next launch, `restoreSessions()` checks `hasTmuxSession()` for each session row. If the tmux session exists, it replays scrollback via `capturePaneFullScrollback()` and reattaches. If not (OS restart), it creates a fresh tmux session.

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

`SessionState` has three values (`idle` | `running` | `awaiting`). **Dead is not a `SessionState`** — it is a boolean flag (`Session.dead`) set in the DB and displayed by `StateIndicator` in the renderer.

| State / flag | Meaning |
|---|---|
| **Idle** | Input prompt (`❯`) visible in the captured pane |
| **Running** | Output is streaming (`esc cancel` pattern detected) |
| **Awaiting** | CLI is waiting for user input (`enter to select` / `enter to confirm` / `Asking user`) |
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
- The polling loop is managed by `SessionManager`, not `PtySession`.

### Jira issue overview
A collapsible Jira pane is displayed to the right of the terminal area for each session. The layout is a `flex` row inside `.session-area` with the terminal taking `flex: 2` and the Jira pane taking `flex: 1`.

**Fetching issues:**
- Enter a Jira issue key (e.g. `PROJ-123`) in the key input and press Enter or click **FETCH**.
- The pane calls `GET {ATLASSIAN_BASE_URL}/rest/api/latest/issue/{key}?fields=summary,description` using a Bearer token.
- Credentials (`ATLASSIAN_PAT` + `ATLASSIAN_BASE_URL`) are resolved by `src/main/jira.ts` in order:
  1. Environment variables (highest priority)
  2. `~/.config/agent-smith/agent-smith/credentials.env`
  3. Error with actionable message if neither source provides both values

**Display order:** SUMMARY → ACCEPTANCE CRITERIA → DESCRIPTION. Acceptance Criteria are extracted from the description by splitting on the first line matching `/acceptance criteri/i`, reading until the next capitalised section header.

**PLAN button:** Sends `"Fetch {key} and implement it\n"` to the active session's PTY.

**Persistence:** The fetched issue is stored as JSON in the `jira_key` / `jira_data` columns of the `sessions` SQLite table (added via migration-safe `ALTER TABLE`). Issues are restored on startup and pre-populated into the `jiraIssues` Map in `App.tsx`.

**Collapse/expand:** A ◀ / ▶ toggle button in the top-left of the pane collapses it to a 28 px-wide strip. Collapse state is global (not per-session) and not persisted. The terminal's `ResizeObserver` automatically calls `fitAddon.fit()` when the pane width changes.

**IPC channels:** `jira:fetchIssue`, `jira:saveIssue`, `jira:clearIssue` — registered in `ipc.ts`, bound in `preload.ts`, typed in `IpcApi` (`types.ts`).

### Workspace management
A **⬡ MANAGE WORKSPACES** button at the bottom of the session sidebar opens a dialog listing all workspaces organised into groups. From this dialog users can:
- **Add** a new workspace by entering a Key, Repo, and Group (workingDir is auto-computed as `/home/rulu/projects/` + Repo).
- **Remove** a workspace with a confirmation prompt. The delete button is disabled while any non-dead session is running for that project key.
- **Add** a new group with the **+ ADD GROUP** button. Empty groups can be removed with the ✕ button on their placeholder row.
- **Reorder workspaces** within and across groups by drag-and-dropping workspace rows.
- **Reorder groups** by drag-and-dropping the group name cell (dragging a group never merges it into another group).

Changes are written back to `projects.json` immediately and the in-memory projects list is refreshed so the New Session dropdown reflects the change without restarting. The dropdown renders one header per group with its workspaces listed beneath.

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
├── SessionManager       SQLite session store + lifecycle + capturePane polling
├── tmux.ts              tmux CLI wrapper (create/kill/capture/query sessions)
├── PtySession(s)        node-pty wrapper for tmux attach-session client
└── IPC handlers         bridges main ↔ renderer via contextBridge

tmux server (independent process)
└── smith-* sessions     each runs copilot CLI; survives app close

Renderer process
├── App.tsx              root state, keyboard shortcuts
├── SessionList          sidebar: new/archive/restore/destroy, project dropdown
│   ├── Active sessions  main list with archive button (✕)
│   └── Archived section collapsible list with restore (↺) and destroy (✕)
├── TerminalPane         xterm.js instance per session (lazy-opened)
├── JiraPane             Jira issue overview + collapse/expand per session
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
Electron → node-pty.spawn('tmux attach-session -t smith-xxx') → PTY data → renderer
                    ↓
           tmux server → copilot process (child of tmux, NOT Electron)
```

**Session lifecycle:**
1. `createSession()` creates a detached tmux session running copilot, then spawns a `tmux attach-session` PTY via node-pty.
2. PTY output is forwarded to the renderer via `pty:data` IPC events; xterm.js buffers it even for hidden panes.
3. On archive (✕ button), the attach PTY is killed but the tmux session keeps running. The session moves to the archived list.
4. On restore (↺ button from archived list), scrollback is replayed from `capturePaneFullScrollback()` and the attach PTY is respawned.
5. On app close, `persistAll()` kills all attach PTYs and stops state polling. tmux sessions survive.
6. On next launch, `restoreSessions()` checks for surviving tmux sessions, replays scrollback, and reattaches. If tmux sessions are gone (OS restart), fresh ones are created.
7. Sessions that were alive when the app closed are marked with `Session.restored = true` (runtime-only flag, not persisted to the DB).

---

## UI

The interface is themed after the Fallout Pip-Boy 3000/3000a terminal aesthetic, inspired by https://www.pip-boy.com/3000a/simulator:
- **Phosphor green** (Pip-Boy 3000) or **amber** (Pip-Boy 3000a) colour scheme
- CRT effects: rolling scanlines, periodic top-to-bottom sweep, centre phosphor bloom
- All text in `Roboto Mono`
- Theme and zoom level are persisted to `localStorage`

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Tab** | Next session |
| **Shift+Tab** | Previous session |
| **Ctrl+n** | New session|
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
Maps project keys to repository names and working directories, organised into named groups. Loaded at runtime via `app.getAppPath()` so it works in both dev and packaged builds.

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
Defined in `src/main/sessions.ts` (`detectStateFromPane()` method). Pattern strings should be confirmed empirically against the installed Copilot CLI version and updated as needed. State is polled from tmux `capture-pane` output every 3 seconds.

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
