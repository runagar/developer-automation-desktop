# Copilot Instructions

Always review `.github/developer-automation-desktop.md` before making changes in this project.
Before doing any work, check <available_skills> and invoke a matching skill if one exists.

---

## Project identity

Developer Automation Desktop (DAD) is a single-window Electron desktop app. It is **not** a web app, a CLI tool, or a server. All code runs either in the Electron main process (Node.js) or the renderer process (Chromium + React). There is no backend, no HTTP server, and no database server — persistence is local SQLite via `better-sqlite3`.

---

## Repository layout

```
src/main/          Electron main process (Node.js)
  index.ts         App entry, BrowserWindow setup
  sessions.ts      SessionManager — SQLite + PTY + tmux lifecycle + state polling
  pty.ts           PtySession — node-pty wrapper for tmux attach-session client
  tmux.ts          tmux CLI wrapper (create/kill/capture/query sessions, exports ANSI_RE)
  statePoller.ts   SessionState polling via tmux capture-pane
  notes.ts         NotesManager — SQLite + filesystem notes storage (panels, tabs, markdown files)
  settings.ts      AppSettings — settings.json read/write + in-memory cache
  jira.ts          Jira REST API client — fetch, graph traversal, epic discovery
  vault.ts         Jira vault — write/read issue notes as markdown files
  credentials.ts   .env file credential management + validation
  migrationUtils.ts  Shared file migration helpers (copyDirRecursive, rollbackCopiedFiles, validatePathWritable)
  shellTmux.ts     ShellTmuxManager — tmux-backed shell panel attachment
  workspaces.ts    WorkspaceManager — workspaces.json CRUD
  ipc.ts           IPC handler orchestrator (delegates to ipc/ modules)
  ipc/             Domain-specific IPC handler modules
    sessions.ts    Session CRUD handlers
    pty.ts         PTY + shell attach/detach/write/resize handlers
    workspaces.ts  Workspace management handlers
    settings.ts    Settings getters/setters + migration handlers
    jira.ts        Jira fetch/vault/issue handlers
    notes.ts       Notes panel/tab CRUD handlers
    window.ts      Window controls + state poller + renderer:ready
    credentials.ts Credential save/clear/status + clipboard handlers
  types.ts         Shared types (Session, IpcApi, WorkspaceEntry)

src/preload/
  preload.ts       contextBridge — exposes window.dad to renderer

src/renderer/      React renderer process
  index.tsx        Entry point, theme + zoom init
  App.tsx          Root component, session + dashboard wiring, panel focus refs
  components/      One file per component + matching .css
                   PanelInstanceWrapper.tsx — generic session-aware panel wrapper (React.memo)
                   *PanelInstance.tsx — per-type wrappers using PanelInstanceWrapper
                   *Pane.tsx — inner pane components (domain logic)
                   (ToolTabBar, SplashScreen, Workspace, WorkspacePanel, PanelMenu, SessionList, …)
  dashboard/       Panel grid system (framework-agnostic)
    layout.ts            grid math, panel ordering, tool tab types, presets, default layout
    usePanelFocus.ts     intra-panel Tab wrapping
  stores/          Zustand state stores (sessionStore, jiraStore, notesStore, layoutStore, workspaceStore)
  hooks/           Custom React hooks (useXterm)
  utils/           Utilities (osc52.ts, cn.ts)
  styles/
    global.css     Reset, scrollbar, selection colours
    pipboy.css     All theme variables, CRT effects, shared .btn classes, shared .dialog-overlay

workspaces.json    Workspace list (key → repo → workingDir), grouped
launch.sh          Dev launcher (initialises fnm, runs npm start)
```

---

## Architecture rules

