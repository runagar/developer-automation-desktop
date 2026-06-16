import { create } from 'zustand';
import { ProjectGroup } from '../../main/types';

interface ProjectStore {
  groups: ProjectGroup[];

  loadGroups: () => Promise<void>;
  addProject: (key: string, repo: string, group: string) => Promise<void>;
  removeProject: (key: string) => Promise<void>;
  addGroup: (name: string) => Promise<void>;
  removeGroup: (name: string) => Promise<void>;
  moveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  reorderGroup: (name: string, toIndex: number) => Promise<void>;
}

export const useProjectStore = create<ProjectStore>((set) => {
  const refresh = async () => {
    const groups = await window.agentSmith.getProjectGroups();
    set({ groups });
  };

  return {
    groups: [],

    loadGroups: refresh,

    addProject: async (key, repo, group) => {
      await window.agentSmith.addProject({ key, repo, group });
      await refresh();
    },

    removeProject: async (key) => {
      await window.agentSmith.removeProject(key);
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
