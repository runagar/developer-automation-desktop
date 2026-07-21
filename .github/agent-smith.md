# Developer Automation Desktop (DAD)

Developer Automation Desktop (DAD) is a multi-tool desktop environment for developers, built with Electron, React, and TypeScript. Its first tool tab is **Agent Smith**, a terminal manager for the [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) that lets you run multiple Copilot CLI sessions side by side, persists them across restarts via tmux, and wraps them in an Atompunk Pip-Boy aesthetic.

---

## Features

### Tool tab system
The app supports **tool tabs** — each tab hosts its own tool with its own panel layout. The tab bar sits between the title bar and the workspace area.

- **Tab types** are defined in `TOOL_TABS` (in `layout.ts`). Currently only `agent-smith` exists; the union type `ToolTabId` grows as tools are added.
- Each tab defines which `PanelType`s it can host (`ToolTabDef.panelTypes`).
- **Only one tab is active** at a time. Clicking a tab switches the workspace to that tab's layout.
- Tabs cannot be closed, hidden, or reordered.
- Each tab has its **own layout state** persisted independently to `localStorage` (`dad-dashboard-<tabId>`). The in-memory `tabStates` map holds all tab states; the active tab's state is exposed as `instances` / `locked` in the layout store.
- The **Panel menu** sits in its own bar below the tab bar and is contextual — it only shows panel types allowed by the active tab.
- The **Settings dropdown** sits at the right end of the tab bar (global, not per-tab).

**UI:** `ToolTabBar.tsx` renders the tab row. Active tab text is bright (`--c-bright`); inactive tabs are muted (`--c-dark`). The tab bar has a `2px solid var(--c-bright)` bottom border; the active tab's bottom border matches the background colour to "cut into" the line (classic tab pattern).

### Splash screen
On startup, a full-viewport splash screen displays a DAD joke:
- **First launch** always shows `"Hi Hungry, I'm DAD"` (determined by `firstLaunchComplete` in `settings.json`).
- **Subsequent launches** show a random message from 9 options.
- **Timing:** 1s text fade-in → 3s hold → 1s fade-out (~5s total).
- **Skippable:** any key or mouse press snaps the splash away instantly (no fade-out animation).
- **Theme-aware:** an inline `<script>` in `index.html` reads the saved theme from `localStorage` and sets `data-theme` before first paint, preventing FOUC.
- The splash renders after the native dependency check dialog (if shown).
- `firstLaunchComplete` is set to `true` in `settings.json` only after the splash completes or is skipped.

**Files:** `SplashScreen.tsx` + `SplashScreen.css`, IPC channels `settings:isFirstLaunch` / `settings:markFirstLaunchComplete`.

### Multi-session management
- Run any number of Copilot CLI sessions simultaneously.
- Switch between sessions from the Sessions panel (click, or focus the panel and use **Tab**).
- **Reorder sessions** by dragging them up/down in the list. A floating ghost follows the cursor; a bright line indicates the drop position. Order persists to the DB (`sort_order` column).
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
| `notes` | Markdown editor (`NotesPane`) | Yes | `default`, `linked`, or global |

**Panel modes:**
- **Singleton**: Only one instance exists (Sessions panel). Visibility can be toggled from the Panel menu.
- **Default**: The first panel of each type. Follows the active session — when a new session is activated, the Default panel switches to show that session's content (unless a linked panel of the same type already exists for that session).
- **Linked**: Pinned to a specific session. Created by double-clicking a session or via the context menu. Always shows the same session.
- **Global**: Not bound to any session. Created via the Panel menu → Notes submenu. Only panel types in `GLOBAL_CAPABLE_TYPES` (currently: `notes`) support this mode. Global panels have `isGlobal: true` on their `PanelInstance` and display a globe icon in the header instead of a session name.