- **IPC channel names** follow `noun:verb` format (e.g. `sessions:create`, `pty:write`). Add new channels in the appropriate `src/main/ipc/*.ts` domain module, and update `preload.ts` (renderer binding) and `types.ts` (`IpcApi` interface) together — all three must stay in sync.
- **`window.dad`** is the only way the renderer talks to the main process. Never use `require` or `ipcRenderer` directly in renderer code.
- **`SessionState`** (`idle` | `running` | `awaiting` | `suspended`) lives in `types.ts`. The display-only `dead` state is added in the renderer (`StateIndicator`) and is never stored in the DB.
- **`Session.archived`** is a DB column (`archived INTEGER DEFAULT 0`). Archived sessions have their attach PTY killed but their tmux session kept running.
- **`restoreSessions()`** must only be called after `setWindow()` has been called (triggered by `renderer:ready`). Never call it from `initialize()`.
- **tmux is a hard requirement.** Session creation fails with a descriptive error if tmux is not installed. There is no fallback to direct node-pty spawn.
- **State detection** is done by `capturePane()` polling in `StatePoller` (every 3s), NOT in `PtySession`. `PtySession` is a thin tmux-attach wrapper — it only handles spawn, write, resize, kill, and died-detection. All state logic lives in `SessionManager.handleStateChange()`.
- **The ✕ button archives** (detaches PTY, keeps tmux alive). Permanent destruction is only available from the archived sessions list.
- **Tool tabs** are defined in `TOOL_TABS` (`layout.ts`). Each tab has its own `DashboardState` managed by `layoutStore`. The active tab's state is exposed as `instances` / `locked`. Tab switching preserves all tab states in memory and persists each to `localStorage` (`dad-dashboard-<tabId>`).
- **The workspace is a 24×24 panel grid** (`src/renderer/dashboard/`). Panels are absolutely positioned; placements persist to `localStorage` per tab. Hidden panels stay **mounted** (never unmount terminal/jira bodies — that would dispose xterm buffers). The terminal and jira panels render one component per session internally (active shown).
- **Global panels** (`isGlobal: true`) are session-unbound. Only types in `GLOBAL_CAPABLE_TYPES` (currently: `notes`) support this. Global notes panels are managed via the Panel menu → Notes submenu (create/restore/focus). They have a `name` field (default "Untitled") stored in both the `PanelInstance` and the `notes_panels` DB table. Use `spawnGlobalPanel()` in `layoutStore` to create them — never use `spawnPanel()` which requires a sessionId.
- **Maximize** is triggered by double-clicking header or sub-header (detected via pointer-event dead-zone click timing in `Workspace.tsx`, not native `dblclick`). Uses `computeMaxExpansion()` from `layout.ts`. Full-grid panels store `preMaximizePlacement` for restore. Animated via the same snap system as drag/resize.
- **Close-expand**: when a panel is closed, `findCloseExpandCandidate()` in `layout.ts` finds same-type neighbours that can grow into the freed space. Applied inside `destroyPanel()` in `layoutStore`.
- **Reattach uses a fresh xterm at the correct size.** On restore/revive, bump the per-session `attachGen` (React key) to mount a clean xterm, fit it, then attach the tmux PTY at that exact `cols`/`rows`. Never manually replay scrollback and never resize after attach — both corrupt tmux's repaint.
- **Panel keyboard nav is focus-gated.** `Ctrl+Tab` cycles panels (handled in `Workspace`); plain `Tab` wrapping is enforced at the `<section data-panel-id>` level by the Workspace capture handler and is suppressed when focus is outside any panel. There is no global Tab navigation.
- **Splash screen** plays on every app launch. First launch shows "Hi Hungry, I'm DAD" (tracked by `firstLaunchComplete` in `settings.json`). Subsequent launches show random messages. Skippable by any key/click.

---

## Styling conventions

- All CSS custom properties (colours, borders, shadows, fonts) are defined in `pipboy.css` under `:root` (green theme) and `[data-theme="amber-orange"]` (amber theme). **Never hardcode a colour value** in a component stylesheet — always reference a `--c-*` variable.
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

- **Tab / Shift+Tab** cycles focusable elements within the focused panel (wrapping enforced by the Workspace capture handler at the `[data-panel-id]` boundary). Archived sessions are excluded from session cycling. Do not intercept Tab in any component without `e.stopPropagation()` if the panel-level handler should not fire.
- **Ctrl++ / Ctrl+- / Ctrl+0** controls zoom (wired in `ZoomControl.tsx`).
- **Session archive** (✕ button) requires confirmation via `ConfirmDialog`. Never call `onArchive` directly from a button click.
- **Session destroy** (from archived list) requires confirmation via `ConfirmDialog`. Never call `onDestroy` directly from a button click.
- **xterm.js terminals** are created on mount but only opened into the DOM on first activation (`openedRef`). This is intentional — do not eagerly call `term.open()`.
- PTY data subscriptions in `TerminalPane` intentionally use empty deps arrays (registered once on mount). Do not add `session.id` to those deps — it would leak listeners.
- **NotesPane CodeMirror lifecycle** — each tab switch destroys the old CM editor and creates a new one (content is saved before destroy). The `activeTabId` effect dependency drives this cycle. Do not try to reuse a single EditorView across tabs — doc replacement does not reset CM6 history/extensions properly.
- **Notes content mirroring** uses `notesStore.contentVersion` — a monotonically incrementing counter per scope. When a panel edits content, it sets `isLocalEditRef = true` before updating the store, so its own `useEffect` skips the mirror update. Other panels sharing the same scope detect the version bump and replace their CM doc.
- **Default working directory** is refreshed live when changed in Settings → Workspaces (via `dad-settings-changed` custom event). No restart required.

