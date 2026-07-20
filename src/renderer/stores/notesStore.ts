import { create } from 'zustand';

export interface NotesTabState {
  id: string;
  name: string;
  isOpen: boolean;
  sortOrder: number;
}

interface ScopeState {
  tabs: NotesTabState[];
  activeTabId: string | null;
  /** Content keyed by tabId — used for mirroring across panels sharing a scope. */
  tabContents: Map<string, string>;
  /** Incremented on each content update — panels watch this to detect changes. */
  contentVersion: number;
}

interface NotesStore {
  scopes: Map<string, ScopeState>;

  loadTabs: (scopeKey: string) => Promise<void>;
  addTab: (scopeKey: string) => Promise<void>;
  closeTab: (scopeKey: string, tabId: string) => Promise<void>;
  restoreTab: (scopeKey: string, tabId: string) => Promise<void>;
  renameTab: (tabId: string, name: string) => Promise<void>;
  setActiveTab: (scopeKey: string, tabId: string) => void;
  updateContent: (scopeKey: string, tabId: string, content: string) => void;
}

function scopeFromKey(key: string): { kind: string; id: string } {
  const [kind, ...rest] = key.split(':');
  return { kind, id: rest.join(':') };
}

export const useNotesStore = create<NotesStore>((set, get) => ({
  scopes: new Map(),

  loadTabs: async (scopeKey) => {
    const scope = scopeFromKey(scopeKey);
    const tabs = await window.agentSmith.notesGetTabs(scope);
    const mapped: NotesTabState[] = tabs.map((t: any) => ({
      id: t.id,
      name: t.name || 'Untitled',
      isOpen: t.isOpen,
      sortOrder: t.sortOrder,
    }));

    set((s) => {
      const next = new Map(s.scopes);
      const existing = next.get(scopeKey);
      next.set(scopeKey, {
        tabs: mapped,
        activeTabId: existing?.activeTabId ?? mapped[0]?.id ?? null,
        tabContents: existing?.tabContents ?? new Map(),
        contentVersion: existing?.contentVersion ?? 0,
      });
      return { scopes: next };
    });

    // Auto-create first tab if none exist
    if (mapped.length === 0) {
      await get().addTab(scopeKey);
    }
  },

  addTab: async (scopeKey) => {
    const scope = scopeFromKey(scopeKey);
    const tab = await window.agentSmith.notesCreateTab(scope);
    const newTab: NotesTabState = {
      id: tab.id,
      name: tab.name || 'Untitled',
      isOpen: true,
      sortOrder: tab.sortOrder,
    };

    set((s) => {
      const next = new Map(s.scopes);
      const current = next.get(scopeKey) ?? { tabs: [], activeTabId: null, tabContents: new Map(), contentVersion: 0 };
      next.set(scopeKey, {
        ...current,
        tabs: [...current.tabs, newTab],
        activeTabId: newTab.id,
      });
      return { scopes: next };
    });
  },

  closeTab: async (scopeKey, tabId) => {
    await window.agentSmith.notesCloseTab(tabId);
    set((s) => {
      const next = new Map(s.scopes);
      const current = next.get(scopeKey);
      if (!current) return s;
      const tabs = current.tabs.filter((t) => t.id !== tabId);
      const activeTabId = current.activeTabId === tabId
        ? tabs[0]?.id ?? null
        : current.activeTabId;
      next.set(scopeKey, { ...current, tabs, activeTabId });
      return { scopes: next };
    });
  },

  restoreTab: async (scopeKey, tabId) => {
    const tab = await window.agentSmith.notesRestoreTab(tabId);
    if (!tab) return;
    const restored: NotesTabState = {
      id: tab.id,
      name: tab.name || 'Untitled',
      isOpen: true,
      sortOrder: tab.sortOrder,
    };
    set((s) => {
      const next = new Map(s.scopes);
      const current = next.get(scopeKey) ?? { tabs: [], activeTabId: null, tabContents: new Map(), contentVersion: 0 };
      next.set(scopeKey, {
        ...current,
        tabs: [...current.tabs, restored],
        activeTabId: restored.id,
      });
      return { scopes: next };
    });
  },

  renameTab: async (tabId, name) => {
    await window.agentSmith.notesRenameTab(tabId, name);
    set((s) => {
      const next = new Map(s.scopes);
      for (const [key, scope] of next) {
        const tab = scope.tabs.find((t) => t.id === tabId);
        if (tab) {
          next.set(key, {
            ...scope,
            tabs: scope.tabs.map((t) => t.id === tabId ? { ...t, name } : t),
          });
          break;
        }
      }
      return { scopes: next };
    });
  },

  setActiveTab: (scopeKey, tabId) => {
    set((s) => {
      const next = new Map(s.scopes);
      const current = next.get(scopeKey);
      if (!current) return s;
      next.set(scopeKey, { ...current, activeTabId: tabId });
      return { scopes: next };
    });
  },

  updateContent: (scopeKey, tabId, content) => {
    set((s) => {
      const next = new Map(s.scopes);
      const current = next.get(scopeKey);
      if (!current) return s;
      const tabContents = new Map(current.tabContents);
      tabContents.set(tabId, content);
      next.set(scopeKey, { ...current, tabContents, contentVersion: current.contentVersion + 1 });
      return { scopes: next };
    });
  },
}));