**Panel instance data model** (`PanelInstance`):
- `id` — type-prefixed nanoid (e.g. `terminal-a8f3k2`) or `"sessions"` for the singleton.
- `type` — `'sessions' | 'terminal' | 'jira' | 'shell' | 'notes'`
- `placement` — `{ x, y, w, h, visible, z }`
- `mode` — `'singleton' | 'default' | 'linked'`
- `linkedSessionId` — set only when mode is `linked`
- `currentSessionId` — what the panel is currently displaying
- `isGlobal` — `true` for global panels (no session binding); only applicable to `GLOBAL_CAPABLE_TYPES`
- `name` — user-facing name for global notes panels; defaults to `"Untitled"`, persisted in both localStorage and SQLite

**Default panel promotion:** When the Default panel of a type is closed, the first remaining instance of that type (in reading order) is promoted to Default. It loses its session link but keeps its current content.

**Spawning panels:**
- **Double-click** a session in the list → spawns Terminal + Shell + Jira + Notes panels (in that order) for that session. Focus stays on the Sessions panel.
- **Right-click → context menu** on a session → spawn an individual panel type (Terminal/Shell/Jira/Notes). Focus moves to the spawned panel.
- **Panel menu → Notes ▸** submenu → **New** spawns a global (session-unbound) notes panel. Closed global panels can be restored from the same submenu.
- If a linked panel already exists for that session+type, focus moves to the existing panel instead.
- Spawn placement: (1) fills the first empty space ≥ 2×3; (2) splits an existing same-type panel (each half must be ≥ 2×3, checked per-axis — a 2×6 panel can split vertically into two 2×3 panels); (3) overlays at centre 3×3.

**Closing panels:**
- **✕ on a panel** destroys the instance (Sessions panel is hidden instead). Does NOT destroy session resources.
- **Close-expand:** When a panel is closed, if a same-type visible panel can grow into the freed space without overlapping, it expands automatically. Prefers growth in the shortest dimension; tie → horizontal; still tie → reading order.
- **Archiving a session** destroys all linked panels for that session.
- **Restoring a session** activates it in Default panels (no new panels spawned).

**Maximize / Restore:**
- **Double-click** a panel's header or sub-header (`terminal-pane__header`) to maximize/expand. Does not fire when layout is locked.
- If adjacent empty space exists, the panel expands to fill it (never overlapping). Expansion prioritizes the shortest dimension; tie → horizontal.
- If no adjacent empty space exists, the panel goes to full 24×24 (overlay at top z-level). The previous placement is stored in `preMaximizePlacement`.
- Double-clicking a 24×24 maximized panel restores it to its original placement (if no overlap) or finds a fresh spawn placement.
- The maximize/restore transition uses the same 150ms ease-out snap animation as drag/resize.
- Interactive elements in the sub-header (buttons, inputs, rename labels) do NOT trigger maximize on double-click.

- **Drag** a panel by its header to move it. The panel follows the pointer smoothly at pixel level; a dashed shadow outline snaps to the nearest grid position beneath it, previewing the drop target. On release, the panel slides into the grid position with a brief ease-out animation. A 4 px dead zone prevents accidental drags when clicking the header to focus. Pointer events are captured via `setPointerCapture` on the header/handle element (no `window`-level listeners).
- **Resize** from any of 8 edge/corner handles (minimum 2×3 cells). Same smooth-drag + shadow + snap-animation behaviour as move. The panel body stays at its original grid size during the resize drag and reflows only on release.
- **Z-order:** clicking or dragging a panel brings it to the front; panels may overlap.
- **Panel menu** (header, left of Settings): toggle Sessions panel visibility, **Notes** submenu (new/restore global panels), and **Lock layout** toggle.
- **Persistence:** the full layout (panel instances + lock state) is saved to `localStorage` per tab (`dad-dashboard-<tabId>`) and restored on launch. Old 12×12 layouts are automatically discarded and replaced with the 24×24 default.
- Default panels display a small **◆** badge in the header to distinguish them from linked panels.

#### Dashboard keyboard navigation
Two-layer, **focus-gated** model:
- **Ctrl+Tab / Ctrl+Shift+Tab** — cycle focus between visible panel instances in grid reading order (top-left → bottom-right, higher-z wins ties).
- **Tab / Shift+Tab** — cycle focusable elements **within** the focused panel only (wraps at the ends, enforced by the Workspace capture handler scoping to `[data-panel-id]`). In the terminal panel, Tab goes to the PTY (shell autocomplete). When focus is **outside** any panel (e.g. tab bar), plain Tab is suppressed — there is no global Tab navigation.
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
  2. `<dataDir>/credentials.env` (managed via Settings → Jira dialog)
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