---

## What to check when adding a new feature

1. Does it require a new IPC channel? → add handler in appropriate `src/main/ipc/*.ts` module, update `preload.ts`, `types.ts`.
2. Does it add persistent data? → add a DB column with a migration-safe `ALTER TABLE IF NOT EXISTS` or update the `CREATE TABLE` statement.
3. Does it add UI? → use existing `.btn` / `--c-*` variables; match BEM naming of the nearest component.
4. Does it affect session lifecycle? → verify behaviour on fresh create, restore-from-disk, archive, unarchive, revive-dead, and destroy paths. Remember that destroy is only available from archived sessions. Destroy also cleans up session-bound notes (via `notesManager.destroySessionNotes()`).
5. Does it add a `keydown` listener? → use a ref pattern (not state in deps) to avoid re-registration on every render.
6. Does it interact with tmux? → use functions from `src/main/tmux.ts`. Never call tmux commands directly elsewhere.
7. Does it add a new panel type? → add to `PanelType` union in `layout.ts`, add label in `PANEL_LABELS`, add case in `App.tsx` `renderBody`, create a `*PanelInstance.tsx` wrapper + pane component. If it supports global mode, add to `GLOBAL_CAPABLE_TYPES`.
8. Does it add a new tool tab? → add to `ToolTabId` union and `TOOL_TABS` array in `layout.ts`. Each tab needs a `panelTypes` list. The layout store automatically manages per-tab state.

---

## Development guidelines

These guidelines exist to keep the codebase lean, avoid accidental duplication, and maintain a consistent architecture. Follow them strictly.

### Before writing new code — check for reuse

1. **Search before you create.** Before writing a new function, component, helper, or CSS class, search the codebase for existing implementations:
   - Main process utilities: `src/main/` — check `tmux.ts` (tmux CLI), `migrationUtils.ts` (file copy/rollback), `settings.ts` (settings load/save).
   - Renderer utilities: `src/renderer/utils/` — check `osc52.ts`, `cn.ts` (className concatenation).
   - Shared CSS: `src/renderer/styles/pipboy.css` — check for existing `.btn-*`, `.dialog-overlay`, `--c-*` vars, etc.
   - Store patterns: check if another store already solved the same pattern (e.g. `layoutStore.ts` `updateTab()` helper for tab-persisted mutations).

2. **Reuse existing abstractions:**
   - **Panel instances** → Use `PanelInstanceWrapper` (`components/PanelInstanceWrapper.tsx`). Never re-implement session lookup, empty state, or the standard header (name/project/dir) — that's what the wrapper provides.
   - **Tmux operations** → Use `src/main/tmux.ts` functions. Never call `tmux` CLI directly from other files.
   - **Settings access** → Use the getter/setter functions in `src/main/settings.ts`. They are cached in-memory.
   - **IPC handlers** → Add to the appropriate domain module in `src/main/ipc/*.ts`. Never add handlers outside this directory.
   - **File migrations** → Use `migrationUtils.ts` (`copyDirRecursive`, `rollbackCopiedFiles`, `validatePathWritable`).
   - **ANSI escape stripping** → Use the exported `ANSI_RE` from `src/main/tmux.ts`. Do not define your own regex.
   - **Dialog overlays** → Use `className="dialog-overlay"` from `pipboy.css`. Do not redefine overlay styles.
   - **Class name concatenation** → Use `cn()` from `src/renderer/utils/cn.ts`.

### Component architecture

3. **One component per file, one concern per component.** Each `*.tsx` file exports a single React component. Split complex components into smaller ones via composition, not inheritance.

