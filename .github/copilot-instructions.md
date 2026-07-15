# Copilot Instructions

Always review `.github/agent-smith.md` before making changes in this project.
Before doing any work, check <available_skills> and invoke a matching skill if one exists.

---

## Project identity

Agent Smith is a single-window Electron desktop app. It is **not** a web app, a CLI tool, or a server. All code runs either in the Electron main process (Node.js) or the renderer process (Chromium + React). There is no backend, no HTTP server, and no database server — persistence is local SQLite via `better-sqlite3`.

---

## Repository layout

```
src/main/          Electron main process (Node.js)
  index.ts         App entry, BrowserWindow setup
  sessions.ts      SessionManager — SQLite + PTY + tmux lifecycle + state polling
  pty.ts           PtySession — node-pty wrapper for tmux attach-session client
  tmux.ts          tmux CLI wrapper (create/kill/capture/query sessions)
  notes.ts         NotesManager — SQLite + filesystem notes storage (panels, tabs, markdown files)
  ipc.ts           IPC handler registration
  types.ts         Shared types (Session, IpcApi, WorkspaceEntry)

src/preload/
  preload.ts       contextBridge — exposes window.agentSmith to renderer

src/renderer/      React renderer process
  index.tsx        Entry point, theme + zoom init
  App.tsx          Root component, session + dashboard wiring, panel focus refs
  components/      One file per component + matching .css
                   (Workspace, WorkspacePanel, PanelMenu, SessionList, TerminalPane, JiraPane, NotesPane, …)
  dashboard/       Panel grid system (framework-agnostic)
    layout.ts            grid math, panel ordering, presets, default layout
    useDashboardLayout.ts  layout state + localStorage persistence + mutators
    usePanelFocus.ts     intra-panel Tab wrapping
  stores/          Zustand state stores (sessionStore, jiraStore, notesStore, layoutStore, …)
  styles/
    global.css     Reset, scrollbar, selection colours
    pipboy.css     All theme variables, CRT effects, shared .btn classes

workspaces.json    Workspace list (key → repo → workingDir), grouped
launch.sh          Dev launcher (initialises fnm, runs npm start)
```

---

## Architecture rules

- **IPC channel names** follow `noun:verb` format (e.g. `sessions:create`, `pty:write`). Add new channels consistently in `ipc.ts` (main handler) and `preload.ts` (renderer binding) and `types.ts` (`IpcApi` interface) together — all three must stay in sync.
- **`window.agentSmith`** is the only way the renderer talks to the main process. Never use `require` or `ipcRenderer` directly in renderer code.
- **`SessionState`** (`idle` | `running` | `awaiting` | `suspended`) lives in `types.ts`. The display-only `dead` state is added in the renderer (`StateIndicator`) and is never stored in the DB.
- **`Session.restored`** is a runtime-only flag set by `SessionManager.restoredIds`. It is not a DB column and must not be persisted.
- **`Session.archived`** is a DB column (`archived INTEGER DEFAULT 0`). Archived sessions have their attach PTY killed but their tmux session kept running.
- **`restoreSessions()`** must only be called after `setWindow()` has been called (triggered by `renderer:ready`). Never call it from `initialize()`.
- **tmux is a hard requirement.** Session creation fails with a descriptive error if tmux is not installed. There is no fallback to direct node-pty spawn.
- **State detection** is done by `capturePane()` polling in `SessionManager` (every 3s), NOT in `PtySession`. `PtySession.setState()` is public so the polling loop can update state via the existing event system.
- **The ✕ button archives** (detaches PTY, keeps tmux alive). Permanent destruction is only available from the archived sessions list.
- **The workspace is a 12×12 panel grid** (`src/renderer/dashboard/`). Panels are absolutely positioned; placements persist to `localStorage` (`agent-smith-dashboard`). Hidden panels stay **mounted** (never unmount terminal/jira bodies — that would dispose xterm buffers). The terminal and jira panels render one component per session internally (active shown).
- **Global panels** (`isGlobal: true`) are session-unbound. Only types in `GLOBAL_CAPABLE_TYPES` (currently: `notes`) support this. Global notes panels are managed via the Panel menu → Notes submenu (create/restore). Use `spawnGlobalPanel()` in `layoutStore` to create them — never use `spawnPanel()` which requires a sessionId.
- **Reattach uses a fresh xterm at the correct size.** On restore/revive, bump the per-session `attachGen` (React key) to mount a clean xterm, fit it, then attach the tmux PTY at that exact `cols`/`rows`. Never manually replay scrollback and never resize after attach — both corrupt tmux's repaint.
- **Panel keyboard nav is focus-gated.** `Ctrl+Tab` cycles panels (handled in `Workspace`); plain `Tab` only works inside the focused panel and is suppressed when focus is outside any panel. There is no global Tab navigation.

