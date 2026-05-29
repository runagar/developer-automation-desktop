# Session Workspace Handling — Implementation Plan

## Overview
Add a "Manage Workspaces" dialog that lets users view, add, and delete workspace entries in `projects.json` without editing the file manually.

---

## Feature Summary (from feature-request.md)

- **Button**: A "Manage Workspaces" button (in the session list sidebar, below the new-session area).
- **Dialog**: Opens a full-width overlay listing all current workspaces (key → repo → workingDir).
- **Add**: A "+" button inside the dialog reveals an inline form. User enters Key and Repo; workingDir is auto-computed as `/home/rulu/projects/` + Repo. Clicking "Add" or pressing Enter saves it.
- **Delete**: An "✕" button on each workspace row. Disabled if any active (non-dead) CLI session is running for that project key. Clicking shows a confirmation dialog before deleting.

---

## Files to Change / Create

### 1. `src/main/types.ts`
Add two new methods to `IpcApi`:
```ts
addProject: (entry: { key: string; repo: string }) => Promise<ProjectEntry>;
removeProject: (key: string) => Promise<void>;
```

### 2. `src/main/sessions.ts`
Add two new public methods:

**`addProject(key, repo)`**
- Reads `projects.json`
- Validates key uniqueness (throws if duplicate)
- Appends `{ key, repo, workingDir: "/home/rulu/projects/" + repo }`
- Writes back to `projects.json`
- Returns the new `ProjectEntry`

**`removeProject(key)`**
- Reads `projects.json`
- Filters out the entry with matching key
- Writes back to `projects.json`

### 3. `src/main/ipc.ts`
Register two new IPC handlers:
- `projects:add` → `sessionManager.addProject(key, repo)`
- `projects:remove` → `sessionManager.removeProject(key)`

### 4. `src/preload/preload.ts`
Add two new bindings in the `api` object:
- `addProject: (entry) => ipcRenderer.invoke('projects:add', entry)`
- `removeProject: (key) => ipcRenderer.invoke('projects:remove', key)`

### 5. `src/renderer/components/ManageWorkspacesDialog.tsx` *(new file)*
A modal dialog component:
- Props: `projects: ProjectEntry[]`, `sessions: Session[]`, `onAdd`, `onRemove`, `onClose`
- Renders a full-screen overlay (similar to `ConfirmDialog`)
- Lists all workspaces in a table-like layout (key / repo / workingDir columns)
- Each row has an "✕" delete button (disabled if a non-dead session uses that project key)
- Clicking "✕" shows an inline `ConfirmDialog` for that workspace
- Has a "+" button at the bottom of the list to toggle the add form
- Add form has Key and Repo inputs; 
  - Hitting Enter on Key fields moved focus to Repo field
  - Hitting Enter on Repo field or clicking "ADD" button submits
- Escape key closes the dialog
- "X" / close button in the dialog header

### 6. `src/renderer/components/ManageWorkspacesDialog.css` *(new file)*
Scoped styles using `.manage-workspaces__*` BEM prefix. Uses `--c-*` variables only.

### 7. `src/renderer/components/SessionList.tsx`
- Accept two new props: `onManageWorkspaces: () => void` and wires up the "Manage Workspaces" button
- Alternatively: manage dialog open state inside `SessionList` itself (simpler — no new prop needed)

**Decision**: Keep dialog state local to `SessionList`. The dialog needs `sessions`, `projects`, and callbacks. `SessionList` already receives all of these. Add `onAddProject` and `onRemoveProject` props, or handle IPC directly inside `SessionList`.

**Decision**: Call `window.agentSmith` IPC directly from `ManageWorkspacesDialog` and refresh via a callback (`onProjectsChanged: () => void`). This keeps `App.tsx` decoupled.

Actually, looking at the pattern — `App.tsx` loads `projects` from IPC and passes them down. I'll add `onAddProject` and `onRemoveProject` callbacks to `SessionList` props and handle them in `App.tsx` — consistent with how `onCreate`/`onDestroy` work.

---

## Component Architecture

```
App.tsx
 ├── projects state  (reloaded after add/remove)
 ├── SessionList
 │    ├── ManageWorkspacesDialog  (rendered when open)
 │    │    └── ConfirmDialog      (when deleting a workspace)
 │    └── (existing dropdown)
```

**Props flow**:
- `SessionList` gets new prop `onManageWorkspaces` is NOT needed — dialog is managed inside `SessionList` with `useState`.
- `SessionList` gets two new props: `onAddProject(key, repo)` and `onRemoveProject(key)` which are async calls defined in `App.tsx` that call IPC and then refresh `projects`.

---

## IPC Channels (new)

| Channel | Direction | Args | Return |
|---|---|---|---|
| `projects:add` | renderer → main | `{ key, repo }` | `ProjectEntry` |
| `projects:remove` | renderer → main | `key: string` | `void` |

---

## Behaviour Details

### Add workspace
1. User clicks "+" in dialog → inline form appears below the list
2. User types Key and Repo
3. Pressing Enter or clicking "ADD" → calls `onAddProject(key, repo)` → IPC → `sessions.ts` → write `projects.json` → return new entry → `App.tsx` refreshes projects list
4. Form clears and hides
5. Error state: if key already exists, show inline error message

### Delete workspace
1. User clicks "✕" on a row
2. `ConfirmDialog` appears: "Remove workspace {key}?" + detail "This will remove the workspace from projects.json. Existing sessions will not be affected."
3. On confirm → calls `onRemoveProject(key)` → IPC → write `projects.json` → `App.tsx` refreshes

### Disabled delete button
- A workspace's delete button is disabled if `sessions.some(s => s.project === key && !s.dead)`
- Tooltip: "Cannot remove — has active session(s)"

---

## Ambiguities

1. **Where to put the "Manage Workspaces" button?** — Put the button at the bottom of the sessions list.

2. **workingDir base path is hardcoded as `/home/rulu/projects/`** — The feature request explicitly states this. The `DEFAULT_WORK_DIR` constant in `SessionList.tsx` is also `/home/rulu/projects`. This is consistent.

3. **Should duplicate keys be silently rejected or show an error?** — Show a validation error in the form. Don't close the window when this error occurs.

4. **After adding a workspace, should the dropdown also reflect the change?** — Yes, because `App.tsx` reloads the projects list and passes it down to `SessionList` and `ManageWorkspacesDialog`.

5. **Should the dialog itself re-read projects, or rely on the parent's `projects` prop?** — It will use the `projects` prop passed from `SessionList` (which comes from `App.tsx`). `App.tsx` re-fetches projects via `getProjects()` after every add/remove.

---

## Styling Notes
- Dialog is a full-screen overlay (same as `ConfirmDialog`) but with a wider inner panel
- Uses existing `.btn`, `.btn--danger`, `.btn--micro` classes
- Table layout: 3 columns (key, repo, workingDir) + action column
- Uses `--c-*` variables, `--panel-border`, `--glow`
