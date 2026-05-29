# Workspace Groups — Implementation Plan

## Overview
Extend the workspace system with groups/categories. `projects.json` gets a new grouped format. The Manage Workspaces dialog shows a GROUP column with drag-and-drop reordering. The New Session dropdown renders one section header per group.

---

## New `projects.json` format

```json
[
  {
    "group": "PFT BETA PROJECTS",
    "workspaces": [
      { "key": "NRPCON", "repo": "rs-consent", "workingDir": "/home/rulu/projects/rs-consent" },
      ...
    ]
  },
  {
    "group": "PERSONAL PROJECTS",
    "workspaces": [
      { "key": "NRPP", "repo": "rs-rp-prepayment-offer", "workingDir": "/home/rulu/projects/rs-rp-prepayment-offer" }
    ]
  }
]
```

No backwards compat needed — `projects.json` will be rewritten.

---

## Files to Change

### 1. `projects.json`
Rewrite to grouped format. Put all current entries under "PFT BETA PROJECTS" except "AS" (Agent Smith) which goes under "PERSONAL PROJECTS".

### 2. `src/main/types.ts`
- Add `ProjectGroup { group: string; workspaces: ProjectEntry[] }`
- Update `IpcApi`:
  - `getProjects()` stays (returns flat `ProjectEntry[]` — derived by flattening groups)
  - Add `getProjectGroups(): Promise<ProjectGroup[]>`
  - Update `addProject(entry: { key, repo, group })` — group is now required
  - Keep `removeProject(key)`
  - Add `addGroup(name: string): Promise<void>`
  - Add `removeGroup(name: string): Promise<void>` — only succeeds if group is empty
  - Add `moveWorkspace(key: string, toGroup: string, toIndex: number): Promise<void>`

### 3. `src/main/sessions.ts`
- `getProjectGroups()`: reads `projects.json`, returns `ProjectGroup[]`
- `getProjectEntries()`: flattens all groups → `ProjectEntry[]` (existing callers unchanged)
- `addProject(key, repo, group)`: appends to specified group
- `removeProject(key)`: removes from whichever group it's in
- `addGroup(name)`: appends new empty group; throws if name already exists
- `removeGroup(name)`: removes group; throws if group has workspaces
- `moveWorkspace(key, toGroup, toIndex)`: moves workspace between/within groups

### 4. `src/main/ipc.ts`
Register: `projects:getGroups`, `projects:addGroup`, `projects:removeGroup`, `projects:move`
Update `projects:add` handler to pass `entry.group`

### 5. `src/preload/preload.ts`
Bind all new channels.

### 6. `src/renderer/App.tsx`
- Add `projectGroups: ProjectGroup[]` state (loaded via `getProjectGroups()`)
- Refresh `projectGroups` after every add/remove/move
- Pass `projectGroups` to `SessionList` in place of `projects`
- Update `handleAddProject(key, repo, group)` to pass group

### 7. `src/renderer/components/SessionList.tsx`
- Change prop `projects: ProjectEntry[]` → `projectGroups: ProjectGroup[]`
- Derive flat list locally when needed (`projectGroups.flatMap(g => g.workspaces)`)
- Update dropdown: render one `dropdown__header` per group, workspace items under it
- Pass `projectGroups` down to `ManageWorkspacesDialog`

### 8. `src/renderer/components/ManageWorkspacesDialog.tsx`
Full rewrite of the table. New layout:

**Table columns:** GROUP | KEY | REPO | DIR | (actions)

**Rendering:**
- Iterate groups; for each group render its workspace rows
- GROUP cell: show group name only on the first workspace row of that group, blank for the rest
- A small `✕` next to the group name (only active when group has no workspaces)
- Workspace rows are `draggable`; drag handle cursor on the row

**Drag and drop (HTML5 native DnD — no library):**
- `onDragStart` on workspace row: store `draggedKey` in state
- `onDragOver` on workspace row: set `dropTargetKey`; `preventDefault()` to allow drop
- `onDragOver` on group header cell: set `dropTargetGroup`; `preventDefault()`
- `onDrop` on workspace row: call `onMove(draggedKey, targetGroup, targetIndex)`
- `onDrop` on group header cell: call `onMove(draggedKey, groupName, groupLength)` (append)
- Visual indicator: highlight the drop target row/group with a top border or background

**Footer:**
```
[ + ADD GROUP ]   [ + ADD WORKSPACE ]
```
- "+ ADD GROUP" → shows inline name input, Enter/button confirms
- "+ ADD WORKSPACE" → shows key + repo + group-selector inputs (same as before but with group dropdown)

### 9. `src/renderer/components/ManageWorkspacesDialog.css`
Add drag-and-drop visual styles, group header cell styles, footer two-button layout.

---

## New IPC Channels

| Channel | Args | Returns |
|---|---|---|
| `projects:getGroups` | — | `ProjectGroup[]` |
| `projects:addGroup` | `name: string` | `void` |
| `projects:removeGroup` | `name: string` | `void` |
| `projects:move` | `{ key, toGroup, toIndex }` | `void` |
| `projects:add` (updated) | `{ key, repo, group }` | `ProjectEntry` |

---

## Mockup Observations
- Group name shown only for first row of that group (GROUP cell blank for subsequent rows)
- ✕ buttons on workspace rows (red = active session, dimmer = no active session — same as current)
- "+ ADD GROUP" and "+ ADD WORKSPACE" side by side in footer
- Dragging workspace rows between groups

---

## Remove Group
- Only allowed when the group has no workspaces
- Small ✕ button appears inline next to the group name in the GROUP cell
- No confirmation dialog needed (group is empty)

