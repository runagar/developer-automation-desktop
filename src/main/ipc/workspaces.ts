import { IpcMain } from 'electron';
import { WorkspaceManager } from '../workspaces';
import { SessionManager } from '../sessions';
import { DiscoveredWorkspace } from '../types';
import { discoverWorkspaces } from '../workspaceDiscovery';
import { getDefaultWorkingRoot } from '../settings';

export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  workspaceManager: WorkspaceManager,
  sessionManager: SessionManager,
  dataDir: string,
  pendingDiscovery: {
    peek: () => Promise<DiscoveredWorkspace[]>;
    clear: () => void;
  },
): void {
  ipcMain.handle('workspaces:get', () => workspaceManager.getEntries());
  ipcMain.handle('workspaces:getGroups', () => workspaceManager.getGroups());

  ipcMain.handle('workspaces:add', (_event, opts: { key: string; repo: string; group: string; wdr?: string; createMissingDir?: boolean }) =>
    workspaceManager.addWorkspace(opts)
  );

  ipcMain.handle('workspaces:remove', (_event, key: string) =>
    workspaceManager.removeWorkspace(key)
  );

  // The workspace key is denormalised into `sessions.project`, so a rename has
  // to touch two stores. `workspaces.json` is the source of truth and goes
  // first; sessions pointing at a key that was never written would show a
  // phantom badge *and* defeat the has-active-sessions removal guard.
  ipcMain.handle('workspaces:rename', (_event, oldKey: string, newKey: string) => {
    const result = workspaceManager.renameWorkspace(oldKey, newKey);
    if (!result.renamed || oldKey === newKey) return result;

    try {
      sessionManager.reassignProject(oldKey, newKey);
    } catch (err: any) {
      // Compensate, so the two stores cannot be left disagreeing.
      workspaceManager.renameWorkspace(newKey, oldKey);
      return { renamed: false, error: `Failed to update sessions: ${err?.message ?? 'unknown error'}` };
    }
    return result;
  });

  ipcMain.handle('workspaces:addGroup', (_event, name: string) =>
    workspaceManager.addGroup(name)
  );

  ipcMain.handle('workspaces:removeGroup', (_event, name: string) =>
    workspaceManager.removeGroup(name)
  );

  ipcMain.handle('workspaces:move', (_event, key: string, toGroup: string, toIndex: number) =>
    workspaceManager.moveWorkspace(key, toGroup, toIndex)
  );

  ipcMain.handle('workspaces:reorderGroup', (_event, name: string, toIndex: number) =>
    workspaceManager.reorderGroup(name, toIndex)
  );

  // --- Discovery ---
  // Peek without clearing: a renderer reload between this resolving and the
  // dialogue mounting must not destroy first-launch discovery permanently.
  ipcMain.handle('workspaces:pendingDiscovery', () => pendingDiscovery.peek());

  ipcMain.handle('workspaces:clearPendingDiscovery', () => pendingDiscovery.clear());

  ipcMain.handle('workspaces:discover', () =>
    discoverWorkspaces(getDefaultWorkingRoot(dataDir), workspaceManager.getEntries())
  );

  ipcMain.handle('workspaces:saveDiscovered', (_event, entries: DiscoveredWorkspace[], group: string) =>
    workspaceManager.saveDiscovered(entries, group)
  );
}
