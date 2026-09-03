# Developer Automation Desktop (DAD)

Developer Automation Desktop (DAD) is a multi-tool desktop environment for developers, built with Electron, React, and TypeScript. Its first tool tab is **Agent Smith**, a terminal manager for the [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) that lets you run multiple Copilot CLI sessions side by side, persists them across restarts via tmux, and wraps them in an Atompunk Pip-Boy aesthetic.

---

## Features

### Tool tab system
The app supports **tool tabs** — each tab hosts its own tool with its own panel layout. The tab bar sits between the title bar and the workspace area.

- **Tab types** are defined in `TOOL_TABS` (in `layout.ts`). `agent-smith` and `rest-room` exist; the union type `ToolTabId` grows as tools are added.
- Each `ToolTabDef` is the tab's complete definition: `id`, `label`, the `PanelType`s it may host (`panelTypes`), and the layout it boots with (`defaultInstances`). Adding a tab is a one-object change.
- `panelTypes` is **enforced**, not advisory: `spawnPanel` and `spawnGlobalPanel` reject a type the active tab does not allow, `validateState` drops disallowed types on load, and the Panel menu is generated from it.
- **Only one tab is active** at a time. Clicking a tab switches which workspace is visible.
- **A tab mounts the first time it is activated and is never unmounted after.** Inactive-but-mounted tabs are hidden with `.workspace--hidden { display: none }`, so their panels keep their PTYs and xterm buffers across tab switches. `App.tsx` tracks this in a `mountedTabs` set that is only ever added to. Mounting lazily also guarantees a panel's first size measurement happens on a laid-out container — `fitAddon.fit()` is a silent no-op on a `display: none` element and would otherwise leave a terminal at a stale 80×24.
- Tabs cannot be closed, hidden, or reordered.
- Each tab has its **own layout state** persisted independently to `localStorage` (`dad-dashboard-<tabId>`). The layout store holds every tab's state in `tabs: Record<ToolTabId, DashboardState>` at all times, independent of what is mounted. Consumers read it through selectors (`useTabInstances`, `useTabLocked`, `useActiveInstances`, `useActiveLocked`) — there are no top-level `instances` / `locked` fields.
- **The layout blob holds panel geometry and identity only.** It is gated by `validateState`, so a malformed or oversized payload there discards the whole tab's layout. Features that need to persist panel *content* must use their own storage key or `settings.json`.
- Session lifecycle actions (`destroyLinkedPanels`, `switchDefaultPanels`) iterate **every** tab, so archiving a session cannot orphan panels in a tab that is not currently active. Interaction-driven actions (drag, resize, close, maximize) stay scoped to the tab they originate from, because only the visible tab is interactive.
- The **Panel menu** sits in its own bar below the tab bar and is contextual — it is generated from the active tab's `panelTypes`, giving a visibility toggle per singleton plus the Notes submenu when `notes` is allowed.
- The **Settings dropdown** sits at the right end of the tab bar (global, not per-tab).

**UI:** `ToolTabBar.tsx` renders the tab row. Active tab text is `--c-bright`; inactive tabs are `--c-mid` and brighten to `--c-bright` on hover. The tab bar has a `2px solid var(--c-bright)` bottom border; the active tab's bottom border matches the background colour to "cut into" the line (classic tab pattern).

### Rest Room tab
The REST tooling tab. It is session-unbound — it has no Sessions panel and no notion of an active session. It hosts three singleton panels, laid out left-to-right in pipeline order, plus Notes:

| Panel | Type | Default placement | Status |
|---|---|---|---|
| API Picker | `api-picker` | `x0 y0 w6 h24` | Implemented (R2) |
| REST Crafter | `rest-crafter` | `x6 y0 w10 h24` | Implemented (R3) |
| REST Response | `rest-response` | `x16 y0 w8 h24` | Implemented (R4) |

All three are singletons: always present in the tab's default layout, never destroyed. The ✕ button hides them and the Panel menu toggles them back — exactly the Sessions panel model, now generalised over `SINGLETON_TYPES` rather than hardcoded to the string `'sessions'`.

### API Picker panel
The first functional Rest Room panel (R2). It browses the internal API-docs catalogue, drills down service → contract version → operation, and publishes the chosen operation for the REST Crafter (R3) to build a request from.

**Backend.** API-docs is a plain REST API, not a scrapeable SPA. `src/main/apidocs.ts` owns all of it; the renderer never issues a request and never sees a token.

- **Runtime config** — `https://apidocs.nykredit.it/config.json` is public and supplies the API base, OAuth client id, security host and redirect URI. It is fetched once, cached in memory, and falls back to hardcoded values if unreachable, so a platform move needs no DAD release.
- **`Accept` headers are not interchangeable.** `/services` and `/authorizations` are HAL and answer **406** to `application/json`; contracts must be requested with `application/json`, which makes the server transcode YAML to JSON (so DAD needs **no YAML parser**). Service detail additionally carries the official client's `;t=<epoch-ms>` cache-buster.
- **Caching** is in-memory in the main process only — service list for the app's lifetime, contracts in a bounded 20-entry map. Nothing is written to disk. The panel's ⟳ button clears the caches, reloads the current level and re-resolves the selection.
- **HAL links** (`_links.documentation.href`) are preferred over constructed URLs, but only after `safeHref` confirms same host, **same scheme** and a path under the API base — a downgraded link would leak the bearer token in cleartext.

**Contract parsing (`parseOperations`).** Contracts are **Swagger 2.0 or OpenAPI 3.x** — roughly a third of the catalogue is OpenAPI 3 — and accept-versions are encoded as a terminal `#v=N` fragment on the `paths` key (`/consents/{consentId}#v=4`) in **both**, so one endpoint appears as several keys. Everything the two specs disagree about goes through a normalising helper (`specKind`, `contractPrefix`, `resolveLocalRef`, `normalizeParameters`, `operationProduces`, `operationConsumes`, `operationBodySchema`); the rest of the parser is spec-agnostic:
- strips only the anchored `/#v=(\d+)$/`, leaving any other `#` in a path intact;
- iterates a whitelist of HTTP methods, so `parameters` and `$ref` on a path item are not mistaken for operations;
- **merges path-level `parameters`** with the operation's (operation wins on `name`+`in`) — omitting them would drop required parameters from what R3 receives;
- **inherits root-level `produces`/`consumes`** when a Swagger 2.0 operation declares none. OpenAPI 3 has neither: the `produces` equivalent is the union of `responses.<2xx>.content` keys (which do carry `;v=N`), and `consumes` is `requestBody.content`;
- **expands `$ref` parameters before merging.** OpenAPI 3 contracts reference `components/parameters`, and a raw `$ref` entry has neither `name` nor `in`, so merging first would let a path-level and an operation-level reference to the same parameter both survive;
- groups by `METHOD` + real path, sorts variants newest-version-first, and marks a row deprecated **iff its newest variant is**, while each variant keeps its own flag so the version picker can strike through an older deprecated version of a live operation;
- assigns each row its first Swagger `tag` (or `UNTAGGED`) and orders rows by the contract's **declared** tag order, undeclared tags after, `UNTAGGED` last.

**UI.** Three-level drill-down with a breadcrumb, sized for a 6-column panel. Services list is filtered **live** as the user types (no Enter, no search button — the full list is fetched once); Escape in the search box clears it. Matching is all-terms-AND, order-independent, case-insensitive, against the service name only. Only the `default` category is shown — a service published solely under `partner`/`domain` is invisible. Sorting uses `Intl.Collator(numeric: true, sensitivity: 'base')`, since the API's own order is not numeric-aware. Versions appear in three collapsible sections (**Releases open; Pre-releases and Branches collapsed**) — releases and pre-releases share version names, so a selection is only unique as *(service, category, type, name)*. Operations are grouped under collapsible tag headers, all open by default, with a collapse/expand-all toggle beside the operation count. Clicking an operation **or any of its version chips** selects immediately and publishes to the store.