**Auto-detect Jira keys:** When enabled (⚡ toggle in the Jira pane header), terminal input is scanned for Jira key patterns. Detected keys trigger a recursive fetch via `jira:fetchAndPopulateVault` (same traversal as the FETCH button — linked issues, parent/epic, epic children) and are written to the vault silently — the Jira pane is NOT updated. Per-session dedup prevents re-fetching. Toggle persisted to `localStorage`.

**Persistence:** The fetched issue is stored as JSON in the `jira_key` / `jira_data` columns of the `sessions` SQLite table (added via migration-safe `ALTER TABLE`). Only the **default** Jira panel's issue is persisted to the DB; linked/spawned panels are transient. Issues are restored on startup. The type includes `__schemaVersion: 3` for the Markdown-description format.

**Per-panel issue state:** The `jiraStore` keys issues by `panelInstanceId` (not `sessionId`). Each Jira panel manages its own issue independently. When the default panel's session changes, it reseeds from `session.jiraData`.

**IPC channels:** `jira:fetchIssue` (single issue), `jira:fetchAndPopulateVault` (recursive + vault), `jira:writeToVault` (vault-only), `jira:readIssue` (vault-read), `jira:getOrFetch` (vault-first + API fallback), `jira:saveIssue`, `jira:clearIssue` — registered in `ipc/jira.ts`, bound in `preload.ts`, typed in `IpcApi` (`types.ts`).

### Notes panel
The Notes panel is a tabbed inline markdown editor using CodeMirror 6. It can be either **session-bound** (created per-session like other panel types) or **global** (not associated with any session, persists independently).

**Scoping:**
- **Session-bound notes** — created via double-click or session context menu. Scope key: `session:<sessionId>`. Notes are destroyed when the session is destroyed.
- **Global notes** — created via Panel menu → Notes ▸ New. Scope key: `global:<panelId>`. Persists independently of sessions. The Panel menu → Notes submenu lists all global panels (open and closed) under "SAVED NOTES"; clicking an open panel focuses it, clicking a closed panel restores it.

**Tabbed interface:**
- Each notes scope contains multiple **tabs** (markdown files). A new scope auto-creates its first tab.
- Tabs can be added (+), closed (×), renamed (click active tab), and restored (↻ dropdown for closed tabs).
- New tabs default to the name "Untitled".
- **Alt+Left / Alt+Right** cycles between tabs within the editor (highest-priority CM keymap).
- Tab state (open/closed/order) is persisted to the `notes_tabs` SQLite table.

**Global panel naming:**
- Global notes panels have a `name` field (defaults to "Untitled") stored in the `notes_panels.name` SQLite column and mirrored on `PanelInstance.name` in localStorage.
- The subheader displays `Notes - {name}`. When the panel is focused, clicking the name makes it inline-editable (auto-selects existing text). Enter or blur saves the new name.
- Renaming persists to both the layout store (localStorage) and the DB (`notes:renamePanel` IPC channel).

**Editor:**
- CodeMirror 6 with `@codemirror/lang-markdown` and `@codemirror/language-data` (fenced code block highlighting).
- Inline markdown syntax highlighting reads theme colours from CSS custom properties (`--c-bright`, `--c-inline-code`, `--c-blockquote`, `--c-md-marker`) at editor creation time.
- Autosave: content is written to disk after 500ms of inactivity (debounced).
- Export (save-as dialog) and copy-file-path actions available via tab context menu.

**Content mirroring:** When multiple panels share the same scope (e.g. two global panels with the same ID, or Default + linked notes panels for the same session), edits in one panel are mirrored to others via the `notesStore` content version counter. The non-editing panel detects version bumps and updates its CM doc.