4. **Panel types follow a strict pattern:**
   - `*Pane.tsx` — The inner pane (TerminalPane, ShellPane, JiraPane, NotesPane). Handles the actual content, interactivity, and domain logic for that panel type. Takes data as props; does not look up sessions directly.
   - `*PanelInstance.tsx` — The outer wrapper. Uses `PanelInstanceWrapper` for session lookup + header + empty state. Handles attach/detach lifecycle, event subscriptions, and passes data down to the `*Pane`. When creating a new panel type, follow this split exactly.

5. **Store selectors must be granular.** Never subscribe to the full `sessions` array when you only need one session. Use `useSessionStore((s) => s.sessions.find(x => x.id === targetId))` or equivalent. The state poll ticks every 3s; broad subscriptions cause unnecessary re-renders.

6. **Do not duplicate store patterns.** The layout store uses `updateTab()` for any mutation that updates instances and persists to the active tab. All new layout actions must use this helper — do not manually call `applyToActiveTab()` + construct + return.

### Main process patterns

7. **IPC handler domain modules.** Each domain (`sessions`, `pty`, `jira`, `notes`, `workspaces`, `settings`, `window`, `credentials`) has its own file in `src/main/ipc/`. New IPC channels go in the appropriate file. If a new domain emerges, create a new file and register it from `ipc.ts`.

8. **Database queries stay in their manager class.** `SessionManager` owns the sessions table; `NotesManager` owns notes tables. Never write raw SQL outside the owning manager.

9. **Credential access is centralized.** Use `resolveCredential()` from `credentials.ts` for reading, `jiraHeaders()` from `jira.ts` for auth headers. Never construct auth headers inline.

10. **Cleanup on session destroy.** When adding per-session state (Maps, caches, listeners), always add cleanup in the destroy path. See `useJiraStore.getState().cleanupSession(id)` in `App.tsx`'s `handleDestroySession` for the pattern.

### CSS conventions

11. **Shared styles live in `pipboy.css`** — buttons, dialog overlays, panel borders, form inputs. Component-specific styles live in the component's own CSS file.

12. **Never duplicate CSS across component files.** If two components need the same style, extract it to `pipboy.css` with a descriptive class name. If the style is purely cosmetic (colour, border, shadow), it must use a `--c-*` CSS variable.

13. **BEM naming** scoped to the component: `.component-name__element--modifier`. The component prefix must match the filename.

### What NOT to do

- **Do not create wrapper components that duplicate `PanelInstanceWrapper` logic** (session lookup, empty state rendering, header). Use the wrapper.
- **Do not define regex constants that already exist elsewhere** (e.g. `ANSI_RE`). Import them.
- **Do not add inline `require()` calls** inside IPC handlers. Use top-level imports.
- **Do not add new `localStorage` keys** without checking if an existing key/pattern already handles the use case. Layout state is managed by `layoutStore`; settings are managed by `settings.ts` on the main process side.
- **Do not add synchronous file I/O in new code** on the main process unless performance is demonstrably acceptable. Prefer async I/O for new file operations.
- **Do not create new migration files** without using the shared utilities in `migrationUtils.ts`.
- **Do not add `console.log` for production logging.** Use descriptive `[module]` prefix format (e.g. `console.log('[tmux] Creating session...')`). Silent catches must have a comment explaining why silence is acceptable.

## GIT

### Commits

- Commit messages should always follow format: `<type>: <summary>`
  - `<type>` should be one of 
    - `fix`: exclusively used for bugfixes
    - `feat`: exclusively used for new features
    - `chore` exclusively used for chore/plumbing/maintenance tasks that don't fall under new features or bugfixes. This type is rare and mostly used by automatic jobs, e.g. releases.
  - `<summary>` should be short (fit within the summary character count if possible), but always accurately describe what was added or changed. 
    - e.g. `fix: do not attach auth token on cross-host redirect` cannot be reduced without destroying (or inverting) the meaning of the summary, and thus all of it should be included in the summary even if it is longer than the usual limit.
  - a `<body>` can be optionally included, mostly only when the summary would otherwise include details not strictly necessary.
    - e.g. Instead of summary `fix: restore idle state detection for copilot 1.0.82`, write summary `fix: restore idle state detection` and body `Copilot CLI 1.0.82 replaced the `❯` prompt with a hint-bar footer.`. 
    - Use your best judgement for when to do this