**Path prefix.** Swagger 2.0 uses `basePath`; OpenAPI 3 replaces it with `servers`, which is a list of whole deployment URLs and only sometimes carries a prefix. `contractPrefix` therefore takes **the first `servers[].url` whose pathname is neither empty nor `/`** — reading `servers[0]` blindly would drop the prefix for any service that happens to list `http://localhost:9080` first. Some OpenAPI 3 services are OpenShift/PaaS deployments not reachable through any gateway in the environment table at all; DAD composes a plausible URL and the call simply fails, which is visible before sending.

**Selection.** `restStore` holds navigation and the current selection. Only the **seven-field identity** (`service`, `category`, `type`, `version`, `method`, `path`, `acceptVersion`) is persisted, under `localStorage` key `dad-rest-selection` — never the parsed operation, which would go silently stale when a contract is republished. On startup the contract is re-fetched and the operation re-resolved, with a **three-way** outcome: resolved; cleared if the contract loaded but no longer contains it; or held as `pendingSelection` if the fetch failed (latched, no credentials, off VPN) so a valid selection is never discarded by a transient failure.

**What the Crafter receives** (`RestSelection`): provenance, `method`, `path`, `fullPath` (prefix joined, not concatenated), accept/consumes headers plus the full `produces`/`consumes` lists that drive the dropdowns, merged `parameters` **with the Swagger 2.0 `in: 'body'` entry removed** (the body has its own tab), `requestBodySchema` still unresolved as its raw `$ref`, and `bodySkeleton` — the same schema fully expanded and pretty-printed. `definitions` is served separately by `apidocs:definitions`, which **refetches by contract identity on a cache miss** so the payload stays valid after eviction or a restart, and returns `components.schemas` for OpenAPI 3 contracts.

### REST Crafter panel
The second functional Rest Room panel (R3). It takes the operation published by the API Picker and composes an executable request: environment, URL, headers, parameters and body.

**Body skeleton (`src/main/restSchema.ts`).** Expands a body schema into something editable: all properties (not only `required`), leaves filled `example` → `default` → first `enum` → type placeholder, one sample element per array, `allOf` merged left to right, `oneOf`/`anyOf` taking the first branch. Self-referencing schemas are cut where a `$ref` is already on the expansion stack, backed by a hard depth cap of 12. An operation that **declares no body yields an empty string, not `{}`** — `{}` is itself a body and gets rejected by endpoints documenting none — while a body that is declared but unresolvable still yields `{}` so there is something to type into.

**Environments (`src/main/environments.ts`).** All 24 environments from `helper-scripts/nrp/get_token.sh`, ordered `p0, m0, es1, et1–et4, t0–t15, local`, defaulting to `p0`. `get_base_url.sh` only defines 10 base URLs; the rest are derived from the pattern (`t0` is the one environment whose *security host* breaks it). Every environment uses the **restless** client id `f3bf1c76-…`, which is not api-docs' — client ids are resource-scoped, and a token minted for the wrong one is refused with `403`, never `401`. `local` has no OAuth at all: it sends a fixed Base64 credential, as `Bearer` rather than `Basic`, matching the reference implementation. **There is no production guard** — write operations against `p0` are deliberately unguarded, because authorisation is enforced server-side by the token.

Because `getToken` caches on `securityHost|clientId` and every environment has a distinct security host, "a token per environment, acquired on first use" falls out of the existing cache with no extra machinery.

**Execution (`src/main/rest.ts`).** Deliberately does **not** use `withToken`: that helper throws on every non-2xx and converts `403` into a configuration error, which is right for api-docs and wrong here — a `401`, `403` or `500` from a target API is a legitimate result the user needs to read, so every status is returned verbatim. A `401` is retried exactly once, and only when DAD minted the token itself (`autoAuth`) and the environment uses OAuth. 60 s timeout, `redirect: 'manual'` (a 302 is a result worth seeing), normal TLS verification, no proxy handling. Response bodies are capped at 5 MB with a `truncated` flag. Transport failures are **returned** as `{ ok: false, error }` rather than thrown, so the Response panel has one delivery path. `buildUrl` reuses `joinPath` from `apidocs.ts` so the executed URL is byte-identical to the displayed one. A body is attached for every method **except GET and HEAD**, which `fetch` refuses outright.

**Request composition (`src/renderer/stores/restCraft.ts`).** Pure, unit-tested helpers shared by the URL bar and the send path, so what is shown is what is sent. `headerValues`/`paramValues` hold **only what the user typed**; the rendered value is `userValue ?? contractDefault ?? ''` and the `...` placeholder is an HTML `placeholder`, never a value, so it can never be transmitted. Header rows are ordered Authorization, Accept, Content-Type, contract headers (required first), then custom. `Accept` appears **once** even though contracts also declare it as an explicit header parameter, and is pre-filled from the operation's media type. The wireframe's "Consumes" row is really **`Content-Type`**: shown only for operations that take a body, falling back to `application/json` when the contract declares no `consumes`. Rows with an `enum` (or several `produces`) render as a **combobox — an editable input plus a value list, never a bare `<select>`**, because `Accept` must stay overwritable and any header must be clearable to nothing so it is not sent.

**URL.** Read-only but selectable. The environment base URL renders `--c-mid` and everything from `fullPath` onwards `--c-bright`, as a single inline flow so copying it yields no line break. Path parameters are substituted live and percent-encoded; unfilled ones stay literal `{name}`. Filled query parameters append a live query string. **Unfilled path parameters block the send**; missing query parameters never do, since testing an endpoint without one is legitimate.

**Method.** The send button is labelled with the method it will use and carries a caret dropdown offering `GET, HEAD, POST, PATCH, PUT, OPTIONS, DELETE`. The picked operation supplies the default; an override lets the user probe an endpoint with a verb the contract does not document — a `HEAD` to check existence, an `OPTIONS` to read the allowed set off a 405. The override is **in memory only and reset whenever an operation is picked**, so a `DELETE` chosen for one endpoint can never carry over to another; it is deliberately absent from the request draft for the same reason. `BODYLESS_METHODS` lives in `src/main/restMethods.ts` — a pure module with no `fs`/`path`/`electron` imports, so the renderer imports it directly (the `workspaceKeys.ts` precedent) rather than keeping a second copy of the list.

**Selection changes.** The environment and the bearer token always survive. Typed values survive where the new operation still has a row of the same key, so re-picking an operation at another accept-version keeps its path parameters and drops query parameters that version lacks; `Accept` is **always** re-taken from the new operation. Custom headers and parameters survive only while the **resource** (service + method + path) is unchanged. A hand-edited body survives only when the new `bodySkeleton` is textually identical to the one it was edited against — which is why the draft persists a `bodySkeletonBaseline`, without which a restart would silently overwrite the body it exists to preserve.

**Tokens in the renderer.** R2's rule was that tokens never leave the main process; R3 deliberately relaxes it so the Authorization header can be shown and edited (`rest:token`). The token is still **never written to disk** — it is excluded from the request draft. Editing the field sets `authManual`, which stops an environment change overwriting it; the ↺ button inside the field clears that flag and re-fetches.

