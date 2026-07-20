import { create } from 'zustand';
import {
  DashboardState, Placement, PanelInstance, PanelType, GRID,
  STORAGE_KEY, SINGLETON_TYPES, GLOBAL_CAPABLE_TYPES,
  defaultState, validateState, clampPlacement, maxZ, panelOrder,
  generatePanelId, findSpawnPlacement, computeMaxExpansion, findCloseExpandCandidate,
} from '../dashboard/layout';

interface LayoutStore {
  instances: PanelInstance[];
  locked: boolean;

  // Instance CRUD
  setPlacement: (id: string, placement: Placement) => void;
  bringToFront: (id: string) => void;

  // Sessions panel visibility toggle
  toggleSessionsVisible: () => void;

  // Layout lock
  setLocked: (locked: boolean) => void;

  // Spawning
  spawnPanel: (type: PanelType, sessionId: string) => string | null;
  spawnGlobalPanel: (type: PanelType, existingId?: string, name?: string) => string | null;

  // Closing
  destroyPanel: (id: string) => void;
  destroyLinkedPanels: (sessionId: string) => void;

  // Default panel management
  switchDefaultPanels: (sessionId: string) => void;

  // Panel renaming
  renamePanel: (id: string, name: string) => void;

  // Maximize / restore
  maximizePanel: (id: string) => void;

  // Helpers (non-reactive — read from getState())
  getInstance: (id: string) => PanelInstance | undefined;
  getDefaultPanel: (type: PanelType) => PanelInstance | undefined;
  getInstancesOfType: (type: PanelType) => PanelInstance[];
  findLinkedPanel: (type: PanelType, sessionId: string) => PanelInstance | undefined;
}

function loadState(): DashboardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = validateState(JSON.parse(raw));
      if (parsed) return normalizeZLevels(parsed);
    }
  } catch {
    /* corrupt — fall through to default */
  }
  return defaultState();
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

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistState(state: DashboardState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        instances: state.instances,
        locked: state.locked,
      }));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, 200);
}

