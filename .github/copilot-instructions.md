# Copilot Instructions

Always review `.github/agent-smith.md` before making changes in this project.

---

## Project identity

Agent Smith is a single-window Electron desktop app. It is **not** a web app, a CLI tool, or a server. All code runs either in the Electron main process (Node.js) or the renderer process (Chromium + React). There is no backend, no HTTP server, and no database server — persistence is local SQLite via `better-sqlite3`.

---

## Repository layout

```
src/main/          Electron main process (Node.js)
  index.ts         App entry, BrowserWindow setup
  sessions.ts      SessionManager — SQLite + PTY lifecycle
  pty.ts           PtySession — node-pty wrapper + state machine
  ipc.ts           IPC handler registration
  types.ts         Shared types (Session, IpcApi, ProjectEntry)

src/preload/
  preload.ts       contextBridge — exposes window.agentSmith to renderer

src/renderer/      React renderer process
  index.tsx        Entry point, theme + zoom init
  App.tsx          Root component, global keyboard shortcuts
  components/      One file per component + matching .css
  styles/
    global.css     Reset, scrollbar, selection colours
    pipboy.css     All theme variables, CRT effects, shared .btn classes

projects.json      PFT Beta project list (key → repo → workingDir)
launch.sh          Dev launcher (initialises fnm, starts electron-forge)
```

---

## Architecture rules

- **IPC channel names** follow `noun:verb` format (e.g. `sessions:create`, `pty:write`). Add new channels consistently in `ipc.ts` (main handler) and `preload.ts` (renderer binding) and `types.ts` (`IpcApi` interface) together — all three must stay in sync.
- **`window.agentSmith`** is the only way the renderer talks to the main process. Never use `require` or `ipcRenderer` directly in renderer code.
- **`SessionState`** (`idle` | `running` | `awaiting`) lives in `types.ts`. The display-only `dead` state is added in the renderer (`StateIndicator`) and is never stored in the DB.
- **`Session.restored`** is a runtime-only flag set by `SessionManager.restoredIds`. It is not a DB column and must not be persisted.
- **`restoreSessions()`** must only be called after `setWindow()` has been called (triggered by `renderer:ready`). Never call it from `initialize()`.

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
- Native modules (`node-pty`, `better-sqlite3`) must be compiled against the exact Electron version. `launch.sh` handles this via `electron-forge start` which uses `@electron-forge/plugin-webpack` with native module rebuild support.

---

## Key behaviours to preserve

- **Tab / Shift+Tab** cycles sessions (wired in `App.tsx`). Do not intercept Tab in any component without `e.stopPropagation()` if the global handler should not fire.
- **Ctrl++ / Ctrl+- / Ctrl+0** controls zoom (wired in `ZoomControl.tsx`).
- **Session destroy** requires confirmation via `ConfirmDialog`. Never call `onDestroy` directly from a button click.
- **xterm.js terminals** are created on mount but only opened into the DOM on first activation (`openedRef`). This is intentional — do not eagerly call `term.open()`.
- PTY data subscriptions in `TerminalPane` intentionally use empty deps arrays (registered once on mount). Do not add `session.id` to those deps — it would leak listeners.

---

## What to check when adding a new feature

1. Does it require a new IPC channel? → update `ipc.ts`, `preload.ts`, `types.ts`.
2. Does it add persistent data? → add a DB column with a migration-safe `ALTER TABLE IF NOT EXISTS` or update the `CREATE TABLE` statement.
3. Does it add UI? → use existing `.btn` / `--c-*` variables; match BEM naming of the nearest component.
4. Does it affect session lifecycle? → verify behaviour on fresh create, restore-from-disk, revive-dead, and destroy paths.
5. Does it add a `keydown` listener? → use a ref pattern (not state in deps) to avoid re-registration on every render.