**Account safety.** Only one token acquisition is in flight at a time (`tokenRequestInFlight` in `restStore`), and a resolution whose environment is no longer selected is discarded. `getToken`'s latch is keyed by **credentials, not target**, and is checked *before* acquiring, so one rejection already blocks every other environment; the guard exists only to stop simultaneous acquisitions to different security hosts in the same tick. Tokens are acquired on an explicit environment change, on reset, or when the panel is first opened — **never at app startup**, since the Rest Room tab only mounts when the user activates it.

**Draft persistence.** `localStorage` key `dad-rest-draft` holds the environment, header and parameter values, custom rows, body text and skeleton baseline — **never the Authorization value**. Written debounced (300 ms), capped at 256 KB, and validated field-by-field on load; a malformed blob is discarded rather than half-applied. It has its own key because the per-tab layout blob is geometry only.

### REST Response panel
The third functional Rest Room panel (R4). Every executed call gets its own closable tab; JSON bodies render as a collapsible tree, and links inside a response can be followed.

**History.** `restStore.responses` is a `ResponseTab[]` held **in memory only** — responses are deliberately dropped on restart, so there is no storage layer, no SQLite table and no `localStorage` key for them. It is **unbounded**: a tab is removed only when the user closes it. Tabs append right and activate; closing the active tab activates its right-hand neighbour, falling back to the left. Every send opens a new tab rather than replacing one, so two runs of the same request can be compared. Tab titles are the api-path, truncated by CSS (which keeps the readable head) with the full URL as the tooltip.

**Tree model (`src/renderer/stores/responseTree.ts`).** Pure and unit-tested. `buildRows` flattens the parsed body into a visible row list, which is what lets striping follow **visible order** (so it stays correct as nodes open and close) and keeps a future virtualisation a drop-in change. Key points:
- **Row ids are structural** — parent id plus child *index*, never the property name. A key containing `.` or `[` would otherwise collide with a genuinely nested route, toggling unrelated nodes and duplicating React keys; a followed link returns arbitrary JSON from any service, so keys are uncontrolled.
- **Every nested container starts collapsed.** `expanded` is a set of ids, so absence means collapsed and no traversal is needed to set that up.
- **Empty containers are leaves** rendered inline as `[]` / `{}` with no control — a `+` that expands to nothing reads as a bug.
- **A link is any string value that is an absolute `http(s)` URL**, whatever the property is called. This catches the `href` convention (`rs-consent` alone has 36 and no `_links`), HAL `_links.<rel>.href`, and one-offs like `documentUrl` without maintaining a list.

**Body classification.** Driven by `Content-Type` (looked up case-insensitively) plus a parse attempt: JSON under 1 MB becomes a tree; a JSON body that fails `JSON.parse` (proxy HTML, truncation) or exceeds 1 MB falls back to raw text with a notice; XML/Atom/text render raw; `application/pdf` and other binary types show a type-and-size placeholder rather than bytes; an empty body says so. The 1 MB threshold is a **render** limit — R3's 5 MB cap is a transport limit and does nothing to protect the renderer. Media-type matching is on a `json`/`xml` substring, **not** the `+json` convention: the catalogue publishes `application/vnd.nykredit-v2=xml` with an `=`.

**Following a link.** Clicking fires a single `GET` at the absolute URL, opening its tab immediately in a loading state. **There is no way to discover the target's accept-version in one request** — `*/*` and plain `application/json` are both refused by strict services with "missing version information", the 406 names no supported version, `OPTIONS` reveals nothing, and the target service may not be in api-docs at all (`/effective-mortgage-loan` is served by no published service). So DAD does not guess: it tries `application/json;v=1` and always offers **COPY TO CRAFTER**, which loads the link's path, query parameters and headers into the Crafter so the user can set the version themselves. That hand-off fabricates a stand-in selection (the Crafter is otherwise built around a contract-picked operation) and switches to the environment serving that host, warning inline rather than silently retargeting when the host is unknown.

**Expand/collapse-all** applies to the active tab and expands every level, mirroring `ApiPickerPane`'s toggle and icons. It refuses above 10,000 visible rows rather than hanging the renderer — there is no virtualisation. Expansion state is owned by `RestResponsePane` (a map keyed by tab id) rather than by the tree, because the control lives in the pane header; the map entry is dropped when a tab closes.

**Also shown:** a collapsible response-headers section, collapsed by default (`X-Log-Token` is the correlation id used for log lookups across this estate), and a copy button using the existing `window.dad.clipboardWrite`.

### Splash screen
On startup, a full-viewport splash screen displays a DAD joke:
- **First launch** always shows `"Hi Hungry, I'm DAD"` (determined by `firstLaunchComplete` in `settings.json`).
- **Subsequent launches** show a random message from 9 options.
- **Timing:** 1s text fade-in → 3s hold → 1s fade-out (~5s total).
- **Skippable:** any key or mouse press snaps the splash away instantly (no fade-out animation).
- **Theme-aware:** an inline `<script>` in `index.html` reads the saved theme from `localStorage` and sets `data-theme` before first paint, preventing FOUC.
- The splash renders after the native dependency check dialog (if shown).
- `firstLaunchComplete` is set to `true` in `settings.json` only after the splash completes or is skipped. Because of this, anything that needs to know "is this the first launch?" must read the flag in the **main process during `initialize()`** — by the time the renderer is interactive the flag is already consumed. Workspace discovery does exactly this.

**Files:** `SplashScreen.tsx` + `SplashScreen.css`, IPC channels `settings:isFirstLaunch` / `settings:markFirstLaunchComplete`.

### Multi-session management
- Run any number of Copilot CLI sessions simultaneously.
- Switch between sessions from the Sessions panel (click, or focus the panel and use **Tab**).
- **Reorder sessions** by dragging them up/down in the list. A floating ghost follows the cursor; a bright line indicates the drop position. Order persists to the DB (`sort_order` column).
- Rename any session by right-clicking it → **Session** → **Rename**.
- Archive a session to move it to a collapsible archived section. The agent stays loaded (**WARM**) for 30 minutes, then unloads (**COLD**) to free ~350 MB; restoring a cold session resumes the full conversation, just a few seconds slower.
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
- `id` — type-prefixed nanoid (e.g. `terminal-a8f3k2`), or the bare type name for a singleton (`"sessions"`, `"api-picker"`). Identifies a **view** and is unique across all tabs.
- `contentId` — identifies the **domain object the view displays** (e.g. a `notes_panels` row id). Optional; only set for panels opened from a saved-object list. Separating it from `id` is what lets the same global note be open in two tabs at once.
- `type` — `'sessions' | 'terminal' | 'jira' | 'shell' | 'notes' | 'api-picker' | 'rest-crafter' | 'rest-response'`
- `placement` — `{ x, y, w, h, visible, z }`
- `mode` — `'singleton' | 'default' | 'linked'`
- `linkedSessionId` — set only when mode is `linked`
- `currentSessionId` — what the panel is currently displaying
- `isGlobal` — `true` for global panels (no session binding); only applicable to `GLOBAL_CAPABLE_TYPES`
- `name` — user-facing name for global notes panels; defaults to `"Untitled"`, persisted in both localStorage and SQLite

> **`id` vs `contentId`.** Never assume a layout instance id is a database id. `notes_panels.id` is a `contentId`, not an `id` — every notes IPC call (`notesClosePanel`, `notesRenamePanel`, `notesDestroyPanel`, `notesRestorePanel`, and the `{ kind: 'global', id }` scope) takes the `contentId`. Layouts written before this field existed are migrated in `validateState`, which backfills `contentId = id` for global notes panels only, and **never overwrites a `contentId` that is already present** — doing so would silently desync two views of the same note.