**Storage:**
- Metadata: `notes_panels` and `notes_tabs` tables in `sessions.db`.
- Content: Markdown files at `<dataDir>/notes/global/<panelId>/<tabId>.md` (global) or `<dataDir>/notes/sessions/<sessionId>/<tabId>.md` (session-bound).
- On session destroy, all session-bound notes (DB rows + files + directory) are removed.

**Panel lifecycle:**
- Closing a global notes panel (✕) marks it as closed in the DB (`notes_panels.closed_at`) and removes the panel instance from the layout. The data is preserved and can be restored.
- Permanently destroying a closed global panel deletes all tabs, files, and the directory.
- Session-bound notes panels follow normal panel destroy behaviour (data lives as long as the session).

**IPC channels:** `notes:createPanel`, `notes:closePanel`, `notes:destroyPanel`, `notes:restorePanel`, `notes:getClosedPanels`, `notes:getAllGlobalPanels`, `notes:renamePanel`, `notes:createTab`, `notes:closeTab`, `notes:restoreTab`, `notes:getClosedTabs`, `notes:renameTab`, `notes:saveContent`, `notes:loadContent`, `notes:getTabs`, `notes:exportTab`, `notes:copyRef` — registered in `ipc/notes.ts`, bound in `preload.ts`, typed in `IpcApi` (`types.ts`).

### Settings dropdown
The **⚙ SETTINGS** dropdown sits at the right end of the tool tab bar (global — not contextual to the active tab). It is organised into two sections:

**Display section:**
- **Zoom** — inline `[−] 100% [+]` controls. Clicking `+`/`−` does not close the dropdown. Clicking the percentage resets to 100% and closes. Global hotkeys (`Ctrl++/−/0`) work regardless of dropdown state.
- **Theme** — click to open a sub-dropdown listing `Phosphor Green` (default) and `Amber Orange`. Sub-dropdown opens to the left if it would overflow the right edge of the screen. Selecting a theme closes the dropdown.
- **CRT Effects** — master toggle for all three CRT effects below. Shows `✓` (all on), `✕` (all off), or `−` (mixed). Clicking applies the most-different toggle (changes the most items); tie → off.
- **Scanlines** — toggle the fine scrolling scanline overlay (`::after` on `.app-shell`).
- **Rolling Scan** — toggle the periodic top-to-bottom sweep effect (`::before` on `.app-shell`).
- **Bloom** — toggle the centre phosphor glow (`.crt-glow` element).

CRT toggle states are persisted to `localStorage` (`dad-scanlines`, `dad-sweep`, `dad-bloom`). Toggle logic lives in `src/renderer/components/crtEffects.ts`; CSS suppression rules are in `pipboy.css` (`.app-shell.no-scanlines::after`, `.app-shell.no-sweep::before`, `.app-shell.no-bloom .crt-glow`).

**Misc section:**
- **Workspaces** — opens the Manage Workspaces dialog.
- **Jira** — opens the Jira Settings dialog (vault path + Atlassian credentials).
- **Notes** — opens the Notes Settings dialog (notes root path).

### Jira settings
Accessible from **Settings → Jira**. A modal dialog with two sections:

**Settings section:** Displays the current Jira vault path (stored in `settings.json` under `jira.vaultPath`). Editable — saved on Enter or SAVE click. Saving triggers a migration: files are copied from the old vault to the new path, settings are updated, then the old vault is deleted. If the target directory already contains data, a confirmation warning is shown before proceeding. On copy failure, only the copied files are rolled back — pre-existing files at the target are never touched.

**Credentials section:** Reuses the shared `CredentialRow` component to manage `ATLASSIAN_PAT` and `ATLASSIAN_BASE_URL`, filtered to the `Atlassian` group only. Same save/clear/validate behaviour as the former standalone Credentials dialog (which has been removed).

**Vault path resolution:** `src/main/vault.ts` reads the vault path from `settings.json` (single source of truth). The `AGENT_SMITH_JIRA_VAULT` env var is no longer checked. Issue files are stored at `<vaultRoot>/<PROJECT>/<KEY>.md` (no intermediate `Jira/` subfolder).

### Notes settings
Accessible from **Settings → Notes**. A modal dialog with one section:

**Settings section:** Displays the current notes root path (stored in `settings.json` under `notes.rootPath`). Editable — saved on Enter or SAVE click. Saving triggers a migration with the same copy-verify-delete pattern as the Jira vault migration, including the non-empty directory confirmation warning.

**Relative paths:** The `notes_tabs.file_path` DB column stores paths relative to the notes root (e.g. `sessions/abc/tab-xyz.md`). At runtime, absolute paths are composited via `NotesManager.resolveTabPath()`. This means changing the notes root only requires moving files + updating `settings.json` — no DB row updates. A one-time migration in `NotesManager.initialize()` converts any legacy absolute paths to relative.

### Credentials (shared component)
The `CredentialRow` component (`src/renderer/components/CredentialRow.tsx`) is extracted as a shared component used by the Jira Settings dialog. It renders a single credential field with edit/save/clear/show-hide controls and status indicators.

**Manifest-driven fields:** Credential fields are defined in `src/main/credentials.ts` as a `CREDENTIAL_FIELDS` array. Each entry specifies `key`, `label`, `group`, `sensitive`, `required`, and optional `placeholder`.

**Current fields:**
| Key | Group | Sensitive | Required |
|---|---|---|---|
| `ATLASSIAN_PAT` | Atlassian | Yes | Yes |
| `ATLASSIAN_BASE_URL` | Atlassian | No | Yes |

**Environment variable precedence:** If a credential is set as a system environment variable, the field is shown as read-only (greyed out) with a "Set via environment variable" note.

**Validation on save:** Credentials are validated before saving (e.g. Atlassian credentials are tested by pinging `/rest/api/latest/myself`). Invalid fields are not saved — inline errors are shown.

**Persistence:** Credentials are stored in `<dataDir>/credentials.env` (plain text, chmod 600). `clearCredentialCache()` in `jira.ts` is called after any save/clear.

**IPC channels:** `credentials:status`, `credentials:save`, `credentials:clear`.

### Workspace management
Accessible from **Settings → Workspaces** in the header dropdown. Opens a dialog listing all workspaces organised into groups. From this dialog users can:
- **Add** a new workspace by entering a Key, Repo, Group, and optional WDR (Working Directory Root override). The working directory is computed as `(WDR || defaultRoot) + '/' + Repo`. If the computed path doesn't exist, a confirmation dialog offers to create the directory.
- **Remove** a workspace with a confirmation prompt. The delete button is disabled while any non-dead session is running for that workspace key.
- **Add** a new group with the **+ ADD GROUP** button. Empty groups can be removed with the ✕ button on their placeholder row.
- **Reorder workspaces** within and across groups by drag-and-dropping workspace rows.
- **Reorder groups** by drag-and-dropping the group name cell.

**Settings section:** Below the add buttons, a "SETTINGS" section contains the **Default Working Directory Root** input. Editable — saved on Enter or ✓ click. Unsaved edits are preserved within the dialog but discarded on close. The add-workspace form always uses the persisted root, not the unsaved draft.

**Configuration:** Workspace groups are stored in `<dataDir>/workspaces.json` (migrated from `projects.json` on first launch). The default working directory root is stored in `<dataDir>/settings.json` under `workspaces.defaultWorkingDirectoryRoot` (auto-detected from `os.homedir() + '/projects'` on first run).

**Naming convention:** All code references use "workspace" terminology (not "project"). Types: `WorkspaceEntry`, `WorkspaceGroup`. IPC channels: `workspaces:*`. Store: `useWorkspaceStore`. Manager: `WorkspaceManager`.

---

## Technology stack

| Layer | Technology |
|---|---|
| App shell | Electron 33 (WSLg) |
| Renderer | React 18 + TypeScript |
| Bundler | Vite via `electron-vite` |
| Packager | `electron-builder` (Linux ZIP) |
| Terminal emulator | xterm.js (`@xterm/xterm`) with FitAddon and WebLinksAddon |
| Markdown editor | CodeMirror 6 (`@codemirror/view`, `@codemirror/lang-markdown`) |
| Icons | Lucide (`lucide-react`) |
| Session host | tmux (hard requirement) |
| PTY | `node-pty` (for tmux attach client only) |
| Persistence | `better-sqlite3` |