const initial = loadState();

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  instances: initial.instances,
  locked: initial.locked,

  setPlacement: (id, placement) => {
    set((s) => {
      const instances = s.instances.map((inst) =>
        inst.id === id ? { ...inst, placement: clampPlacement(placement) } : inst
      );
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  bringToFront: (id) => {
    set((s) => {
      const inst = s.instances.find((i) => i.id === id);
      if (!inst || inst.placement.z === maxZ(s.instances)) return s;
      const instances = s.instances.map((i) =>
        i.id === id ? { ...i, placement: { ...i.placement, z: maxZ(s.instances) + 1 } } : i
      );
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  toggleSessionsVisible: () => {
    set((s) => {
      const instances = s.instances.map((inst) =>
        inst.type === 'sessions'
          ? { ...inst, placement: { ...inst.placement, visible: !inst.placement.visible } }
          : inst
      );
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  setLocked: (locked) => {
    set((s) => {
      const next = { instances: s.instances, locked };
      persistState(next);
      return next;
    });
  },

  spawnPanel: (type, sessionId) => {
    const s = get();

    // Singletons can't be spawned as multi-instance
    if (SINGLETON_TYPES.has(type)) return null;

    // If a linked panel for this session+type already exists, return null (focus-move).
    // Exception: jira panels allow multiple linked instances per session.
    if (type !== 'jira') {
      const existing = s.instances.find(
        (inst) => inst.type === type && inst.mode === 'linked' && inst.linkedSessionId === sessionId
      );
      if (existing) return null;
    }

    // Determine mode: default if no non-global panel of this type exists, otherwise linked
    const hasNonGlobalInstance = s.instances.some((inst) => inst.type === type && !inst.isGlobal);
    const mode = hasNonGlobalInstance ? 'linked' as const : 'default' as const;

    const { placement, splitInstanceId, splitPlacement } = findSpawnPlacement(s.instances, type);
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
      let instances = [...current.instances, newInstance];
      // If a split happened, update the source panel
      if (splitInstanceId && splitPlacement) {
        instances = instances.map((inst) =>
          inst.id === splitInstanceId
            ? { ...inst, placement: clampPlacement(splitPlacement) }
            : inst
        );
      }
      const next = { instances, locked: current.locked };
      persistState(next);
      return next;
    });

    return id;
  },

  spawnGlobalPanel: (type, existingId?, name?) => {
    if (!GLOBAL_CAPABLE_TYPES.has(type)) return null;
    const s = get();
    const { placement, splitInstanceId, splitPlacement } = findSpawnPlacement(s.instances, type);
    const id = existingId || generatePanelId(type);

    const newInstance: PanelInstance = {
      id,
      type,
      placement,
      mode: 'linked',
      isGlobal: true,
      name: name || 'Untitled',
    };

    set((current) => {
      let instances = [...current.instances, newInstance];
      if (splitInstanceId && splitPlacement) {
        instances = instances.map((inst) =>
          inst.id === splitInstanceId
            ? { ...inst, placement: clampPlacement(splitPlacement) }
            : inst
        );
      }
      const next = { instances, locked: current.locked };
      persistState(next);
      return next;
    });

    return id;
  },

  destroyPanel: (id) => {
    set((s) => {
      const inst = s.instances.find((i) => i.id === id);
      if (!inst) return s;

      // Sessions panel: toggle visibility instead of destroying
      if (inst.type === 'sessions') {
        const instances = s.instances.map((i) =>
          i.id === id ? { ...i, placement: { ...i.placement, visible: false } } : i
        );
        const next = { instances, locked: s.locked };
        persistState(next);
        return next;
      }

      const wasDefault = inst.mode === 'default';
      const type = inst.type;
      let instances = s.instances.filter((i) => i.id !== id);

      // Default promotion: if we removed the default, promote the first of same type
      if (wasDefault) {
        const ordered = panelOrder(instances).filter((i) => i.type === type);
        // If none visible, try any of same type
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
      const expandResult = findCloseExpandCandidate(s.instances, inst);
      if (expandResult) {
        instances = instances.map((i) =>
          i.id === expandResult.id
            ? { ...i, placement: clampPlacement(expandResult.placement) }
            : i
        );
      }

      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  destroyLinkedPanels: (sessionId) => {
    set((s) => {
      const instances = s.instances.filter(
        (inst) => !(inst.mode === 'linked' && inst.linkedSessionId === sessionId)
      );
      if (instances.length === s.instances.length) return s;
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  switchDefaultPanels: (sessionId) => {
    set((s) => {
      let changed = false;
      const instances = s.instances.map((inst) => {
        if (inst.mode !== 'default') return inst;
        // If sessionId is empty, clear the panel
        if (!sessionId) {
          if (inst.currentSessionId) {
            changed = true;
            return { ...inst, currentSessionId: undefined };
          }
          return inst;
        }
        // Skip if a linked panel of this type already exists for the session (A4/A9)
        const hasLinked = s.instances.some(
          (i) => i.type === inst.type && i.mode === 'linked' && i.linkedSessionId === sessionId
        );
        if (hasLinked) return inst;
        if (inst.currentSessionId === sessionId) return inst;
        changed = true;
        return { ...inst, currentSessionId: sessionId };
      });
      if (!changed) return s;
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  // --- Panel renaming ---

  renamePanel: (id, name) => {
    set((s) => {
      const instances = s.instances.map((inst) =>
        inst.id === id ? { ...inst, name } : inst
      );
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  // --- Maximize / restore ---

  maximizePanel: (id) => {
    set((s) => {
      const inst = s.instances.find((i) => i.id === id);
      if (!inst || !inst.placement.visible) return s;

      const p = inst.placement;
      const isFullGrid = p.w === GRID && p.h === GRID;

      if (isFullGrid && inst.preMaximizePlacement) {
        // Restore from maximize: check if original position is free
        const orig = inst.preMaximizePlacement;
        const othersGrid = Array.from({ length: GRID }, () => Array(GRID).fill(false));
        for (const other of s.instances) {
          if (!other.placement.visible || other.id === id) continue;
          const op = other.placement;
          for (let r = op.y; r < op.y + op.h && r < GRID; r++) {
            for (let c = op.x; c < op.x + op.w && c < GRID; c++) {
              othersGrid[r][c] = true;
            }
          }
        }
        // Check if original position is free
        let canRestore = true;
        for (let r = orig.y; r < orig.y + orig.h && canRestore; r++) {
          for (let c = orig.x; c < orig.x + orig.w && canRestore; c++) {
            if (othersGrid[r][c]) canRestore = false;
          }
        }
        const restoredPlacement = canRestore
          ? orig
          : clampPlacement({ ...orig, x: 0, y: 0, w: Math.max(orig.w, 2), h: Math.max(orig.h, 3) });

        // If can't restore to original, find spawn placement
        let finalPlacement = restoredPlacement;
        if (!canRestore) {
          const { placement: spawnP } = findSpawnPlacement(
            s.instances.filter((i) => i.id !== id),
            inst.type
          );
          finalPlacement = spawnP;
        }

        const instances = s.instances.map((i) =>
          i.id === id ? { ...i, placement: finalPlacement, preMaximizePlacement: undefined } : i
        );
        const next = { instances, locked: s.locked };
        persistState(next);
        return next;
      }

      // Try expanding into empty space first
      const expanded = computeMaxExpansion(s.instances, id);
      if (expanded) {
        const instances = s.instances.map((i) =>
          i.id === id ? { ...i, placement: expanded, preMaximizePlacement: undefined } : i
        );
        const next = { instances, locked: s.locked };
        persistState(next);
        return next;
      }

      // No empty space: maximize to full grid (overlay)
      const fullPlacement: Placement = {
        x: 0, y: 0, w: GRID, h: GRID,
        visible: true,
        z: maxZ(s.instances) + 1,
      };
      const instances = s.instances.map((i) =>
        i.id === id ? { ...i, placement: fullPlacement, preMaximizePlacement: p } : i
      );
      const next = { instances, locked: s.locked };
      persistState(next);
      return next;
    });
  },

  // --- Non-reactive helpers (use via getState()) ---

  getInstance: (id) => get().instances.find((i) => i.id === id),

  getDefaultPanel: (type) => get().instances.find((i) => i.type === type && i.mode === 'default'),

  getInstancesOfType: (type) => get().instances.filter((i) => i.type === type),

  findLinkedPanel: (type, sessionId) =>
    get().instances.find(
      (i) => i.type === type && i.mode === 'linked' && i.linkedSessionId === sessionId
    ),
}));