**Layout state validation** (`validateState(value, tabId)`) is tab-aware and **repairing** rather than all-or-nothing. It drops instances whose type the target tab does not allow, re-inserts (via `findSpawnPlacement`) any singleton the tab's default layout requires but the persisted state lacks, and preserves/backfills `contentId`. It returns `null` only for a payload that is not the instances schema at all. It must never discard a whole tab's layout because one panel is missing.

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
4. On archive, all PTY attachments for the session are killed; tmux sessions (terminal + shell) survive. The session is **warm**.
5. While warm, a background reaper (driven by the state poller tick) demotes archived sessions to **cold** — killing only `smith-<id>` — once they exceed `ARCHIVE_WARM_MINUTES` (30) or fall outside `ARCHIVE_WARM_MAX` (3). Both constants live in `src/main/archivePolicy.ts`. A session whose state is `running` or `awaiting` is never demoted by the reaper.
6. On app quit, `before-quit` runs cleanup: `evictArchivedSessions()` kills the copilot tmux session of every **archived** session unconditionally (a busy archived session is interrupted rather than leaked past app exit), then `persistAll()` kills all attach PTYs. Active sessions' tmux and all shell tmux sessions (`smith-shell-<id>`) keep running.
7. On next launch, `restoreSessions()` ensures tmux sessions exist for active (non-archived, non-dead) sessions only; PTY attachment is deferred to panel mount.
8. Shell sessions also run in tmux (`smith-shell-*`), with the same lifecycle as terminal sessions — they are never evicted or demoted.

**Warm/cold rules:**
- `archived_at` is a DB column (ISO timestamp, `NULL` for rows archived by older versions — treated as expired). `Session.warm` is **runtime-only**, like `Session.restored`, and is never persisted.
- Warmth is **reconciled against live tmux** (`listSmithSessions()`) at startup and on every reap — never inferred from bookkeeping, since a copilot process can exit on its own or survive a crash. The reconciled set is pushed to the renderer via `sessions:warmthChanged`; the renderer treats a no-op update as a no-op so it can be re-sent every tick.
- All session lifecycle operations (unarchive, revive, destroy, reap, quit-eviction) are serialised per session id through `SessionManager.withSessionLock()`, and re-check eligibility **inside** the lock. Without this the reaper can kill a tmux session that a concurrent restore has just recreated. Any new lifecycle operation must use it.
- `handleUnarchiveSession()` in the renderer must **await the unarchive IPC before** flipping `archived` in the store — a cold session has no tmux yet, so un-archiving first lets the panel attach to a session that does not exist.
- The demotion decision is a pure function, `selectDemotionCandidates()` in `src/main/archivePolicy.ts`, unit tested in `archivePolicy.test.ts`. Keep it free of DB/tmux/Electron dependencies.

Each session UUID is passed to copilot as `--session-id`, allowing Copilot's server-side conversation history to be resumed. Sessions are stored in a SQLite database.

### Session archiving
- The **✕ button** on active sessions archives instead of destroying.
- Archived sessions appear in a collapsible **ARCHIVED SESSIONS** section at the bottom of the sidebar.
- Archived sessions show **WARM** (agent loaded, restores instantly) or **COLD** (agent unloaded, restore takes seconds) instead of a `SessionState`. They are never shown as DEAD — `dead` is meaningless for an archived session.
- Archived sessions are **not polled** for state. The one exception is the reaper's bounded refresh: a warm session still marked `running`/`awaiting` is re-captured so it can eventually be demoted, capped at the warm limit.
- Each archived session has a **Restore** (↺) button and a **Destroy** (✕) button.
- Destroy permanently kills the tmux session and deletes the DB row (with confirmation).
- An archived session keeps its copilot process alive (~350 MB RSS) while it is **warm**. It is demoted to **cold** (copilot tmux killed, shell tmux kept) after 30 minutes, when it falls outside the 3-session warm cap, or when the app quits. Restoring a cold session re-runs `copilot --session-id <uuid>`, which resumes the conversation from `~/.copilot/session-state/` and repaints it — it just takes a few seconds instead of being instant.
- Archived sessions are excluded from **Tab** / **Shift+Tab** cycling.
- The collapse state of the archived section is persisted to `localStorage`.

### Session state detection
State detection uses **tmux `capture-pane` polling** — a single `setInterval` (every 3 seconds) captures the visible pane content from each session's tmux window and scans for known patterns.

`SessionState` has four values (`idle` | `running` | `awaiting` | `suspended`). **Dead is not a `SessionState`** — it is a boolean flag (`Session.dead`) set in the DB and displayed by `StateIndicator` in the renderer.

| State / flag | Meaning |
|---|---|
| **Idle** | Input prompt (`❯`) visible in the captured pane |
| **Running** | Output is streaming (`esc cancel` pattern detected) |
| **Awaiting** | CLI is waiting for user input — a modal dialog or elicitation form is open |
| **Suspended** | Copilot was suspended with Ctrl+Z (`Copilot has been suspended` detected). Resumed via SIGCONT (▶ RESUME button or Alt+R in terminal panel) |
| **Dead** *(flag)* | tmux session of an **active** session has exited; session row has `dead = 1`. Never applies to archived sessions |
| **Warm** *(display)* | Archived, copilot tmux still alive — restores instantly |
| **Cold** *(display)* | Archived, copilot tmux killed — restore re-runs copilot and takes a few seconds |

States are shown as coloured indicator pills in the session sidebar.

**Detection patterns** (defined in `src/main/statePoller.ts`, `detectStateFromPane()`):

Every copilot CLI state is identified by the **hint bar it draws in the bottom rows of the pane**. Matching is therefore restricted to the last `CHROME_LINES` (5) rows — copilot quotes these same strings verbatim in its output and thinking text, so scanning further up produces false positives. `suspended` is the exception: it draws no hint bar, so it is matched against a wider 12-line tail.

| Pattern in chrome region | Transition |
|---|---|
| `Copilot has been suspended` *(12-line tail)* | → `suspended` |
| `enter accept` / `ctrl+d decline` *(elicitation form)* | → `awaiting` |
| `enter to select` / `enter to submit` / `enter to confirm` / `enter to continue` | → `awaiting` |
| `enter select` *(inference approval)* / `enter Allow` *(tool permission)* | → `awaiting` |
| `esc interrupt` *(e.g. `◎ Working · 11.5 KiB esc interrupt`)* | → `running` |
| `/ commands` *(e.g. `← open sidebar · / commands · ? help · tab next tab`)* | → `idle` |

Order matters: `awaiting` is checked first because a modal hides the working/prompt footer, but the reverse is not guaranteed — a visible dialog must always win.

`/ commands` is the only idle hint present in every variant; `? help` is dropped in autopilot mode and `tab next tab` in single-tab sessions. There is deliberately **no `❯` fallback** for pre-1.0.82 CLI builds: the current UI draws `❯` in front of the selected option of a modal, so matching it reported awaiting sessions as idle.

