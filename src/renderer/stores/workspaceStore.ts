import { create } from 'zustand';
import { WorkspaceGroup } from '../../main/types';

interface WorkspaceStore {
  groups: WorkspaceGroup[];

  loadGroups: () => Promise<void>;
  addWorkspace: (key: string, repo: string, group: string, wdr?: string, createMissingDir?: boolean) => Promise<{ created: boolean; path?: string; error?: string }>;
  removeWorkspace: (key: string) => Promise<void>;
  addGroup: (name: string) => Promise<void>;
  removeGroup: (name: string) => Promise<void>;
  moveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  reorderGroup: (name: string, toIndex: number) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => {
  const refresh = async () => {
    const groups = await window.agentSmith.getWorkspaceGroups();
    set({ groups });
  };

  return {
    groups: [],

    loadGroups: refresh,

    addWorkspace: async (key, repo, group, wdr?, createMissingDir?) => {
      const result = await window.agentSmith.addWorkspace({ key, repo, group, wdr, createMissingDir });
      if (result.created) await refresh();
      return result;
    },

    removeWorkspace: async (key) => {
      await window.agentSmith.removeWorkspace(key);
      await refresh();
    },

    addGroup: async (name) => {
      await window.agentSmith.addGroup(name);
      await refresh();
    },

    removeGroup: async (name) => {
      await window.agentSmith.removeGroup(name);
      await refresh();
    },

    moveWorkspace: async (key, toGroup, toIndex) => {
      await window.agentSmith.moveWorkspace(key, toGroup, toIndex);
      await refresh();
    },

    reorderGroup: async (name, toIndex) => {
      await window.agentSmith.reorderGroup(name, toIndex);
      await refresh();
    },
  };
});