---

## Styling conventions

- All CSS custom properties (colours, borders, shadows, fonts) are defined in `pipboy.css` under `:root` (green theme) and `[data-theme="pipboy-3000a"]` (amber theme). **Never hardcode a colour value** in a component stylesheet — always reference a `--c-*` variable.
- CRT effects (`.crt-glow`, `.app-shell::after`, `.app-shell::before`) are defined in `pipboy.css`. Do not duplicate or override them in component files.
- Shared button styles (`.btn`, `.btn--primary`, `.btn--danger`, `.btn--micro`, `.btn--icon`) live in `pipboy.css`. Use them; don't create one-off button styles in component CSS.
- Component CSS files are scoped by BEM-style class prefixes matching the component name (e.g. `.session-list__*`, `.terminal-pane__*`).
- Font is always `Roboto Mono` via the `--font` variable.

---

## Electron / WSLg specifics

- The app runs under **WSLg** (Windows Subsystem for Linux with GUI). Some Electron behaviours differ from native Linux:
  - `in-process-gpu` flag is set to prevent GPU process crashes on WSLg.
  - `mainWindow.setBounds(display.workArea)` must be deferred with `setImmediate` inside the `maximize` event — calling it synchronously crashes.
  - The app window is frameless (`frame: false`); window controls are handled by `TitleBar.tsx` via IPC.
- Native modules (`node-pty`, `better-sqlite3`) must be compiled against the exact Electron version. The `postinstall` script runs `electron-builder install-app-deps` to handle this automatically.

---

## Key behaviours to preserve

- **Tab / Shift+Tab** cycles non-archived sessions (wired in `App.tsx`). Archived sessions are excluded. Do not intercept Tab in any component without `e.stopPropagation()` if the global handler should not fire.
- **Ctrl++ / Ctrl+- / Ctrl+0** controls zoom (wired in `ZoomControl.tsx`).
- **Session archive** (✕ button) requires confirmation via `ConfirmDialog`. Never call `onArchive` directly from a button click.
- **Session destroy** (from archived list) requires confirmation via `ConfirmDialog`. Never call `onDestroy` directly from a button click.
- **xterm.js terminals** are created on mount but only opened into the DOM on first activation (`openedRef`). This is intentional — do not eagerly call `term.open()`.
- PTY data subscriptions in `TerminalPane` intentionally use empty deps arrays (registered once on mount). Do not add `session.id` to those deps — it would leak listeners.
- **NotesPane CodeMirror lifecycle** — each tab switch destroys the old CM editor and creates a new one (content is saved before destroy). The `activeTabId` effect dependency drives this cycle. Do not try to reuse a single EditorView across tabs — doc replacement does not reset CM6 history/extensions properly.
- **Notes content mirroring** uses `notesStore.contentVersion` — a monotonically incrementing counter per scope. When a panel edits content, it sets `isLocalEditRef = true` before updating the store, so its own `useEffect` skips the mirror update. Other panels sharing the same scope detect the version bump and replace their CM doc.

---

## What to check when adding a new feature

1. Does it require a new IPC channel? → update `ipc.ts`, `preload.ts`, `types.ts`.
2. Does it add persistent data? → add a DB column with a migration-safe `ALTER TABLE IF NOT EXISTS` or update the `CREATE TABLE` statement.
3. Does it add UI? → use existing `.btn` / `--c-*` variables; match BEM naming of the nearest component.
4. Does it affect session lifecycle? → verify behaviour on fresh create, restore-from-disk, archive, unarchive, revive-dead, and destroy paths. Remember that destroy is only available from archived sessions. Destroy also cleans up session-bound notes (via `notesManager.destroySessionNotes()`).
5. Does it add a `keydown` listener? → use a ref pattern (not state in deps) to avoid re-registration on every render.
6. Does it interact with tmux? → use functions from `src/main/tmux.ts`. Never call tmux commands directly elsewhere.
7. Does it add a new panel type? → add to `PanelType` union in `layout.ts`, add label in `PANEL_LABELS`, add case in `App.tsx` `renderBody`, create a `*PanelInstance.tsx` wrapper + pane component. If it supports global mode, add to `GLOBAL_CAPABLE_TYPES`.