**Key design decisions:**
- Only **active** sessions are polled. `getPollableSessions()` filters `dead = 0 AND archived = 0`, so archived sessions cost no `capture-pane` subprocess and are never marked dead.
- `handleDied()` and `handleStateChange()` additionally guard with `AND archived = 0` and return early when no row changed. This covers a poll cycle already in flight when a session is archived — its stale result must not be applied.
- ~3 second latency on state changes (acceptable since indicators are informational).
- No chunk-tail bridging needed — `capture-pane` returns complete lines.
- The polling loop is managed by `StatePoller`, not `PtySession`. `poll()` holds a re-entrancy guard so a slow cycle cannot overlap the next tick.
- The tick also drives the archived-session reaper via `onReap`, which **must run even when there are no pollable sessions** — otherwise a user whose sessions are all archived would never have them demoted. The poller passes its existing tmux listing to the reaper to avoid a second subprocess.

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
- **Global notes** — created via Panel menu → Notes ▸ New. Scope key: `global:<contentId>`, where `contentId` is the `notes_panels` row id. Persists independently of sessions. The Panel menu → Notes submenu lists all global panels (open and closed) under "SAVED NOTES". Clicking a saved note resolves to one of three outcomes:

  | Open in current tab | Open in another tab | Action |
  |---|---|---|
  | yes | — | bring the existing view to front |
  | no | yes | spawn a **second view** in the current tab, sharing the `contentId` — no DB call, the note is already open |
  | no | no | `notesRestorePanel(contentId)`, then spawn a view |

  Because both views resolve to the same scope key, the existing `notesStore.contentVersion` mirroring keeps them live-synced with no extra work. Renaming one view fans out to every view sharing that `contentId`, across all tabs.

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
- Closing a global notes panel (✕) removes that view from the layout, and marks the note closed in the DB (`notes_panels.closed_at`) **only when it is the last view of that note** — another tab may still be showing it. This check lives in `App.tsx`'s `handleCloseInstance`, not in the generic `Workspace` grid component. The data is preserved and can be restored.
- Deleting a saved note from the Panel menu calls `notesDestroyPanel(contentId)` and then `destroyByContentId(contentId)`, closing every view in every tab.
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

**Root path resolution:** `settings.json` (`notes.rootPath`) is the single source of truth, exactly as it is for the Jira vault. `NotesManager` reads it via `getNotesRootPath(dataDir)` **in its constructor** — never default to `<dataDir>/notes`. `NotesManager.notesRoot` is a runtime mirror of that setting, so **every code path that writes `notes.rootPath` must also call `notesManager.setNotesRoot()`** (currently `migrationNotes.ts` and the `settings:setNotesRoot` IPC handler). Letting the two drift silently writes notes to the wrong directory while Settings still displays the configured path — the failure is invisible until the user notices missing notes.

### Credentials (shared component)
The `CredentialRow` component (`src/renderer/components/CredentialRow.tsx`) is extracted as a shared component used by the Jira Settings dialog. It renders a single credential field with edit/save/clear/show-hide controls and status indicators.

**Manifest-driven fields:** Credential fields are defined in `src/main/credentials.ts` as a `CREDENTIAL_FIELDS` array. Each entry specifies `key`, `label`, `group`, `sensitive`, `required`, and optional `placeholder`.

**Current fields:**
| Key | Group | Sensitive | Required |
|---|---|---|---|
| `ATLASSIAN_PAT` | Atlassian | Yes | Yes |
| `ATLASSIAN_BASE_URL` | Atlassian | No | Yes |
| `NYK_USERNAME` | Nykredit | No | Yes |
| `NYK_PASSWORD` | Nykredit | Yes | Yes |

**The `Nykredit` group is excluded from `credentials:status`.** That channel returns resolved *values*, which is fine for a scoped, revocable Jira PAT but not for the user's actual domain password. `RENDERER_HIDDEN_GROUPS` in `src/main/ipc/credentials.ts` filters the group out, so the password never crosses the IPC boundary; the login dialog works from `auth:status`, which exposes only the username and the password's source. A display-side filter is not sufficient — the value would already have been transferred.

**Environment variable precedence:** If a credential is set as a system environment variable, the field is shown as read-only (greyed out) with a "Set via environment variable" note.

**Validation on save:** Credentials are validated before saving (e.g. Atlassian credentials are tested by pinging `/rest/api/latest/myself`). Invalid fields are not saved — inline errors are shown.

**Persistence:** Credentials are stored in `<dataDir>/credentials.env` (plain text, chmod 600). `clearCredentialCache()` in `jira.ts` is called after any save/clear.

