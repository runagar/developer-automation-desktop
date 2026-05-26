# Agent Smith

Agent Smith is a desktop terminal manager for the [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli), built with Electron, React, and TypeScript. It lets you run multiple Copilot CLI sessions side by side in a single window, persists them across restarts, and wraps them in an Atompunk Pip-Boy aesthetic.

---

## Features

### Multi-session management
- Run any number of Copilot CLI sessions simultaneously, each in its own terminal pane.
- Switch between sessions via the sidebar or with **Tab** / **Shift+Tab**.
- Rename any session by clicking its name in the terminal header.
- Destroy a session with confirmation, or revive a dead session without losing its scrollback.

### Session persistence
Each session is assigned a UUID on creation. That UUID is passed to the CLI as `--session-id`, allowing Copilot's server-side conversation history to be resumed. Sessions are stored in a SQLite database and automatically relaunched on next startup. Sessions that died while the app was closed are shown as dead on relaunch rather than silently dropped.

### Session state detection
Each CLI process runs inside a PTY proxy that reads all output in real time and drives a state machine:

| State | Meaning |
|---|---|
| **Idle** | Input prompt visible, no output for 5 seconds |
| **Running** | Output is streaming or a thinking indicator is present |
| **Awaiting** | CLI is waiting for user approval or input |
| **Dead** | Process has exited |

States are shown as coloured indicator pills in the session sidebar.

### Project shortcuts
A dropdown next to the **+ New Session** button lists all configured PFT Beta repositories. Selecting one opens a new session with its working directory pre-set to the corresponding repository on disk.

---

## Technology stack

| Layer | Technology |
|---|---|
| App shell | Electron 33 (WSLg) |
| Renderer | React 18 + TypeScript |
| Bundler | Webpack via `electron-forge` |
| Terminal emulator | xterm.js (`@xterm/xterm`) with FitAddon and WebLinksAddon |
| PTY | `node-pty` |
| Persistence | `better-sqlite3` |

---

## Architecture

```
Main process
├── SessionManager       SQLite session store + lifecycle
├── PtySession(s)        node-pty wrapper + state machine per session
└── IPC handlers         bridges main ↔ renderer via contextBridge

Renderer process
├── App.tsx              root state, keyboard shortcuts
├── SessionList          sidebar: new/destroy/revive, project dropdown
├── TerminalPane         xterm.js instance per session (lazy-opened)
├── StateIndicator       idle / running / awaiting / dead pill
├── ConfirmDialog        modal confirmation for destructive actions
├── TitleBar             frameless window controls
├── ThemeSelector        theme switcher
└── ZoomControl          zoom in/out/reset

Preload
└── preload.ts           exposes window.agentSmith IPC API via contextBridge
```

**Session lifecycle:**
1. `createSession()` inserts a DB row and calls `PtySession.spawn('copilot --session-id <uuid>')`.
2. PTY output is forwarded to the renderer via `pty:data` IPC events; xterm.js buffers it even for hidden panes.
3. On close, `persistAll()` timestamps all live sessions. On next launch, `restoreSessions()` is called after the renderer signals ready, so no PTY events are lost before the window exists.

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
| **Ctrl++** / **Ctrl+=** | Zoom in |
| **Ctrl+-** | Zoom out |
| **Ctrl+0** | Reset zoom |

---

## Configuration

### `projects.json`
Maps PFT Beta project keys to repository names and working directories. Loaded at runtime via `app.getAppPath()` so it works in both dev and packaged builds.

```json
[
  { "key": "NRPCON", "repo": "rs-consent", "workingDir": "/home/rulu/projects/rs-consent" },
  ...
]
```

### State detection patterns
Defined in `src/main/pty.ts`. Pattern strings should be confirmed empirically against the installed Copilot CLI version and updated as needed.

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
