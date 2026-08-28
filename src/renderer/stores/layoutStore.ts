import { create } from 'zustand';
import {
  DashboardState, Placement, PanelInstance, PanelType, GRID,
  ToolTabId, TOOL_TABS, DEFAULT_TAB, storageKeyForTab,
  SINGLETON_TYPES, GLOBAL_CAPABLE_TYPES, isTypeAllowed,
  defaultState, validateState, clampPlacement, maxZ, panelOrder,
  generatePanelId, findSpawnPlacement, computeMaxExpansion, findCloseExpandCandidate,
} from '../dashboard/layout';

/** A panel view together with the tab it lives in. */
export interface TabbedInstance {
  tabId: ToolTabId;
  instance: PanelInstance;
}

interface LayoutStore {
  // Active tab
  activeTab: ToolTabId;

  // Every tab's state, always present regardless of what is mounted
  tabs: Record<ToolTabId, DashboardState>;

  // Tab switching
  setActiveTab: (tabId: ToolTabId) => void;

  // Instance CRUD
  setPlacement: (id: string, placement: Placement) => void;
  bringToFront: (id: string) => void;

  // Singleton panel visibility toggle
  togglePanelVisible: (type: PanelType, tabId?: ToolTabId) => void;

  // Layout lock
  setLocked: (locked: boolean) => void;

  // Spawning
  spawnPanel: (type: PanelType, sessionId: string) => string | null;
  spawnGlobalPanel: (type: PanelType, contentId?: string, name?: string) => string | null;

  // Closing
  destroyPanel: (id: string) => void;
  destroyLinkedPanels: (sessionId: string) => void;
  destroyByContentId: (contentId: string) => void;

  // Default panel management
  switchDefaultPanels: (sessionId: string) => void;

  // Panel renaming
  renamePanel: (id: string, name: string) => void;

  // Maximize / restore
  maximizePanel: (id: string) => void;

  // Helpers (non-reactive — read from getState())
  getInstance: (id: string, tabId?: ToolTabId) => PanelInstance | undefined;
  getDefaultPanel: (type: PanelType, tabId?: ToolTabId) => PanelInstance | undefined;
  getInstancesOfType: (type: PanelType, tabId?: ToolTabId) => PanelInstance[];
  findLinkedPanel: (type: PanelType, sessionId: string, tabId?: ToolTabId) => PanelInstance | undefined;
  findInstancesByContentId: (contentId: string) => TabbedInstance[];
}

// ---------------------------------------------------------------------------
// Per-tab persistence
// ---------------------------------------------------------------------------

const TAB_STORAGE_KEY = 'dad-active-tab';

function loadTabState(tabId: ToolTabId): DashboardState {
  try {
    const raw = localStorage.getItem(storageKeyForTab(tabId));
    if (raw) {
      const parsed = validateState(JSON.parse(raw), tabId);
      if (parsed) return normalizeZLevels(parsed);
    }
  } catch {
    /* corrupt — fall through to default */
  }
  return defaultState(tabId);
}

function loadActiveTab(): ToolTabId {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved && TOOL_TABS.some((t) => t.id === saved)) return saved as ToolTabId;
  } catch { /* ignore */ }
  return DEFAULT_TAB;
}

/** Compact z-levels to 1..N retaining relative order. */
function normalizeZLevels(state: DashboardState): DashboardState {
  const sorted = [...state.instances].sort((a, b) => a.placement.z - b.placement.z);
  const zMap = new Map<string, number>();
  sorted.forEach((inst, i) => zMap.set(inst.id, i + 1));
  return {
    ...state,
    instances: state.instances.map((inst) => ({
      ...inst,
      placement: { ...inst.placement, z: zMap.get(inst.id) ?? 1 },
    })),
  };
}

const persistTimers = new Map<ToolTabId, ReturnType<typeof setTimeout>>();

