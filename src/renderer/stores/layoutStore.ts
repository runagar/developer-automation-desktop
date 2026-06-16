import { create } from 'zustand';
import {
  DashboardLayout, DashboardPanelPlacement, DashboardState, PanelId,
  STORAGE_KEY, GRID, PRESETS,
  defaultState, validateState, clampPlacement, cloneLayout, maxZ,
} from '../dashboard/layout';

type DockTarget = 'left' | 'right' | 'top' | 'bottom' | 'center';

interface LayoutStore {
  layout: DashboardLayout;
  locked: boolean;
  preset: string;
  setPlacement: (id: PanelId, p: DashboardPanelPlacement) => void;
  bringToFront: (id: PanelId) => void;
  toggleVisible: (id: PanelId) => void;
  applyPreset: (name: string) => void;
  setLocked: (locked: boolean) => void;
  dock: (id: PanelId, target: DockTarget) => void;
}

function loadState(): DashboardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = validateState(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* corrupt — fall through to default */
  }
  return defaultState();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistState(state: DashboardState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        layout: state.layout,
        locked: state.locked,
        preset: state.preset,
      }));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, 200);
}

const initial = loadState();

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  layout: initial.layout,
  locked: initial.locked,
  preset: initial.preset,

  setPlacement: (id, placement) => {
    set((s) => {
      const next = {
        layout: { ...s.layout, [id]: clampPlacement(placement) },
        locked: s.locked,
        preset: 'custom',
      };
      persistState(next);
      return next;
    });
  },

  bringToFront: (id) => {
    set((s) => {
      if (s.layout[id].z === maxZ(s.layout)) return s;
      const next = {
        layout: { ...s.layout, [id]: { ...s.layout[id], z: maxZ(s.layout) + 1 } },
        locked: s.locked,
        preset: s.preset,
      };
      persistState(next);
      return next;
    });
  },

  toggleVisible: (id) => {
    set((s) => {
      const next = {
        layout: { ...s.layout, [id]: { ...s.layout[id], visible: !s.layout[id].visible } },
        locked: s.locked,
        preset: 'custom',
      };
      persistState(next);
      return next;
    });
  },

  applyPreset: (name) => {
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) return;
    set(() => {
      const next = { layout: cloneLayout(preset.layout), locked: get().locked, preset: name };
      persistState(next);
      return next;
    });
  },

  setLocked: (locked) => {
    set((s) => {
      const next = { layout: s.layout, locked, preset: s.preset };
      persistState(next);
      return next;
    });
  },

  dock: (id, target) => {
    set((s) => {
      const half = GRID / 2;
      const base = s.layout[id];
      let p: DashboardPanelPlacement;
      switch (target) {
        case 'left':   p = { ...base, x: 0, y: 0, w: half, h: GRID }; break;
        case 'right':  p = { ...base, x: half, y: 0, w: half, h: GRID }; break;
        case 'top':    p = { ...base, x: 0, y: 0, w: GRID, h: half }; break;
        case 'bottom': p = { ...base, x: 0, y: half, w: GRID, h: half }; break;
        case 'center': p = { ...base, x: GRID / 4, y: GRID / 4, w: half, h: half }; break;
        default:       p = base;
      }
      const next = {
        layout: { ...s.layout, [id]: clampPlacement(p) },
        locked: s.locked,
        preset: 'custom',
      };
      persistState(next);
      return next;
    });
  },
}));