**Value encoding.** A Jira PAT is alphanumeric; a domain password is not. Values are quoted **only when they would not survive a bare round-trip** (leading/trailing whitespace, a newline, a `"` or a `\`), so files written by earlier versions still parse unchanged. `decodeEnvValue` unescapes in a **single left-to-right pass** — chained `replace` calls are wrong, because unescaping `\n` before `\\` turns the encoded form of a literal backslash-then-`n` (as in `c:\new`) into a real newline. That corruption is not cosmetic: the mangled password fails every automatic attempt and latches, while manual login appears to succeed and re-saves it, producing a permanent failure loop.

**File mode.** `writeFileSync`'s `mode` option only applies when *creating* a file, so every write is followed by an explicit `fs.chmodSync(path, 0o600)` — otherwise an existing permissive file keeps its permissions forever.

**IPC channels:** `credentials:status`, `credentials:save`, `credentials:clear`.

### Nykredit authentication (LOGIN)
`src/main/nykAuth.ts` is the shared OAuth2 module for every Nykredit resource; api-docs (R2) and the REST Crafter's 24 environments (R3) both consume it rather than growing a second implementation. It is deliberately generic: `TokenTarget` is `{ securityHost, clientId, redirectUri }`.

**Flow.** `POST https://<securityHost>/security/oauth2/authn` with `response_type=token`, `auth_type=auth.nyk_username` (hardcoded — api-docs' `config.json` advertises `auth.pre_auth`, the interactive SSO path DAD does not use), the resource's client id, and the user's username/password. No embedded browser, no interactive SSO.

**Both success and failure are HTTP 302 — never branch on the status code.** The outcome is only in the redirect fragment: `#access_token=<48 chars>` versus `#error=access_denied`. `redirect: 'manual'` is used so the `location` header is readable, with a body-scrape fallback.

**`403` ≠ `401`.** `401` means no valid token and is retried exactly once after re-acquisition. `403` means the token is valid but was minted for the wrong `client_id` — retrying can never fix it, so it surfaces as `AuthConfigurationError` and is never retried.

**Account-lockout protection.** A domain password expires on rotation, and repeated failed authentications can lock the user's Windows account. Two mechanisms prevent an automatic burst:
- **Single-flight.** One in-flight acquisition per `securityHost|clientId`; concurrent callers await the same promise. Without it the startup attempt and the picker's first fetch could each authenticate in the same tick, neither seeing the other's rejection. Automatic paths (`auth:startup`, `auth:retry`) therefore go through `getToken`; only a **manual** login calls `acquireToken` directly.
- **Rejection latch.** Credentials refused by the server are recorded, and `getToken` then refuses them **without a network call** until a successful manual login clears the set.

The latch lives in `<dataDir>/auth-state.json` at mode `0600` — *not* `settings.json`, which is world-readable. It stores `HMAC-SHA256(installKey, username + '\n' + password)` with a random per-installation key, so the file is not an offline-bruteforceable password verifier. It is a **set**, not a single value: latching credentials A and then failing with B must not make A automatically retryable again. Credentials that merely differ from every stored identifier are *unmatched*, not latched — which is what lets a user who corrects a wrong `NYK_PASSWORD` **environment variable** recover, since env-sourced fields are read-only in the UI.

**Login UI.** `LoginButton.tsx` sits left of the Settings dropdown in the tool tab bar and owns the auth subscription. It **subscribes to `auth:state-changed` before calling `auth:status`** — `renderer:ready` fires before React mounts listeners, so the startup attempt's push would otherwise be dropped. The indicator has **three** states, because a rejected password and an unreachable server need different fixes: `LOGGED IN` (`--c-mid`), `LOGIN FAILED` (`--c-red`, latches), `UNAVAILABLE` (`--c-amber`, does not latch), plus a transient `LOGIN SUCCESSFUL` for 5 s.

`LoginDialog.tsx` is separate from Settings → Jira by design — those credentials are Jira's alone, these are the user's organisation account — though both persist through the same `credentials.env`. It implements its own capture-phase focus trap (INITIALS → PASSWORD → LOGIN, wrapping), because `Workspace`'s window-level Tab handler calls `preventDefault()` whenever focus is outside a `[data-panel-id]`, which includes every dialog. `ManageWorkspacesDialog` uses the same workaround. Password reveal uses Lucide `Eye`/`EyeOff`.

**Verification is two-step** (`auth:login`): acquire the token, then call `GET /authorizations` (365 B, ~100 ms). Acquisition alone would report success for a token api-docs will reject with `403`. Credentials are saved **only after** both steps pass, and a password sourced from the environment is never written to disk.

**Startup** (`auth:startup`) is fired async after `renderer:ready` and never awaited, so an unreachable host cannot stall the first paint. Activating the Rest Room retries **only** when the state is `unavailable` with `reason: 'network'` — never on `login-failed`, and never on a `configuration` 403.

**IPC channels:** `auth:status`, `auth:login`, `auth:retry`, `auth:startup`, `auth:logout`, `auth:state-changed` (push); `apidocs:services`, `apidocs:versions`, `apidocs:operations`, `apidocs:selection`, `apidocs:definitions`, `apidocs:refresh` — registered in `ipc/auth.ts`. The REST Crafter adds `rest:environments`, `rest:token`, `rest:send` in `ipc/rest.ts`; all are bound in `preload.ts` and typed in `IpcApi` (`types.ts`).

### Workspace management
Accessible from **Settings → Workspaces** in the header dropdown. Opens a dialog listing all workspaces organised into groups. From this dialog users can:
- **Add** a new workspace by entering a Key, Repo, Group, and optional WDR (Working Directory Root override). The working directory is computed as `(WDR || defaultRoot) + '/' + Repo`. If the computed path doesn't exist, a confirmation dialog offers to create the directory.
- **Remove** a workspace with a confirmation prompt. The delete button is disabled while any non-dead session is running for that workspace key.
- **Add** a new group with the **+ ADD GROUP** button. Empty groups can be removed with the ✕ button on their placeholder row.
- **Reorder workspaces** within and across groups by drag-and-dropping workspace rows.
- **Reorder groups** by drag-and-dropping the group name cell.

**Settings section:** Below the add buttons, a "SETTINGS" section contains the **Default Working Directory Root** input. Editable — saved on Enter or ✓ click. Unsaved edits are preserved within the dialog but discarded on close. The add-workspace form always uses the persisted root, not the unsaved draft. A **DISCOVER WORKSPACES** button sits directly below the input (see Workspace discovery).

**Workspace keys** must match the format enforced by `src/main/workspaceKeys.ts`: 1–8 characters, `A-Z`, `0-9`, `-` and `_`, with at least one alphanumeric. Inputs normalise as the user types (`normalizeKey`), and `WorkspaceManager.addWorkspace()` enforces `isValidKey()` so the rule holds even when called over IPC. Use the exported `KEY_FORMAT_HINT` in any new error message rather than restating the format.

**Configuration:** Workspace groups are stored in `<dataDir>/workspaces.json` (migrated from `projects.json` on first launch). The default working directory root is stored in `<dataDir>/settings.json` under `workspaces.defaultWorkingDirectoryRoot` (auto-detected from `os.homedir() + '/projects'` on first run). `WorkspaceManager.writeGroups()` writes atomically (tmp file + rename), so a crash mid-write can never truncate the list.

**Naming convention:** All code references use "workspace" terminology (not "project"). Types: `WorkspaceEntry`, `WorkspaceGroup`. IPC channels: `workspaces:*`. Store: `useWorkspaceStore`. Manager: `WorkspaceManager`.

### Workspace discovery
Scans the default working directory root one level deep and offers every directory that is not already a workspace. Implemented by `src/main/workspaceDiscovery.ts` (scan) and `WorkspaceDiscoveryDialog.tsx` (UI).

**Three entry points, one dialog:**
1. **First launch** — the scan runs in `initialize()` while `isFirstLaunch(dataDir)` is still true, because `SplashScreen` flips `firstLaunchComplete` as soon as the splash ends. The renderer therefore cannot evaluate first-launch itself; it fetches the cached result after `splashDone`. The dialog only opens if at least one new workspace was found.
2. **Root changed** — saving a *different* Default Working Directory Root prompts "perform workspace discovery on the new root?".
3. **DISCOVER WORKSPACES button** — always opens the dialog, even with zero results.

**Rules that must be preserved:**
- The first-launch scan promise is cached **unawaited** in `index.ts`. Never `await` it there — an unbounded directory walk would delay window and splash creation.
- `workspaces:pendingDiscovery` **peeks without clearing**. The renderer calls `workspaces:clearPendingDiscovery` only after the user saves or confirms a discard, so a renderer reload cannot destroy first-launch discovery permanently.
- **`saveDiscovered()` is all-or-nothing.** Every `await` happens *before* `readGroups()`, so read → validate → write is synchronous and a concurrent mutation can never be clobbered by a stale snapshot. Preserve this ordering when editing it.
- Discovery only ever **appends**; existing workspaces are never discarded or rewritten.
- Group names match **case-insensitively**, so saving into `Other` when `OTHER` exists reuses the existing group.
- Discovered directories: non-hidden only, symlinks followed when they resolve to a directory, sorted alphabetically, and filtered against existing `workingDir` values (resolved absolute paths).
- Keys are auto-abbreviated (`rs-consent-registry` → `RCR`) and de-duplicated with a numeric suffix (`RCR`, `RCR2`) against both the batch and the saved workspaces.

**IPC channels:** `workspaces:pendingDiscovery` (peek the cached first-launch scan), `workspaces:clearPendingDiscovery`, `workspaces:discover` (scan on demand), `workspaces:saveDiscovered` — registered in `ipc/workspaces.ts`, bound in `preload.ts`, typed in `IpcApi` (`types.ts`).

**Dialog behaviour (differs deliberately from other dialogs):**
- **Backdrop clicks are inert** and **ESC behaves exactly like the ✕ button** — both raise a discard confirmation. Every other dialog in the app closes on ESC and backdrop click.
- While it is open it passes `suspended` to `ManageWorkspacesDialog`, which then ignores both its ESC and its capture-phase Tab handler. Without this the parent would close underneath, and its `stopImmediatePropagation()` would swallow Tab before the child could trap focus. **Any new stacked dialog needs the same treatment.**
- The dialog measures its natural height once on mount and locks it inline, so removing rows doesn't resize the frame under the cursor. The CSS `max-height: 80vh` still clamps it.
- It reuses `ManageWorkspacesDialog.css` (same pattern as `JiraSettingsDialog`/`NotesSettingsDialog` reusing `CredentialsDialog.css`); only genuinely new rules live in `WorkspaceDiscoveryDialog.css`.

**Disabled buttons:** `.btn:disabled` in `pipboy.css` provides the greyed-out state app-wide — don't redefine it per component. A `title` on a disabled button does **not** produce a tooltip (disabled elements swallow mouse events); put the explanatory `title` on a wrapping `<span>` instead.

---

## Technology stack

| Layer | Technology |
|---|---|
| App shell | Electron 33 (WSLg) |
| Renderer | React 18 + TypeScript |
| Bundler | Vite via `electron-vite` |
| Packager | `electron-builder` (Linux `.deb`) |
| Auto-updater | `electron-updater` (checks GitHub Releases) |
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
├── workspaceDiscovery.ts  one-level directory scan for undiscovered workspaces
├── workspaceKeys.ts     pure key abbreviation/normalisation/uniquing (no node imports, unit-tested)
├── NotesManager         SQLite + filesystem notes storage (panels, tabs, markdown files)
├── StatePoller          tmux capture-pane polling + state detection
├── tmux.ts              tmux CLI wrapper (create/kill/capture for both terminal + shell sessions)
├── PtySession           node-pty wrapper for tmux attach-session client
├── nykAuth.ts           shared Nykredit OAuth2: token acquisition, single-flight cache, rejection latch
├── apidocs.ts           API-docs client: runtime config, service/version/contract fetch, Swagger 2.0 + OpenAPI 3.x parsing
├── restSchema.ts        expands a body schema into an editable JSON skeleton ($ref, allOf/oneOf, cycle + depth guard)
├── environments.ts      the 24 REST target environments, restless client id, local Base64 credential
├── rest.ts              request execution: token per environment, 401 retry-once, 5 MB body cap, followed links
├── restMethods.ts       pure HTTP-method rules (BODYLESS_METHODS, sendsBody) shared with the renderer
├── updater.ts           auto-update via electron-updater (checks GitHub Releases, IPC for renderer notification)
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
│   ├── layoutStore.ts   tabs: Record<ToolTabId, DashboardState>; spawn/destroy/promote/switchDefault; contentId lookups
│   ├── restStore.ts     API Picker navigation + REST Crafter state, method override, selection carry-over, draft
│   ├── restCraft.ts     pure request composition: header/parameter rows, path substitution, query string
│   └── responseTree.ts  pure JSON tree flattening + content-type classification for the Response panel
├── hooks/
│   └── useXterm.ts      shared xterm creation/fit/theme/addons/keys (fitAndMeasure returns null when unlaid-out)
├── dashboard/           grid layout system (framework-agnostic)
│   ├── layout.ts        24×24 grid math, PanelInstance types, ToolTabDef (panelTypes + defaultInstances), spawn placement algorithm
│   ├── layout.test.ts   unit tests for tab definitions, defaultState and validateState
│   └── usePanelFocus.ts intra-panel Tab wrapping (supplemented by Workspace capture handler)
├── ToolTabBar           tool tab row: tab switching + LoginButton + SettingsMenu (global)
├── LoginButton          Nykredit auth control: tri-state indicator + login dialog trigger
├── LoginDialog          initials/password entry with its own Tab focus trap
├── SplashScreen         startup splash overlay with DAD jokes + first-launch detection
├── Workspace            24×24 grid container (one per mounted tab): drag/resize, Ctrl+Tab (instance cycling), Tab wrapping, focus tracking
├── WorkspacePanel       panel chrome: drag header, resize handles, close, default badge (◆), error boundary
├── PanelMenu            panel bar dropdown: singleton toggles for the active tab + Notes submenu + lock
├── SessionList          sessions panel body: new/archive/restore/destroy
│   ├── Active sessions  main list with archive button (✕), double-click, context menu
│   └── Archived section collapsible list with restore (↺), destroy (✕), destroy-all
├── SessionContextMenu   right-click context menu: New Panel (Terminal/Shell/Jira/Notes) + Rename
├── TerminalPanelInstance per-instance terminal: PTY attach/detach lifecycle, data routing
├── ShellPanelInstance   per-instance shell: shell tmux attach/detach lifecycle, data routing
├── JiraPanelInstance    per-instance Jira: issue display for currentSessionId
├── NotesPanelInstance   per-instance Notes: scope resolution (global vs session-bound)
├── ApiPickerPanelInstance   session-unbound wrapper for the API Picker; header shows the current selection
├── RestCrafterPanelInstance session-unbound wrapper for the REST Crafter, header shows environment + operation
├── RestResponsePanelInstance session-unbound wrapper for the REST Response panel, header shows the status
├── TerminalPane         xterm.js instance (uses useXterm hook)
├── ShellPane            xterm.js instance (uses useXterm hook), tmux-backed
├── JiraPane             Jira issue overview per session
├── NotesPane            CodeMirror 6 markdown editor with tabbed interface
├── ApiPickerPane        service/version/operation drill-down with live search (R2)
├── RestCrafterPane      URL bar, environment selector, HEADERS/PARAMETERS/BODY tabs, CodeMirror JSON body
├── RestResponsePane     response tabs, status line, collapsible headers, tree or raw body
├── ResponseTree         the flattened JSON tree rows: +/- toggles, striping, clickable links
├── PanelErrorBoundary   per-panel error boundary with retry
├── StateIndicator       idle / running / awaiting / dead pill
├── ConfirmDialog        modal confirmation for destructive actions
├── WorkspaceDiscoveryDialog  first-launch / on-demand workspace discovery (inert backdrop, ESC = ✕)
├── TitleBar             frameless window controls + update indicator
├── UpdateIndicator      inline titlebar notification for available app updates
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
6. On app quit, `before-quit` runs cleanup: archived sessions' copilot tmux is evicted, then `persistAll()` kills all attach PTYs and state polling is stopped. Active sessions' tmux and all shell tmux sessions survive.
7. On next launch, `restoreSessions()` ensures tmux sessions exist for active sessions; PTY attachment is driven by panel instance mount.
8. Sessions that were alive when the app closed are marked with `Session.restored = true` (runtime-only flag, not persisted to the DB).

> **Shutdown cleanup must live on `before-quit`, not `window-all-closed`.** The latter is not emitted when `app.quit()` is called directly (e.g. by the auto-updater's `quitAndInstall()`), which would skip cleanup entirely. The handler calls `event.preventDefault()`, awaits cleanup, then calls `app.quit()` from a `finally` block — guarded by a `cleanupDone` flag for idempotency. Returning a Promise from an Electron event handler does **not** make Electron await it.

> Scrollback is owned by tmux; on reattach the current screen is repainted by tmux into a clean xterm. There is no manual scrollback replay (it collided with the live buffer and tmux's repaint).

---

## UI

The interface is themed after the Fallout Pip-Boy terminal aesthetic:
- **Phosphor Green** (default, `:root` CSS) or **Amber Orange** (`[data-theme="amber-orange"]`) colour scheme, selectable from Settings → Theme
- CRT effects (individually toggleable from Settings): rolling scanlines, periodic rolling scan sweep, centre phosphor bloom
- All text in `Roboto Mono`
- Theme (`dad-theme`), zoom level (`dad-zoom`), CRT toggle states, and dashboard layout (per-tab) are persisted to `localStorage`

**Colour usage rules:**
- `--c-dim` and `--c-dark` are for borders and decorative elements only. **Never use either for text colour** — no text label, however secondary, may be dimmer than `--c-mid`. `--c-mid` is the minimum readable text colour.
- `--c-mid` — secondary/subdued text (labels, placeholders, inactive tabs, metadata). Interactive text at `--c-mid` brightens to `--c-bright` on hover.
- `--c-bright` — primary text, active elements, headings.
- Terminal autocomplete suggestions use ANSI `brightBlack` (mapped to `--c-mid`-equivalent values in `xterm-theme.ts`).

### Menus and the top layer

**Every dropdown, popup or context menu must be raised into the browser's top layer via `useTopLayer` (`components/dropdown/useTopLayer.ts`). A `z-index` will not work.**

`WorkspacePanel` sets `z-index: placement.z` on each `.workspace-panel`, so **every panel is its own stacking context**. A menu rendered inside a panel is clamped to that panel's context and can never out-stack a *sibling* panel — no `z-index` is large enough, because the value is only compared against its siblings inside the panel. The top layer sits above all stacking contexts and all `overflow: hidden` clipping, so it is the only fix that always holds.

The hook is applied automatically by the shared `<Dropdown>` component, so anything built on it is already correct. Menus with bespoke markup must call it directly — `RestCrafterPane`'s local `Menu` component is the example to copy.

Two properties keep it safe to retrofit onto existing menus:
- `popover="manual"` (never `"auto"`) adds no light-dismiss and no Esc handling, so each menu keeps the open/close logic it already had.
- A popover keeps its **position in the DOM** and is only *painted* elsewhere, so `wrapper.contains(event.target)` click-outside checks, event bubbling and inherited `--c-*` theme variables all keep working.

Consequences for the CSS of any menu that opts in:
- Positioning resolves against the viewport, so `top: calc(100% + 4px)` of a container no longer works. Use CSS anchor positioning — `top: calc(anchor(bottom) + 4px)`, `left: anchor(left)`, `min-width: anchor-size(width)`. The hook wires the `anchor-name` to the menu's DOM parent, so that parent must be the intended anchor. Menus positioned at the pointer pass explicit viewport coordinates inline and opt out with `anchorToParent: false`.
- The UA stylesheet styles `[popover]` with `inset: 0`, `margin: auto`, `overflow: auto`, `border`, `padding` and `color: CanvasText`. Reset each one explicitly, or the menu will stretch, lose its theme colour, or clip its own submenus.

Requires Chromium 114+ (Popover API) and 125+ (anchor positioning); Electron 33 ships Chromium 130.

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
Maps workspace keys to repository names and working directories, organised into named groups. On first launch, DAD copies `assets/default-workspaces.json` into `<dataDir>/workspaces.json`; existing `projects.json` files are automatically migrated. Runtime reads and writes use the dataDir copy.

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

Two credential-related files live alongside it, both at mode `0600`:
```
<dataDir>/credentials.env    manifest-driven credential values
<dataDir>/auth-state.json    random install key + HMACs of rejected credentials (never the credentials themselves)
```

Notes markdown files are stored under the configured notes root (`settings.json` → `notes.rootPath`, default `$XDG_CONFIG_HOME/dad/notes`):
```
<notesRoot>/global/<panelId>/<tabId>.md
<notesRoot>/sessions/<sessionId>/<tabId>.md
```

### State detection patterns
Defined in `src/main/statePoller.ts` (`detectStateFromPane()` function). Pattern strings should be confirmed empirically against the installed Copilot CLI version and updated as needed — the CLI has changed its prompt chrome before and will again. State is polled from tmux `capture-pane` output every 3 seconds.

To re-derive the patterns after a CLI upgrade, capture live panes in each state and replay them through the detector:

```bash
tmux capture-pane -p -t smith-<sessionId> | tail -6
```

`src/main/statePoller.test.ts` holds trimmed real captures for each state; update those fixtures rather than inventing synthetic panes.

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

**The renderer dev server is pinned to port 5173 with `strictPort: true`, and must stay that way.** In dev the renderer's origin *is* the dev-server URL, and Chromium partitions `localStorage` per origin. Vite's default is to fall back to the next free port when 5173 is taken, which silently moves the app to a new origin: it then boots against an empty store, and every `localStorage`-backed preference (`dad-theme`, the CRT toggles, `dad-zoom`, `dad-active-tab`, `dad-dashboard-<tabId>`, …) reads as its default, exactly as if settings had been wiped. `strictPort` converts that into a loud `Port 5173 is already in use` and no app launch, which is the correct outcome — a busy port means a dev instance is already running, and a second one would also contend for the same SQLite database and tmux sessions.

If you hit that error, stop the running instance rather than changing the port. Production is unaffected either way: packaged builds `loadFile()` from a stable `file://` origin, which is why this only ever showed up during development. Note that `settings.json`-backed preferences (workspaces, notes root, default working directory, window bounds) live in `userData` and never reset this way — if only theme/effects/layout are gone, the origin changed.

Checks:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # electron-vite build
```

Unit tests use **vitest** and cover pure logic only (e.g. `src/main/archivePolicy.ts`). There is no Electron/DOM test harness — keep testable logic in dependency-free modules rather than reaching for one.

To package a distributable:

```bash
npm run package
```

This runs `electron-vite build` followed by `electron-builder` to produce a `.deb` package in `dist/`.

### Releasing

```bash
npm version patch          # bumps version in package.json, creates git tag
git push --follow-tags     # triggers GitHub Actions CI
```

The `.github/workflows/release.yml` workflow builds the `.deb` and publishes it as a GitHub Release with auto-generated release notes. `electron-updater` reads `latest-linux.yml` from the release to detect new versions.

### Auto-update

On each launch (production only — skipped in dev mode), `electron-updater` checks GitHub Releases for a newer version. If found, it downloads silently in the background. Once downloaded, an `UpdateIndicator` appears in the TitleBar (left of window controls) showing "v{x.y.z} ready" with a **Restart** button. The indicator can be dismissed; it reappears on next launch. If the user never clicks Restart, the update is applied automatically when the app quits (`autoInstallOnAppQuit`).

**Privilege escalation must not go through pkexec alone.** `electron-updater`'s `LinuxUpdater` picks the first of gksudo/kdesudo/pkexec that exists and only falls back to plain `sudo` if none are present. WSLg has pkexec installed (via policykit) but runs **no polkit authentication agent**, so pkexec always exits 127 (`No authentication agent found`) and the update fails. `updater.ts` therefore checks `sudo -n true` first and, when unattended sudo works, installs the `.deb` itself (`sudo -n dpkg -i`, falling back to `sudo -n apt-get install -f -y`) before calling `app.relaunch()`. Only when unattended sudo is unavailable does it delegate to `quitAndInstall()`, which still works on a desktop session with a polkit agent.

Two invariants when touching this path:
- After installing the package ourselves, set `autoUpdater.autoInstallOnAppQuit = false` before quitting. `BaseUpdater`'s quit handler re-checks the flag at quit time, and without this it runs the installer a second time.
- Never treat `apt-get install -f -y` exiting 0 as proof of success — it exits 0 whenever nothing is broken, even if the new package was never unpacked. `installDeb()` confirms via `dpkg-query` that the installed version matches the `.deb`, otherwise the app relaunches into the old version and silently loses the update.

**Update states** (`UpdaterStatus.state`): `downloading` → `ready` → `installing` → (relaunch) or `manual`. `installing` is sent *before* the synchronous `dpkg` call, because that call freezes the main process and a user who thinks the app has hung may kill it mid-install and leave dpkg needing `dpkg --configure -a`. `manual` carries a shell-quoted `sudo dpkg -i '<file>'` command that the indicator offers to copy — it is the fallback whenever no escalation method works, and exists so a failed install can never look like a button that does nothing.

**IPC channels:** `updater:status` (main → renderer, event), `updater:install` (renderer → main, fire-and-forget).

**Files:** `src/main/updater.ts`, `src/renderer/components/UpdateIndicator.tsx` + `.css`, wired into `TitleBar.tsx`.

**Testing the updater** requires a packaged install — it is skipped in dev mode. Build a `.deb` at a version *below* the latest published release (`npm version <ver> --no-git-tag-version` then `npm run package`), install it, launch `/usr/bin/dad` with the dev env vars unset (`env -u ELECTRON_RENDERER_URL …`, otherwise the packaged app loads the Vite dev server and skips the updater entirely), then exercise the Restart button. Restore the `-dev` version afterwards.

**IPC channels:** `updater:status` (main → renderer, event), `updater:install` (renderer → main, fire-and-forget).

**Files:** `src/main/updater.ts`, `src/renderer/components/UpdateIndicator.tsx` + `.css`, wired into `TitleBar.tsx`.