---

## Architecture

```
Main process
├── SessionManager       SQLite session store + session lifecycle + panel-instance PTY attachments
├── ShellTmuxManager     tmux-backed shell session management (attach/detach/destroy per panel instance)
├── WorkspaceManager     userData-backed workspace config manager
├── NotesManager         SQLite + filesystem notes storage (panels, tabs, markdown files)
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
│   ├── notesStore.ts    notes scope state, tabs, content mirroring across shared scopes
│   ├── projectStore.ts  projectGroups, CRUD actions
│   └── layoutStore.ts   per-tab PanelInstance[] management, spawn/destroy/promote/switchDefault
├── hooks/
│   └── useXterm.ts      shared xterm creation/fit/theme/addons/keys
├── dashboard/           grid layout system (framework-agnostic)
│   ├── layout.ts        24×24 grid math, PanelInstance types, ToolTab types, spawn placement algorithm
│   └── usePanelFocus.ts intra-panel Tab wrapping (supplemented by Workspace capture handler)
├── ToolTabBar           tool tab row: tab switching + SettingsMenu (global)
├── SplashScreen         startup splash overlay with DAD jokes + first-launch detection
├── Workspace            24×24 grid container: drag/resize, Ctrl+Tab (instance cycling), Tab wrapping, focus tracking
├── WorkspacePanel       panel chrome: drag header, resize handles, close, default badge (◆), error boundary
├── PanelMenu            panel bar dropdown: Sessions toggle + Notes submenu + lock
├── SessionList          sessions panel body: new/archive/restore/destroy
│   ├── Active sessions  main list with archive button (✕), double-click, context menu
│   └── Archived section collapsible list with restore (↺), destroy (✕), destroy-all
├── SessionContextMenu   right-click context menu: New Panel (Terminal/Shell/Jira/Notes) + Rename
├── TerminalPanelInstance per-instance terminal: PTY attach/detach lifecycle, data routing
├── ShellPanelInstance   per-instance shell: shell tmux attach/detach lifecycle, data routing
├── JiraPanelInstance    per-instance Jira: issue display for currentSessionId
├── NotesPanelInstance   per-instance Notes: scope resolution (global vs session-bound)
├── TerminalPane         xterm.js instance (uses useXterm hook)
├── ShellPane            xterm.js instance (uses useXterm hook), tmux-backed
├── JiraPane             Jira issue overview per session
├── NotesPane            CodeMirror 6 markdown editor with tabbed interface
├── PanelErrorBoundary   per-panel error boundary with retry
├── StateIndicator       idle / running / awaiting / dead pill
├── ConfirmDialog        modal confirmation for destructive actions
├── TitleBar             frameless window controls
├── CredentialRow        shared credential field component (used by JiraSettingsDialog)
├── JiraSettingsDialog   Jira vault path + Atlassian credentials
├── NotesSettingsDialog  Notes root path override + migration
├── crtEffects.ts        CRT toggle state (localStorage + CSS class management)
└── ZoomControl          useZoomKeyboard hook + ZoomControls visual component

Preload
└── preload.ts           exposes window.dad IPC API via contextBridge
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

The interface is themed after the Fallout Pip-Boy terminal aesthetic:
- **Phosphor Green** (default, `:root` CSS) or **Amber Orange** (`[data-theme="amber-orange"]`) colour scheme, selectable from Settings → Theme
- CRT effects (individually toggleable from Settings): rolling scanlines, periodic rolling scan sweep, centre phosphor bloom
- All text in `Roboto Mono`
- Theme (`dad-theme`), zoom level (`dad-zoom`), CRT toggle states, and dashboard layout (per-tab) are persisted to `localStorage`

**Colour usage rules:**
- `--c-dim` is for borders and decorative elements only. **Never use `--c-dim` for text colour** — use `--c-mid` as the minimum readable text colour.
- `--c-mid` — secondary/subdued text (labels, placeholders, inactive tabs, metadata).
- `--c-bright` — primary text, active elements, headings.
- Terminal autocomplete suggestions use ANSI `brightBlack` (mapped to `--c-mid`-equivalent values in `xterm-theme.ts`).

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Cycle focus between visible panel instances |
| **Tab** / **Shift+Tab** | Cycle within the focused panel (sessions: select session; terminal: shell tab) |
| **Double-click** (session in list) | Spawn Terminal + Shell + Jira + Notes panels for that session |
| **Right-click** (session in list) | Context menu: New Panel (Terminal/Shell/Jira/Notes), Rename |
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
- **Shift+click+drag** — bypasses mouse tracking and creates a real xterm text selection. Ctrl+C/X copies via Electron's `clipboard` module through synchronous IPC (`clipboard:write` / `clipboard:read` in `ipc/credentials.ts`, bound in `preload.ts`).
- **Shift+Arrow** — keyboard selection, creates an xterm selection via `term.select()`. Same copy mechanism as Shift+click.

OSC 52 clipboard-write sequences from CLI applications are intercepted in the PTY data handler and forwarded to Electron's clipboard API.

---

## Configuration

### `workspaces.json`
Maps workspace keys to repository names and working directories, organised into named groups. On first launch, Agent Smith copies `assets/default-workspaces.json` into `<dataDir>/workspaces.json`; existing `projects.json` files are automatically migrated. Runtime reads and writes use the dataDir copy.

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

### `settings.json`
Application settings stored as grouped JSON. Created on first launch with auto-detected defaults. `loadSettings(dataDir)` merges missing keys from older versions.

```json
{
  "workspaces": {
    "defaultWorkingDirectoryRoot": "/home/rulu/projects"
  },
  "jira": {
    "vaultPath": "/home/rulu/.config/dad/dad/jira-context"
  },
  "notes": {
    "rootPath": "/home/rulu/.config/dad/dad/notes"
  },
  "firstLaunchComplete": true
}
```

### Data directory
Session data is stored at:
```
$XDG_CONFIG_HOME/dad/sessions.db
```
On WSLg this resolves to `~/.config/dad/dad/sessions.db`. The directory is created automatically on first launch.

Notes markdown files are stored at:
```
$XDG_CONFIG_HOME/dad/notes/global/<panelId>/<tabId>.md
$XDG_CONFIG_HOME/dad/notes/sessions/<sessionId>/<tabId>.md
```

### State detection patterns
Defined in `src/main/statePoller.ts` (`detectStateFromPane()` function). Pattern strings should be confirmed empirically against the installed Copilot CLI version and updated as needed. State is polled from tmux `capture-pane` output every 3 seconds.

---

## Prerequisites & Setup

DAD requires the following to run:

| Dependency | Purpose | Install |
|---|---|---|
| **tmux** | Session persistence — copilot runs inside tmux, survives app restarts | `sudo apt-get install tmux` |
| **Node.js** (≥ 20) | Electron + build tooling | Via [fnm](https://github.com/Schniz/fnm) or nvm |
| **build-essential, python3** | Native module compilation (`node-pty`, `better-sqlite3`) | `sudo apt-get install build-essential python3` |
| **@github/copilot** | The Copilot CLI agent that runs inside each session | `npm install -g @github/copilot` |

### Automated setup

Run the included setup script to install everything in one go:

```bash
./setup.sh
```

It is idempotent — safe to re-run at any time.

### Startup dependency check

On launch the app validates that `tmux` and `copilot` are available in PATH. If either is missing, a native warning dialog is shown with install instructions and a pointer to `./setup.sh`. The app window still opens, but sessions cannot be created until the missing dependencies are installed.

---

## Running

```bash
./launch.sh
```

`launch.sh` auto-detects fnm or nvm to ensure Node is on PATH, then runs `npm start` (electron-vite dev).

Development uses `electron-vite dev` with Vite HMR for the renderer and auto-rebuild for the main process. Native modules (`better-sqlite3`, `node-pty`) are externalised and rebuilt via `postinstall`.

To package a distributable:

```bash
npm run package
```

This runs `electron-vite build` followed by `electron-builder` to produce a Linux ZIP.