function persistTabState(tabId: ToolTabId, state: DashboardState): void {
  const existing = persistTimers.get(tabId);
  if (existing) clearTimeout(existing);
  persistTimers.set(tabId, setTimeout(() => {
    try {
      localStorage.setItem(storageKeyForTab(tabId), JSON.stringify({
        instances: state.instances,
        locked: state.locked,
      }));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, 200));
}

// Initialize every tab's state up front. This is independent of mounting: the
// store always knows about every tab, even ones the user has never opened.
const initialTabs = TOOL_TABS.reduce((acc, tab) => {
  acc[tab.id] = loadTabState(tab.id);
  return acc;
}, {} as Record<ToolTabId, DashboardState>);

type LayoutState = { activeTab: ToolTabId; tabs: Record<ToolTabId, DashboardState> };

/**
 * The only way an action may mutate layout state. Writes the patch into the
 * given tab (defaulting to the active one) and schedules persistence for it.
 */
function updateTab(
  s: LayoutState,
  patch: { instances?: PanelInstance[]; locked?: boolean },
  tabId: ToolTabId = s.activeTab,
): { tabs: Record<ToolTabId, DashboardState> } {
  const current = s.tabs[tabId];
  const next: DashboardState = {
    instances: patch.instances ?? current.instances,
    locked: patch.locked ?? current.locked,
  };
  persistTabState(tabId, next);
  return { tabs: { ...s.tabs, [tabId]: next } };
}

/** Apply a transform to every tab, persisting only the tabs that actually changed. */
function updateAllTabs(
  s: LayoutState,
  transform: (instances: PanelInstance[]) => PanelInstance[],
): { tabs: Record<ToolTabId, DashboardState> } | null {
  const tabs = { ...s.tabs };
  let changed = false;
  for (const tab of TOOL_TABS) {
    const current = s.tabs[tab.id];
    const instances = transform(current.instances);
    if (instances === current.instances) continue;
    changed = true;
    const next: DashboardState = { instances, locked: current.locked };
    tabs[tab.id] = next;
    persistTabState(tab.id, next);
  }
  return changed ? { tabs } : null;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const useTabInstances = (tabId: ToolTabId): PanelInstance[] =>
  useLayoutStore((s) => s.tabs[tabId].instances);

export const useTabLocked = (tabId: ToolTabId): boolean =>
  useLayoutStore((s) => s.tabs[tabId].locked);

export const useActiveInstances = (): PanelInstance[] =>
  useLayoutStore((s) => s.tabs[s.activeTab].instances);

export const useActiveLocked = (): boolean =>
  useLayoutStore((s) => s.tabs[s.activeTab].locked);

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  activeTab: loadActiveTab(),
  tabs: initialTabs,

  setActiveTab: (tabId) => {
    const s = get();
    if (tabId === s.activeTab) return;
    try { localStorage.setItem(TAB_STORAGE_KEY, tabId); } catch { /* ok */ }
    set({ activeTab: tabId });
  },

  setPlacement: (id, placement) => {
    set((s) => {
      const instances = s.tabs[s.activeTab].instances.map((inst) =>
        inst.id === id ? { ...inst, placement: clampPlacement(placement) } : inst
      );
      return updateTab(s, { instances });
    });
  },

  bringToFront: (id) => {
    set((s) => {
      // A panel can be brought to front from a menu while another tab is active,
      // so locate it across all tabs rather than assuming the active one.
      const tabId = TOOL_TABS.find((t) => s.tabs[t.id].instances.some((i) => i.id === id))?.id;
      if (!tabId) return s;
      const current = s.tabs[tabId].instances;
      const inst = current.find((i) => i.id === id);
      if (!inst || inst.placement.z === maxZ(current)) return s;
      const instances = current.map((i) =>
        i.id === id ? { ...i, placement: { ...i.placement, z: maxZ(current) + 1 } } : i
      );
      return updateTab(s, { instances }, tabId);
    });
  },

  togglePanelVisible: (type, tabId) => {
    set((s) => {
      const target = tabId ?? s.activeTab;
      const instances = s.tabs[target].instances.map((inst) =>
        inst.type === type
          ? { ...inst, placement: { ...inst.placement, visible: !inst.placement.visible } }
          : inst
      );
      return updateTab(s, { instances }, target);
    });
  },

  setLocked: (locked) => {
    set((s) => updateTab(s, { locked }));
  },

  spawnPanel: (type, sessionId) => {
    const s = get();
    const tabId = s.activeTab;

    // Singletons can't be spawned as multi-instance
    if (SINGLETON_TYPES.has(type)) return null;

    // The tab decides which panel types it may contain.
    if (!isTypeAllowed(tabId, type)) return null;

    const currentInstances = s.tabs[tabId].instances;

    // If a linked panel for this session+type already exists, return null (focus-move).
    // Exception: jira panels allow multiple linked instances per session.
    if (type !== 'jira') {
      const existing = currentInstances.find(
        (inst) => inst.type === type && inst.mode === 'linked' && inst.linkedSessionId === sessionId
      );
      if (existing) return null;
    }

    // Determine mode: default if no non-global panel of this type exists, otherwise linked
    const hasNonGlobalInstance = currentInstances.some((inst) => inst.type === type && !inst.isGlobal);
    const mode = hasNonGlobalInstance ? 'linked' as const : 'default' as const;

    const { placement, splitInstanceId, splitPlacement } = findSpawnPlacement(currentInstances, type);
    const id = generatePanelId(type);

    const newInstance: PanelInstance = {
      id,
      type,
      placement,
      mode,
      linkedSessionId: mode === 'linked' ? sessionId : undefined,
      currentSessionId: sessionId,
    };

    set((current) => {
      let instances = [...current.tabs[tabId].instances, newInstance];
      // If a split happened, update the source panel
      if (splitInstanceId && splitPlacement) {
        instances = instances.map((inst) =>
          inst.id === splitInstanceId
            ? { ...inst, placement: clampPlacement(splitPlacement) }
            : inst
        );
      }
      return updateTab(current, { instances }, tabId);
    });

    return id;
  },

  spawnGlobalPanel: (type, contentId?, name?) => {
    if (!GLOBAL_CAPABLE_TYPES.has(type)) return null;
    const s = get();
    const tabId = s.activeTab;
    if (!isTypeAllowed(tabId, type)) return null;

    const currentInstances = s.tabs[tabId].instances;
    const { placement, splitInstanceId, splitPlacement } = findSpawnPlacement(currentInstances, type);
    // The view id is always fresh so the same content can be open in several
    // tabs at once; contentId is what ties those views to one domain object.
    const id = generatePanelId(type);

    const newInstance: PanelInstance = {
      id,
      contentId: contentId || id,
      type,
      placement,
      mode: 'linked',
      isGlobal: true,
      name: name || 'Untitled',
    };

    set((current) => {
      let instances = [...current.tabs[tabId].instances, newInstance];
      if (splitInstanceId && splitPlacement) {
        instances = instances.map((inst) =>
          inst.id === splitInstanceId
            ? { ...inst, placement: clampPlacement(splitPlacement) }
            : inst
        );
      }
      return updateTab(current, { instances }, tabId);
    });

    return id;
  },

  destroyPanel: (id) => {
    set((s) => {
      const tabId = TOOL_TABS.find((t) => s.tabs[t.id].instances.some((i) => i.id === id))?.id;
      if (!tabId) return s;
      const currentInstances = s.tabs[tabId].instances;
      const inst = currentInstances.find((i) => i.id === id);
      if (!inst) return s;

      // Singletons: toggle visibility instead of destroying
      if (SINGLETON_TYPES.has(inst.type)) {
        const instances = currentInstances.map((i) =>
          i.id === id ? { ...i, placement: { ...i.placement, visible: false } } : i
        );
        return updateTab(s, { instances }, tabId);
      }

      const wasDefault = inst.mode === 'default';
      const type = inst.type;
      let instances = currentInstances.filter((i) => i.id !== id);

      // Default promotion: if we removed the default, promote the first of same type
      if (wasDefault) {
        const ordered = panelOrder(instances).filter((i) => i.type === type);
        const candidates = ordered.length > 0
          ? ordered
          : instances.filter((i) => i.type === type);
        if (candidates.length > 0) {
          const promoteId = candidates[0].id;
          instances = instances.map((i) =>
            i.id === promoteId
              ? { ...i, mode: 'default' as const, linkedSessionId: undefined }
              : i
          );
        }
      }

      // Close-expand: if a same-type neighbour can grow into the freed space, expand it
      const expandResult = findCloseExpandCandidate(currentInstances, inst);
      if (expandResult) {
        instances = instances.map((i) =>
          i.id === expandResult.id
            ? { ...i, placement: clampPlacement(expandResult.placement) }
            : i
        );
      }

      return updateTab(s, { instances }, tabId);
    });
  },

  destroyLinkedPanels: (sessionId) => {
    set((s) => {
      const result = updateAllTabs(s, (instances) => {
        const next = instances.filter(
          (inst) => !(inst.mode === 'linked' && inst.linkedSessionId === sessionId)
        );
        return next.length === instances.length ? instances : next;
      });
      return result ?? s;
    });
  },

  destroyByContentId: (contentId) => {
    set((s) => {
      const result = updateAllTabs(s, (instances) => {
        const next = instances.filter((inst) => inst.contentId !== contentId);
        return next.length === instances.length ? instances : next;
      });
      return result ?? s;
    });
  },

  switchDefaultPanels: (sessionId) => {
    set((s) => {
      const result = updateAllTabs(s, (instances) => {
        let changed = false;
        const next = instances.map((inst) => {
          if (inst.mode !== 'default') return inst;
          if (!sessionId) {
            if (inst.currentSessionId) {
              changed = true;
              return { ...inst, currentSessionId: undefined };
            }
            return inst;
          }
          const hasLinked = instances.some(
            (i) => i.type === inst.type && i.mode === 'linked' && i.linkedSessionId === sessionId
          );
          if (hasLinked) return inst;
          if (inst.currentSessionId === sessionId) return inst;
          changed = true;
          return { ...inst, currentSessionId: sessionId };
        });
        return changed ? next : instances;
      });
      return result ?? s;
    });
  },

  // --- Panel renaming ---

  renamePanel: (id, name) => {
    set((s) => {
      let contentId: string | undefined;
      for (const tab of TOOL_TABS) {
        const found = s.tabs[tab.id].instances.find((i) => i.id === id);
        if (found) { contentId = found.contentId; break; }
      }

      // Fan out to every view of the same content object. Guard on contentId being
      // defined — otherwise `undefined === undefined` would rename every panel that
      // has no content object at all.
      const matches = (inst: PanelInstance): boolean =>
        contentId ? inst.contentId === contentId : inst.id === id;

      const result = updateAllTabs(s, (instances) => {
        if (!instances.some((inst) => matches(inst) && inst.name !== name)) return instances;
        return instances.map((inst) => (matches(inst) ? { ...inst, name } : inst));
      });
      return result ?? s;
    });
  },

  // --- Maximize / restore ---

  maximizePanel: (id) => {
    set((s) => {
      const tabId = s.activeTab;
      const currentInstances = s.tabs[tabId].instances;
      const inst = currentInstances.find((i) => i.id === id);
      if (!inst || !inst.placement.visible) return s;

      const p = inst.placement;
      const isFullGrid = p.w === GRID && p.h === GRID;

      if (isFullGrid && inst.preMaximizePlacement) {
        // Restore from maximize: check if original position is free
        const orig = inst.preMaximizePlacement;
        const othersGrid = Array.from({ length: GRID }, () => Array(GRID).fill(false));
        for (const other of currentInstances) {
          if (!other.placement.visible || other.id === id) continue;
          const op = other.placement;
          for (let r = op.y; r < op.y + op.h && r < GRID; r++) {
            for (let c = op.x; c < op.x + op.w && c < GRID; c++) {
              othersGrid[r][c] = true;
            }
          }
        }
        let canRestore = true;
        for (let r = orig.y; r < orig.y + orig.h && canRestore; r++) {
          for (let c = orig.x; c < orig.x + orig.w && canRestore; c++) {
            if (othersGrid[r][c]) canRestore = false;
          }
        }
        const restoredPlacement = canRestore
          ? orig
          : clampPlacement({ ...orig, x: 0, y: 0, w: Math.max(orig.w, 2), h: Math.max(orig.h, 3) });

        let finalPlacement = restoredPlacement;
        if (!canRestore) {
          const { placement: spawnP } = findSpawnPlacement(
            currentInstances.filter((i) => i.id !== id),
            inst.type
          );
          finalPlacement = spawnP;
        }

        const instances = currentInstances.map((i) =>
          i.id === id ? { ...i, placement: finalPlacement, preMaximizePlacement: undefined } : i
        );
        return updateTab(s, { instances }, tabId);
      }

      // Try expanding into empty space first
      const expanded = computeMaxExpansion(currentInstances, id);
      if (expanded) {
        const instances = currentInstances.map((i) =>
          i.id === id ? { ...i, placement: expanded, preMaximizePlacement: undefined } : i
        );
        return updateTab(s, { instances }, tabId);
      }

      // No empty space: maximize to full grid (overlay)
      const fullPlacement: Placement = {
        x: 0, y: 0, w: GRID, h: GRID,
        visible: true,
        z: maxZ(currentInstances) + 1,
      };
      const instances = currentInstances.map((i) =>
        i.id === id ? { ...i, placement: fullPlacement, preMaximizePlacement: p } : i
      );
      return updateTab(s, { instances }, tabId);
    });
  },

  // --- Non-reactive helpers (use via getState()) ---

  getInstance: (id, tabId) => {
    const s = get();
    if (tabId) return s.tabs[tabId].instances.find((i) => i.id === id);
    for (const tab of TOOL_TABS) {
      const found = s.tabs[tab.id].instances.find((i) => i.id === id);
      if (found) return found;
    }
    return undefined;
  },

  getDefaultPanel: (type, tabId) => {
    const s = get();
    return s.tabs[tabId ?? s.activeTab].instances.find((i) => i.type === type && i.mode === 'default');
  },

  getInstancesOfType: (type, tabId) => {
    const s = get();
    return s.tabs[tabId ?? s.activeTab].instances.filter((i) => i.type === type);
  },

  findLinkedPanel: (type, sessionId, tabId) => {
    const s = get();
    return s.tabs[tabId ?? s.activeTab].instances.find(
      (i) => i.type === type && i.mode === 'linked' && i.linkedSessionId === sessionId
    );
  },

  findInstancesByContentId: (contentId) => {
    const s = get();
    const out: TabbedInstance[] = [];
    for (const tab of TOOL_TABS) {
      for (const instance of s.tabs[tab.id].instances) {
        if (instance.contentId === contentId) out.push({ tabId: tab.id, instance });
      }
    }
    return out;
  },
}));
