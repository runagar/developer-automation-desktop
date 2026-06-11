import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DashboardState, DashboardLayout, PanelId, DashboardPanelPlacement,
  STORAGE_KEY, defaultState, validateState, clampPlacement, cloneLayout,
  maxZ, PRESETS, GRID,
} from './layout';

type DockTarget = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface DashboardController {
  layout: DashboardLayout;
  locked: boolean;
  preset: string;
  setPlacement: (id: PanelId, placement: DashboardPanelPlacement) => void;
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

export function useDashboardLayout(): DashboardController {
  const [state, setState] = useState<DashboardState>(loadState);

  // Persist on every change.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [state]);

  const setPlacement = useCallback((id: PanelId, placement: DashboardPanelPlacement) => {
    setState((prev) => ({
      ...prev,
      preset: 'custom',
      layout: { ...prev.layout, [id]: clampPlacement(placement) },
    }));
  }, []);

  const bringToFront = useCallback((id: PanelId) => {
    setState((prev) => {
      if (prev.layout[id].z === maxZ(prev.layout)) return prev;
      return {
        ...prev,
        layout: { ...prev.layout, [id]: { ...prev.layout[id], z: maxZ(prev.layout) + 1 } },
      };
    });
  }, []);

  const toggleVisible = useCallback((id: PanelId) => {
    setState((prev) => ({
      ...prev,
      preset: 'custom',
      layout: {
        ...prev.layout,
        [id]: { ...prev.layout[id], visible: !prev.layout[id].visible },
      },
    }));
  }, []);

  const applyPreset = useCallback((name: string) => {
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) return;
    setState((prev) => ({ ...prev, preset: name, layout: cloneLayout(preset.layout) }));
  }, []);

  const setLocked = useCallback((locked: boolean) => {
    setState((prev) => ({ ...prev, locked }));
  }, []);

  const dock = useCallback((id: PanelId, target: DockTarget) => {
    setState((prev) => {
      const half = GRID / 2;
      let next: DashboardPanelPlacement;
      const base = prev.layout[id];
      switch (target) {
        case 'left':   next = { ...base, x: 0, y: 0, w: half, h: GRID }; break;
        case 'right':  next = { ...base, x: half, y: 0, w: half, h: GRID }; break;
        case 'top':    next = { ...base, x: 0, y: 0, w: GRID, h: half }; break;
        case 'bottom': next = { ...base, x: 0, y: half, w: GRID, h: half }; break;
        case 'center': next = { ...base, x: GRID / 4, y: GRID / 4, w: half, h: half }; break;
        default:       next = base;
      }
      return {
        ...prev,
        preset: 'custom',
        layout: { ...prev.layout, [id]: clampPlacement(next) },
      };
    });
  }, []);

  return {
    layout: state.layout,
    locked: state.locked,
    preset: state.preset,
    setPlacement,
    bringToFront,
    toggleVisible,
    applyPreset,
    setLocked,
    dock,
  };
}
