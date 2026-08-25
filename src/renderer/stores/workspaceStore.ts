import { create } from 'zustand';
import { DiscoveredWorkspace, WorkspaceGroup } from '../../main/types';

interface WorkspaceStore {
  groups: WorkspaceGroup[];

  loadGroups: () => Promise<void>;
  addWorkspace: (key: string, repo: string, group: string, wdr?: string, createMissingDir?: boolean) => Promise<{ created: boolean; path?: string; error?: string }>;
  removeWorkspace: (key: string) => Promise<void>;
  addGroup: (name: string) => Promise<void>;
  removeGroup: (name: string) => Promise<void>;
  moveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  reorderGroup: (name: string, toIndex: number) => Promise<void>;
  saveDiscovered: (entries: DiscoveredWorkspace[], group: string) => Promise<{ saved: boolean; error?: string }>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => {
  const refresh = async () => {
    const groups = await window.dad.getWorkspaceGroups();
    set({ groups });
  };

  return {
    groups: [],

    loadGroups: refresh,

    addWorkspace: async (key, repo, group, wdr?, createMissingDir?) => {
      const result = await window.dad.addWorkspace({ key, repo, group, wdr, createMissingDir });
      if (result.created) await refresh();
      return result;
    },

    removeWorkspace: async (key) => {
      await window.dad.removeWorkspace(key);
      await refresh();
    },

    addGroup: async (name) => {
      await window.dad.addGroup(name);
      await refresh();
    },

    removeGroup: async (name) => {
      await window.dad.removeGroup(name);
      await refresh();
    },

    moveWorkspace: async (key, toGroup, toIndex) => {
      await window.dad.moveWorkspace(key, toGroup, toIndex);
      await refresh();
    },

    reorderGroup: async (name, toIndex) => {
      await window.dad.reorderGroup(name, toIndex);
      await refresh();
    },

    saveDiscovered: async (entries, group) => {
      const result = await window.dad.saveDiscoveredWorkspaces(entries, group);
      if (result.saved) await refresh();
      return result;
    },
  };
});
